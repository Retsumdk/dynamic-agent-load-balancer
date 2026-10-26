/**
 * FleetBalancer: the placement state machine.
 *
 * Owns the agent roster, the priority queue, and per-task attempt state.
 * The caller drives the loop: submit() queues work, dispatch()/dispatchAll()
 * place work, complete()/fail() settle running attempts (fail requeues with a
 * per-task agent exclusion until the attempt budget is spent).
 *
 * No timers, no I/O: timestamps come from the injected Clock, which makes
 * every placement decision reproducible under a ManualClock.
 */

import {
  invalidAgent,
  invalidOptions,
  invalidTask,
  taskNotRunning,
  unknownAgent,
  unknownTask,
} from "./errors.js";
import {
  DEFAULT_WEIGHTS,
  median,
  scoreCandidate,
  validateWeights,
} from "./scoring.js";
import type {
  AgentRegistration,
  AgentStat,
  Assignment,
  BalancerOptions,
  Clock,
  FleetSnapshot,
  ScoringWeights,
  ScoreBreakdown,
  TaskFailureReason,
  TaskRecord,
  TaskSpec,
} from "./types.js";
import { SystemClock } from "./clock.js";import { hasCaps, normalizeCaps } from "./caps.js";

interface InternalAgent {
  reg: AgentRegistration;
  inFlight: number;
  attempts: number;
  completions: number;
  failures: number;
  ewmaMs: number | null;
  registeredAt: number;
  lastActiveAt: number | null;
}

interface InternalTask {
  id: string;
  status: TaskRecord["status"];
  priority: number;
  required: string[];
  attempts: number;
  assignedAgent: string | null;
  startedAt: number | null;
  excluded: Set<string>;
  failureReason?: TaskFailureReason;
  lastError?: string;
  attemptAgents: string[];
  completedAt?: number;
  failedAt?: number;
  seq: number;
}

export const EWMA_ALPHA = 0.3;

export class FleetBalancer {
  readonly weights: ScoringWeights;
  readonly allowSkipAhead: boolean;
  readonly maxAttempts: number;
  private readonly clock: Clock;

  private readonly agents = new Map<string, InternalAgent>();
  private readonly tasks = new Map<string, InternalTask>();
  private queue: InternalTask[] = [];
  private nextSeq = 0;
  private completedCount = 0;
  private failedCount = 0;

  constructor(options: BalancerOptions = {}) {
    const merged: ScoringWeights = { ...DEFAULT_WEIGHTS, ...options.weights };
    try {
      validateWeights(merged);
    } catch (error) {
      throw invalidOptions(error instanceof Error ? error.message : String(error));
    }
    this.weights = merged;
    this.allowSkipAhead = options.allowSkipAhead ?? true;
    this.maxAttempts = validateAttemptBudget(options.maxAttempts ?? 2);
    this.clock = options.clock ?? new SystemClock();
  }

  get clock$(): Clock {
    return this.clock;
  }

  // ---- fleet management -------------------------------------------------

  registerAgent(reg: AgentRegistration): void {
    assertAgentSpec(reg);
    if (this.agents.has(reg.id)) {
      throw invalidAgent(`agent "${reg.id}" is already registered`);
    }
    this.agents.set(reg.id, {
      reg: {
        id: reg.id,
        capabilities: normalizeCaps(reg.capabilities),
        maxConcurrency: reg.maxConcurrency,
        label: reg.label,
      },
      inFlight: 0,
      attempts: 0,
      completions: 0,
      failures: 0,
      ewmaMs: null,
      registeredAt: this.clock.now(),
      lastActiveAt: null,
    });
    this.reapHopeless();
  }

  unregisterAgent(agentId: string): void {
    const agent = this.lookupAgent(agentId);
    if (agent.inFlight > 0) {
      throw invalidAgent(`agent "${agentId}" still has ${agent.inFlight} task(s) in flight`);
    }
    this.agents.delete(agentId);
    this.reapHopeless();
  }

  setCapacity(agentId: string, maxConcurrency: number): void {
    this.lookupAgent(agentId);
    if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1) {
      throw invalidAgent("maxConcurrency must be an integer >= 1");
    }
    this.agents.get(agentId)!.reg.maxConcurrency = maxConcurrency;
    this.reapHopeless();
  }

  hasAgent(agentId: string): boolean {
    return this.agents.has(agentId);
  }

  // ---- submission -------------------------------------------------------

  submit(spec: TaskSpec): TaskRecord {
    assertTaskSpec(spec);
    if (this.tasks.has(spec.id)) {
      throw invalidTask(`task id "${spec.id}" was already used`);
    }
    const task: InternalTask = {
      id: spec.id,
      status: "queued",
      priority: spec.priority ?? 0,
      required: normalizeCaps(spec.requiredCapabilities),
      attempts: 0,
      assignedAgent: null,
      startedAt: null,
      excluded: new Set(),
      attemptAgents: [],
      seq: this.nextSeq++,
    };
    this.tasks.set(task.id, task);
    this.insertQueued(task);
    this.reapHopeless();
    return this.taskRecord(task);
  }

  // ---- dispatch ---------------------------------------------------------

  /**
   * Place exactly one queued task. Returns null when nothing more can run
   * (no eligible agent with headroom, or strict priority blocking).
   */
  dispatch(): Assignment | null {
    for (const task of [...this.queue]) {
      const candidates = this.candidatesFor(task, true);
      if (candidates.length === 0) {
        // An empty fleet means "not staffed yet", not "impossible": the task
        // waits until agents register. With a roster present, no capable
        // agent is permanent — fail the task instead of blocking the queue.
        if (this.agents.size > 0 && this.capableAgents(task).length === 0) {
          this.settleAsFailed(task, "no-candidates", "no agent has the required capabilities");
          continue;
        }
        if (!this.allowSkipAhead) break;
        continue;
      }
      const best = this.pickBest(candidates, task);
      return this.assign(task, best);
    }
    return null;
  }

  /** Place repeatedly until the queue can no longer advance. */
  dispatchAll(): Assignment[] {
    const placed: Assignment[] = [];
    for (;;) {
      const assignment = this.dispatch();
      if (assignment === null) break;
      placed.push(assignment);
    }
    return placed;
  }

  /**
   * Scored, sorted candidates for a task (or a live queued task by id).
   * This is the explainability surface: every component and the weighted
   * total, including ineligible agents at total 0.
   */
  scoreCandidates(spec: TaskSpec | string): ScoreBreakdown[] {
    const task =
      typeof spec === "string" ? this.tasks.get(spec) : {
        id: spec.id,
        required: normalizeCaps(spec.requiredCapabilities),
        excluded: new Set<string>(),
      };
    if (!task) throw unknownTask(typeof spec === "string" ? spec : spec.id);
    const requiredCount = task.required.length;
    const fleetMedianMs = this.fleetMedianLatency();
    const rows: ScoreBreakdown[] = [];
    for (const agent of this.agents.values()) {
      const stat = this.statOf(agent);
      const eligible =
        hasCaps(agent.reg.capabilities, task.required) && !task.excluded.has(agent.reg.id) &&
        agent.inFlight < agent.reg.maxConcurrency;
      rows.push(scoreCandidate({ stat, requiredCount, eligible, weights: this.weights, fleetMedianMs }));
    }
    rows.sort((a, b) => b.total - a.total || a.agentId.localeCompare(b.agentId));
    return rows;
  }

  // ---- settlement -------------------------------------------------------

  complete(taskId: string): TaskRecord {
    const task = this.lookupTask(taskId);
    if (task.status !== "running") {
      throw taskNotRunning(taskId, task.status);
    }
    this.settleSuccess(task);
    return this.taskRecord(task);
  }

  /**
   * Fail the running attempt. The agent is excluded for this task; the task
   * requeues until `maxAttempts` started attempts are reached, then settles
   * as failed with reason "exhausted".
   */
  fail(taskId: string, error?: string): TaskRecord {
    const task = this.lookupTask(taskId);
    if (task.status !== "running") {
      throw taskNotRunning(taskId, task.status);
    }
    this.settleFailure(task, error);
    return this.taskRecord(task);
  }

  // ---- inspection -------------------------------------------------------

  task(taskId: string): TaskRecord {
    return this.taskRecord(this.lookupTask(taskId));
  }

  queuedTasks(): string[] {
    return this.queue.map((t) => t.id);
  }
  /** Every task record, optionally filtered by status, in submission order. */
  listTasks(status?: TaskRecord["status"]): TaskRecord[] {
    const selected = [...this.tasks.values()]
      .filter((task) => (status ? task.status === status : true))
      .sort((a, b) => a.seq - b.seq);
    return selected.map((task) => this.taskRecord(task));
  }

  stats(): AgentStat[] {
    return [...this.agents.values()]
      .map((agent) => this.statOf(agent))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  snapshot(): FleetSnapshot {
    let running = 0;
    let completed = 0;
    let failed = 0;
    let inFlight = 0;
    let capacitySlots = 0;
    for (const task of this.tasks.values()) {
      if (task.status === "running") running += 1;
      else if (task.status === "completed") completed += 1;
      else if (task.status === "failed") failed += 1;
    }
    for (const agent of this.agents.values()) {
      inFlight += agent.inFlight;
      capacitySlots += agent.reg.maxConcurrency;
    }
    return {
      agents: this.agents.size,
      inFlight,
      capacitySlots,
      queued: this.queue.length,
      running,
      completed,
      failed,
      utilization: capacitySlots === 0 ? 0 : round3(inFlight / capacitySlots),
    };
  }

  // ---- internals --------------------------------------------------------

  private assign(task: InternalTask, agentId: string): Assignment {
    const agent = this.agents.get(agentId)!;
    task.status = "running";
    task.assignedAgent = agentId;
    task.attempts += 1;
    task.attemptAgents.push(agentId);
    const startedAt = this.clock.now();
    task.startedAt = startedAt;
    agent.inFlight += 1;
    agent.attempts += 1;
    agent.lastActiveAt = startedAt;
    this.queue = this.queue.filter((t) => t !== task);
    return { taskId: task.id, agentId, startedAt, attempt: task.attempts };
  }

  private settleSuccess(task: InternalTask): void {
    const agent = this.agents.get(task.assignedAgent!);
    if (agent) {
      agent.inFlight -= 1;
      agent.completions += 1;
      agent.ewmaMs = this.nextEwma(agent, task);
      agent.lastActiveAt = this.clock.now();
    }
    task.status = "completed";
    task.completedAt = this.clock.now();
    task.assignedAgent = null;
    task.startedAt = null;
    this.completedCount += 1;
  }

  private settleFailure(task: InternalTask, error?: string): void {
    const agentId = task.assignedAgent!;
    const agent = this.agents.get(agentId);
    if (agent) {
      agent.inFlight -= 1;
      agent.failures += 1;
      agent.ewmaMs = this.nextEwma(agent, task);
      agent.lastActiveAt = this.clock.now();
    }
    task.assignedAgent = null;
    task.startedAt = null;
    task.lastError = error ?? "unspecified failure";
    if (task.attempts >= this.maxAttempts) {
      this.settleAsFailed(task, "exhausted", task.lastError);
      return;
    }
    task.excluded.add(agentId);
    task.status = "queued";
    this.insertQueued(task);
    this.reapHopeless();
  }

  /** Move queued tasks with no remaining capable, non-excluded agent to failed. */
  private reapHopeless(): void {
    if (this.agents.size === 0) return; // fleet not staffed yet — keep tasks queued
    for (const task of [...this.queue]) {
      if (this.capableAgents(task).length === 0) {
        this.settleAsFailed(task, "no-candidates", "no agent has the required capabilities");
      }
    }
  }

  private settleAsFailed(task: InternalTask, reason: TaskFailureReason, message: string): void {
    this.queue = this.queue.filter((t) => t !== task);
    task.status = "failed";
    task.failureReason = reason;
    task.lastError = message;
    task.failedAt = this.clock.now();
    task.assignedAgent = null;
    task.startedAt = null;
    this.failedCount += 1;
  }

  /** Agents with every required capability that this task is not excluded from. */
  private capableAgents(task: InternalTask): InternalAgent[] {
    return [...this.agents.values()].filter(
      (agent) => hasCaps(agent.reg.capabilities, task.required) && !task.excluded.has(agent.reg.id),
    );
  }

  /** Capable, non-excluded agents with concurrency headroom right now. */
  private candidatesFor(task: InternalTask, withHeadroom: boolean): InternalAgent[] {
    return this.capableAgents(task).filter((agent) =>
      withHeadroom ? agent.inFlight < agent.reg.maxConcurrency : true,
    );
  }

  private pickBest(candidates: InternalAgent[], task: InternalTask): string {
    const fleetMedianMs = this.fleetMedianLatency();
    let bestId = "";
    let bestScore = -Infinity;
    for (const agent of candidates) {
      const breakdown = scoreCandidate({
        stat: this.statOf(agent),
        requiredCount: task.required.length,
        eligible: true,
        weights: this.weights,
        fleetMedianMs,
      });
      if (breakdown.total > bestScore || (breakdown.total === bestScore && agent.reg.id < bestId)) {
        bestScore = breakdown.total;
        bestId = agent.reg.id;
      }
    }
    return bestId;
  }

  private nextEwma(agent: InternalAgent, task: InternalTask): number {
    const elapsed = Math.max(0, this.clock.now() - (task.startedAt ?? this.clock.now()));
    return agent.ewmaMs === null ? elapsed : EWMA_ALPHA * elapsed + (1 - EWMA_ALPHA) * agent.ewmaMs;
  }

  private fleetMedianLatency(): number | null {
    const values: number[] = [];
    for (const agent of this.agents.values()) {
      if (agent.ewmaMs !== null) values.push(agent.ewmaMs);
    }
    return median(values);
  }

  private insertQueued(task: InternalTask): void {
    this.queue.push(task);
    this.queue.sort((a, b) => b.priority - a.priority || a.seq - b.seq);
  }

  private statOf(agent: InternalAgent): AgentStat {
    return {
      id: agent.reg.id,
      capabilities: agent.reg.capabilities,
      maxConcurrency: agent.reg.maxConcurrency,
      inFlight: agent.inFlight,
      attempts: agent.attempts,
      completions: agent.completions,
      failures: agent.failures,
      successRate: round3((agent.completions + 1) / (agent.attempts + 2)),
      ewmaLatencyMs: agent.ewmaMs === null ? null : round3(agent.ewmaMs),
      registeredAt: agent.registeredAt,
      lastActiveAt: agent.lastActiveAt,
    };
  }

  private taskRecord(task: InternalTask): TaskRecord {
    const record: TaskRecord = {
      id: task.id,
      status: task.status,
      priority: task.priority,
      requiredCapabilities: [...task.required],
      attempts: task.attempts,
      excludedAgents: [...task.excluded].sort(),
      attemptAgents: [...task.attemptAgents],
    };
    if (task.assignedAgent !== null) record.assignedAgent = task.assignedAgent;
    if (task.completedAt !== undefined) record.completedAt = task.completedAt;
    if (task.failedAt !== undefined) record.failedAt = task.failedAt;
    if (task.failureReason !== undefined) record.failureReason = task.failureReason;
    if (task.lastError !== undefined) record.lastError = task.lastError;
    return record;
  }

  private lookupAgent(agentId: string): InternalAgent {
    const agent = this.agents.get(agentId);
    if (!agent) throw unknownAgent(agentId);
    return agent;
  }

  private lookupTask(taskId: string): InternalTask {
    const task = this.tasks.get(taskId);
    if (!task) throw unknownTask(taskId);
    return task;
  }
}

function validateAttemptBudget(maxAttempts: number): number {
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw invalidOptions("maxAttempts must be an integer >= 1");
  }
  return maxAttempts;
}


function assertAgentSpec(reg: AgentRegistration): void {
  if (typeof reg.id !== "string" || reg.id.trim().length === 0) {
    throw invalidAgent("agent id must be a non-empty string");
  }
  if (!Number.isInteger(reg.maxConcurrency) || reg.maxConcurrency < 1) {
    throw invalidAgent("maxConcurrency must be an integer >= 1");
  }
}

function assertTaskSpec(spec: TaskSpec): void {
  if (typeof spec.id !== "string" || spec.id.trim().length === 0) {
    throw invalidTask("task id must be a non-empty string");
  }
  if (spec.priority !== undefined && !Number.isInteger(spec.priority)) {
    throw invalidTask("priority must be an integer");
  }
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
