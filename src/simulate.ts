/**
 * Discrete-event simulator over the FleetBalancer state machine.
 *
 * Tasks declare a deterministic duration (durationMs) and optional scripted
 * failures (failOnAgents / failTimes). The simulator advances a manual clock
 * to the next settle event, so a given fleet+task file always produces the
 * byte-identical run — which is exactly what the demo and the `dalb run` /
 * `dalb score` CLI commands need.
 */

import { FleetBalancer } from "./balancer.js";
import { BalancerError, invalidAgent, invalidTask } from "./errors.js";
import { ManualClock } from "./clock.js";
import type { TaskRecord, TaskSpec } from "./types.js";

export interface SimAgent {
  id: string;
  capabilities: string[];
  maxConcurrency: number;
}

export interface SimTask {
  id: string;
  requiredCapabilities?: string[];
  priority?: number;
  /** Simulated execution time in ms (default 100). */
  durationMs?: number;
  /** Agents on which this task deterministically fails. */
  failOnAgents?: string[];
  /** How many attempts on failOnAgents agents fail before succeeding (default: all). */
  failTimes?: number;
}

export interface SimConfig {
  weights?: { capacity?: number; specialization?: number; performance?: number };
  allowSkipAhead?: boolean;
  maxAttempts?: number;
  agents: SimAgent[];
  tasks: SimTask[];
}

export interface SimEvent {
  t: number;
  kind: "submit" | "assign" | "complete" | "fail" | "requeue" | "terminal-fail" | "exhaust";
  taskId?: string;
  agentId?: string;
  detail?: string;
}

export interface SimResult {
  events: SimEvent[];
  /** The balancer after the run, for stats(), snapshot(), and listTasks(). */
  balancer: FleetBalancer;
  completed: TaskRecord[];
  failed: TaskRecord[];
  wallMs: number;
}

interface RunningEntry {
  taskId: string;
  agentId: string;
  settledAt: number;
}

function normalizeTask(raw: SimTask, index: number): TaskSpec {
  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  if (!id) throw invalidTask(`tasks[${index}].id is empty`);
  return {
    id,
    requiredCapabilities: (raw.requiredCapabilities ?? []).map((c) => c.trim().toLowerCase()).filter(Boolean),
    priority: raw.priority ?? 0,
  };
}

export function parseSimConfig(input: unknown): SimConfig {
  if (typeof input !== "object" || input === null) {
    throw new BalancerError("DALB_INVALID_TASK", "config must be a JSON object");
  }
  const raw = input as Record<string, unknown>;
  const agents = raw.agents;
  const tasks = raw.tasks;
  if (!Array.isArray(agents) || agents.length === 0) {
    throw new BalancerError("DALB_INVALID_AGENT", "config.agents must be a non-empty array");
  }
  if (!Array.isArray(tasks)) {
    throw new BalancerError("DALB_INVALID_TASK", "config.tasks must be an array");
  }
  const cfg: SimConfig = { agents: [], tasks: [] };
  for (const a of agents as unknown[]) {
    const rec = (a ?? {}) as Record<string, unknown>;
    const id = typeof rec.id === "string" ? rec.id.trim() : "";
    if (!id) throw new BalancerError("DALB_INVALID_AGENT", `agent entry missing id: ${JSON.stringify(a)}`);
    const caps = Array.isArray(rec.capabilities)
      ? (rec.capabilities as unknown[]).map((c) => String(c).trim().toLowerCase()).filter(Boolean)
      : [];
    const maxConc = typeof rec.maxConcurrency === "number" ? Math.trunc(rec.maxConcurrency) : 1;
    if (!Number.isInteger(maxConc) || maxConc < 1) {
      throw invalidAgent(`agent "${id}" maxConcurrency must be an integer >= 1`);
    }
    cfg.agents.push({ id, capabilities: [...new Set(caps)], maxConcurrency: maxConc });
  }
  const taskIds = new Set<string>();
  for (let i = 0; i < (tasks as unknown[]).length; i++) {
    const rec = ((tasks as unknown[])[i] ?? {}) as Record<string, unknown>;
    const taskId = typeof rec.id === "string" ? rec.id.trim() : "";
    if (!taskId) throw invalidTask(`tasks[${i}].id must be a non-empty string`);
    if (taskIds.has(taskId)) throw invalidTask(`duplicate task id "${taskId}"`);
    taskIds.add(taskId);
    cfg.tasks.push({
      id: taskId,
      requiredCapabilities: Array.isArray(rec.requiredCapabilities)
        ? (rec.requiredCapabilities as unknown[]).map(String)
        : [],
      priority: typeof rec.priority === "number" ? rec.priority : 0,
      durationMs: typeof rec.durationMs === "number" ? rec.durationMs : 100,
      failOnAgents: Array.isArray(rec.failOnAgents) ? (rec.failOnAgents as unknown[]).map(String) : undefined,
      failTimes: typeof rec.failTimes === "number" ? rec.failTimes : undefined,
    });
  }
  if (raw.weights && typeof raw.weights === "object") {
    const w = raw.weights as Record<string, unknown>;
    cfg.weights = {
      capacity: typeof w.capacity === "number" ? w.capacity : undefined,
      specialization: typeof w.specialization === "number" ? w.specialization : undefined,
      performance: typeof w.performance === "number" ? w.performance : undefined,
    };
  }
  if (typeof raw.allowSkipAhead === "boolean") cfg.allowSkipAhead = raw.allowSkipAhead;
  if (typeof raw.maxAttempts === "number") cfg.maxAttempts = raw.maxAttempts;
  return cfg;
}

/**
 * Execute the simulation to completion. Assumes the fleet can make progress:
 * tasks that can never run (no capable, non-excluded agent) fail fast via the
 * balancer's own reaping. A task whose only capable agents keep failing
 * exhausts its attempt budget and lands in `failed`.
 */
export function simulate(config: SimConfig): SimResult {
  const clock = new ManualClock();
  const balancer = new FleetBalancer({
    clock,
    allowSkipAhead: config.allowSkipAhead ?? true,
    maxAttempts: config.maxAttempts ?? 2,
    weights: config.weights,
  });

  const duration = new Map<string, number>();
  const failPlan = new Map<string, { agents: string[]; remaining: number }>();
  for (const agent of config.agents) {
    balancer.registerAgent(agent);
  }

  const events: SimEvent[] = [];
  const running: RunningEntry[] = [];

  for (let i = 0; i < config.tasks.length; i++) {
    const raw = config.tasks[i];
    const spec = normalizeTask(raw, i);
    duration.set(spec.id, raw.durationMs ?? 100);
    failPlan.set(spec.id, {
      agents: (raw.failOnAgents ?? []).map((a) => a.trim().toLowerCase()),
      remaining: raw.failTimes ?? Number.POSITIVE_INFINITY,
    });
    balancer.submit(spec);
    events.push({ t: clock.now(), kind: "submit", taskId: spec.id });
  }

  balancer.dispatchAll().forEach((a) => {
    events.push({ t: clock.now(), kind: "assign", taskId: a.taskId, agentId: a.agentId });
    running.push({
      taskId: a.taskId,
      agentId: a.agentId,
      settledAt: clock.now() + (duration.get(a.taskId) ?? 100),
    });
  });

  while (running.length > 0) {
    running.sort((x, y) => x.settledAt - y.settledAt || x.taskId.localeCompare(y.taskId));
    const next = running.shift() as RunningEntry;
    clock.advanceTo(next.settledAt);

    const plan = failPlan.get(next.taskId);
    const shouldFail = plan !== undefined && plan.agents.includes(next.agentId) && plan.remaining > 0;
    if (shouldFail && plan) plan.remaining -= 1;

    if (shouldFail) {
      balancer.fail(next.taskId, `simulated failure on ${next.agentId}`);
      const record = balancer.task(next.taskId);
      if (record.status === "queued") {
        events.push({ t: clock.now(), kind: "requeue", taskId: next.taskId, agentId: next.agentId });
      } else {
        events.push({
          t: clock.now(),
          kind: "exhaust",
          taskId: next.taskId,
          agentId: next.agentId,
          detail: `${record.attempts} attempt(s)`,
        });
      }
    } else {
      balancer.complete(next.taskId);
      events.push({ t: clock.now(), kind: "complete", taskId: next.taskId, agentId: next.agentId });
    }

    balancer.dispatchAll().forEach((a) => {
      events.push({ t: clock.now(), kind: "assign", taskId: a.taskId, agentId: a.agentId });
      running.push({
        taskId: a.taskId,
        agentId: a.agentId,
        settledAt: clock.now() + (duration.get(a.taskId) ?? 100),
      });
    });
  }

  return {
    events,
    balancer,
    completed: balancer.listTasks("completed"),
    failed: balancer.listTasks("failed"),
    wallMs: clock.now(),
  };
}
