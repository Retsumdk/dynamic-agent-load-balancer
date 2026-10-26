/**
 * dynamic-agent-load-balancer
 *
 * Places tasks across a fleet of heterogeneous agents by scoring capacity,
 * specialization, and performance. Zero runtime dependencies; deterministic
 * under an injected clock.
 *
 * Built by Retsumdk.
 */

export type {
  AgentRegistration,
  AgentStat,
  Assignment,
  BalancerOptions,
  Clock,
  ScoreBreakdown,
  ScoringWeights,
  FleetSnapshot,
  TaskFailureReason,
  TaskRecord,
  TaskSpec,
  TaskStatus,
} from "./types.js";

export { BalancerError, EXIT_CODES } from "./errors.js";
export type { BalancerErrorCode } from "./errors.js";

export { ManualClock, SystemClock } from "./clock.js";

export { FleetBalancer, EWMA_ALPHA } from "./balancer.js";

export { DEFAULT_WEIGHTS } from "./scoring.js";
export {
  laplaceSuccessRate,
  median,
  performanceScore,
  specializationScore,
  validateWeights,
} from "./scoring.js";

export { FleetRunner, runTask } from "./runner.js";
export type { RunFailure, RunResult, RunSuccess, RunnerOptions, TaskHandler } from "./runner.js";

export {
  parseSimConfig,
  simulate,
  type SimAgent,
  type SimConfig,
  type SimEvent,
  type SimResult,
  type SimTask,
} from "./simulate.js";

export { renderAgentStats, renderEvents, renderFailedTasks, renderFleet, renderScoreTable, renderSnapshot } from "./report.js";

export { runDemo } from "./demo.js";

export { runCli } from "./cli.js";
export { VERSION } from "./version.js";
