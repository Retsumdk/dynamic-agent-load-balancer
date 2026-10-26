/** Domain types for the fleet balancer. All timestamps are clock-relative. */

export interface AgentRegistration {
  /** Unique agent identifier. */
  id: string;
  /** Capability tags. An agent can run a task only if it has every required tag. */
  capabilities: string[];
  /** Maximum concurrently running tasks. Must be >= 1. */
  maxConcurrency: number;
  /** Free-form label for reports; defaults to the id. */
  label?: string;
}

export interface TaskSpec {
  /** Unique task identifier (never reusable, even after completion or failure). */
  id: string;
  /** Capability tags every assigned agent must have. Empty array = no requirement. */
  requiredCapabilities: string[];
  /** Higher runs first among queued tasks of equal age. Default 0. */
  priority?: number;
}

export type TaskStatus = "queued" | "running" | "completed" | "failed";

export type TaskFailureReason =
  /** No registered agent has the required capabilities. */
  | "no-candidates"
  /** Every capable agent was excluded through failures up to the attempt budget. */
  | "exhausted";

export interface Assignment {
  taskId: string;
  agentId: string;
  /** Clock time the attempt started. */
  startedAt: number;
  /** 1-based attempt number for this task. */
  attempt: number;
}

export interface TaskRecord {
  id: string;
  status: TaskStatus;
  priority: number;
  requiredCapabilities: string[];
  /** Attempts started so far (each attempt is one dispatch to one agent). */
  attempts: number;
  /** Agent currently holding the task, if running. */
  assignedAgent?: string;
  /** Agents this task may no longer be placed on. */
  excludedAgents: string[];
  completedAt?: number;
  failedAt?: number;
  failureReason?: TaskFailureReason;
  lastError?: string;
  /** Ids of agents that have run this task, in attempt order. */
  attemptAgents: string[];
}

export interface ScoringWeights {
  /** Preference for agents with more free concurrency slots. Default 0.4. */
  capacity: number;
  /** Preference for exact-specialist agents over generalists. Default 0.35. */
  specialization: number;
  /** Preference for agents with better smoothed success rate and latency. Default 0.25. */
  performance: number;
}

export interface ScoreBreakdown {
  agentId: string;
  /** 0..1 headroom: 1 - inFlight/maxConcurrency. */
  capacity: number;
  /** 0..1 specificity: required caps / agent caps. */
  specialization: number;
  /** 0..1 blend of smoothed success rate and relative speed. */
  performance: number;
  /** Weighted total in [0,1]; deterministic ordering key. */
  total: number;
}

export interface AgentStat {
  id: string;
  capabilities: string[];
  maxConcurrency: number;
  inFlight: number;
  attempts: number;
  completions: number;
  failures: number;
  /** Laplace-smoothed success rate: (completions + 1) / (attempts + 2). */
  successRate: number;
  /** EWMA of attempt latency in ms; null until the first settle. */
  ewmaLatencyMs: number | null;
  registeredAt: number;
  lastActiveAt: number | null;
}

export interface FleetSnapshot {
  /** Registered agent count. */
  agents: number;
  /** Tasks currently running across the fleet. */
  inFlight: number;
  /** Sum of every agent's maxConcurrency. */
  capacitySlots: number;
  queued: number;
  running: number;
  completed: number;
  failed: number;
  /** inFlight / capacitySlots; 0 when the fleet has no agents. */
  utilization: number;
}

export interface BalancerOptions {
  weights?: Partial<ScoringWeights>;
  /**
   * true (default): if the highest-priority queued task has no available
   * candidate, later tasks may still be placed. false: strict priority —
   * nothing dispatches while the head task waits (may idle the fleet).
   */
  allowSkipAhead?: boolean;
  /** Max started attempts per task before it fails as "exhausted". Default 2. */
  maxAttempts?: number;
  /** Clock for timestamps, latency measurement, and runner timeouts. */
  clock?: Clock;
}

/** Minimal time port so balancer and runner are deterministic under test. */
export interface Clock {
  /** Current time in ms. */
  now(): number;
  /** Schedule a callback; returns a handle usable with clearTimeout. */
  setTimeout(callback: () => void, ms: number): number;
  clearTimeout(handle: number): void;
}
