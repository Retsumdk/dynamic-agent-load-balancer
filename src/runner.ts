/**
 * FleetRunner: executes task handlers against balancer placements.
 *
 * The balancer decides WHERE work runs; the runner owns the execution loop:
 * dispatch, run the handler (with an optional clock-based timeout), settle the
 * task, and retry on another agent when the attempt budget allows. Handlers
 * are not cancelled on timeout — their eventual result is discarded.
 */

import { BalancerError, taskTimeout } from "./errors.js";
import type { AgentRegistration, TaskSpec } from "./types.js";
import type { FleetBalancer } from "./balancer.js";

export type TaskHandler<T> = (spec: TaskSpec, agent: AgentRegistration) => Promise<T> | T;

export interface RunSuccess<T> {
  ok: true;
  taskId: string;
  agentId: string;
  attempt: number;
  value: T;
}

export interface RunFailure {
  ok: false;
  taskId: string;
  attempts: Array<{ agentId: string; error: string }>;
  error: BalancerError;
}

export type RunResult<T> = RunSuccess<T> | RunFailure;

export interface RunnerOptions {
  /** Max time per attempt in ms; omit to run unbounded. */
  timeoutMs?: number;
}

class TimeoutSignal extends Error {}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

export class FleetRunner {
  private readonly balancer: FleetBalancer;
  private readonly handler: TaskHandler<unknown>;
  private readonly timeoutMs?: number;
  private readonly pending = new Map<string, Deferred<RunResult<unknown>>>();

  constructor(balancer: FleetBalancer, handler: TaskHandler<unknown>, options: RunnerOptions = {}) {
    this.balancer = balancer;
    this.handler = handler;
    this.timeoutMs = options.timeoutMs;
  }

  /** Submit one task and resolve when it settles (success or terminal failure). */
  runOne<T>(spec: TaskSpec): Promise<RunResult<T>> {
    const deferred = createDeferred<RunResult<T>>();
    this.pending.set(spec.id, deferred as Deferred<RunResult<unknown>>);
    this.balancer.submit(spec);
    this.pump();
    this.settlePendingTerminals();
    return deferred.promise;
  }

  /**
   * Submit every task at once and resolve when all settle. Failed tasks
   * surface as `{ ok: false }` entries; the whole batch never rejects.
   */
  async runAll<T>(specs: TaskSpec[]): Promise<RunResult<T>[]> {
    const deferreds: Array<Deferred<RunResult<T>>> = [];
    for (const spec of specs) {
      const deferred = createDeferred<RunResult<T>>();
      this.pending.set(spec.id, deferred as Deferred<RunResult<unknown>>);
      deferreds.push(deferred);
      this.balancer.submit(spec);
    }
    this.pump();
    this.settlePendingTerminals();
    return Promise.all(deferreds.map((d) => d.promise));
  }

  private async execute(spec: TaskSpec, agent: AgentRegistration): Promise<void> {
    let timedOut = false;
    try {
      const result = this.timeoutMs === undefined
        ? await Promise.resolve(this.handler(spec, agent))
        : await this.raceWithTimeout(spec, agent);
      this.balancer.complete(spec.id);
      this.settleOk(spec.id, result, agent.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      timedOut = error instanceof TimeoutSignal;
      this.balancer.fail(spec.id, message);
      this.settleIfTerminal(spec.id, message, timedOut);
    }
  }

  private raceWithTimeout(spec: TaskSpec, agent: AgentRegistration): Promise<unknown> {
    const clock = this.balancer.clock$;
    const handlerPromise = Promise.resolve(this.handler(spec, agent));
    handlerPromise.catch(() => {}); // late rejection after a lost race must not crash the process
    let timerHandle: number | null = null;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timerHandle = clock.setTimeout(() => {
        reject(new TimeoutSignal(taskTimeout(spec.id, agent.id, this.timeoutMs ?? 0).message));
      }, this.timeoutMs ?? 0);
    });
    return Promise.race([handlerPromise, timeoutPromise]).finally(() => {
      if (timerHandle !== null) clock.clearTimeout(timerHandle);
    });
  }

  private settleOk(taskId: string, value: unknown, agentId: string): void {
    const deferred = this.pending.get(taskId);
    if (!deferred) return;
    this.pending.delete(taskId);
    deferred.resolve({
      ok: true,
      taskId,
      agentId,
      attempt: this.balancer.task(taskId).attempts,
      value,
    } as RunResult<unknown>);
  }

  private settleIfTerminal(taskId: string, lastError: string, timedOut: boolean): void {
    const deferred = this.pending.get(taskId);
    if (!deferred) return;
    const record = this.balancer.task(taskId);
    if (record.status !== "failed") return; // requeued for another attempt
    this.pending.delete(taskId);
    const attempts = record.attemptAgents.map((agentId) => ({ agentId, error: record.lastError ?? lastError }));
    const error =
      record.attempts === 0
        ? new BalancerError("DALB_NO_CANDIDATE", record.lastError ?? lastError)
        : new BalancerError(
            "DALB_NO_CANDIDATE",
            `task "${taskId}" failed after ${record.attempts} attempt(s) on [${record.attemptAgents.join(", ")}]` +
              `${timedOut ? " (timeout)" : ""}: ${record.lastError ?? lastError}`,
          );
    deferred.resolve({ ok: false, taskId, attempts, error } as RunResult<unknown>);
  }

  /** Dispatch everything placeable and launch handlers for runner-owned tasks. */

  /** Resolve deferreds for tasks the balancer failed before dispatch (reaping). */
  private settlePendingTerminals(): void {
    for (const taskId of [...this.pending.keys()]) {
      const record = this.balancer.task(taskId);
      if (record.status === "failed") {
        this.settleIfTerminal(taskId, record.lastError ?? "failed before dispatch", false);
      }
    }
  }


  private pump(): void {
    for (const assignment of this.balancer.dispatchAll()) {
      if (!this.pending.has(assignment.taskId)) continue;
      const record = this.balancer.task(assignment.taskId);
      const spec: TaskSpec = {
        id: record.id,
        requiredCapabilities: record.requiredCapabilities,
        priority: record.priority,
      };
      const agent = this.requireAgent(assignment.agentId);
      const attempt = this.execute(spec, agent);
      void attempt.then(
        () => this.pump(),
        () => this.pump(),
      );
    }
  }

  private requireAgent(agentId: string): AgentRegistration {
    const stat = this.balancer.stats().find((s) => s.id === agentId);
    if (!stat) throw new BalancerError("DALB_UNKNOWN_AGENT", `unknown agent "${agentId}"`);
    return { id: stat.id, capabilities: stat.capabilities, maxConcurrency: stat.maxConcurrency };
  }
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** Convenience: run a single task on a fresh runner and unwrap the result. */
export async function runTask<T>(
  balancer: FleetBalancer,
  spec: TaskSpec,
  handler: TaskHandler<T>,
  options: RunnerOptions = {},
): Promise<T> {
  const runner = new FleetRunner(balancer, handler as TaskHandler<unknown>, options);
  const result = await runner.runOne<T>(spec);
  if (!result.ok) throw result.error;
  return result.value;
}
