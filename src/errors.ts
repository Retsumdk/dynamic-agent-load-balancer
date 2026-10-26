/** Error taxonomy shared by the balancer, runner, and CLI. */

export const EXIT_CODES = {
  OK: 0,
  USAGE: 2,
  PLAN_ERROR: 3,
  RUNTIME_ERROR: 4,
} as const;

export type BalancerErrorCode =
  | "DALB_INVALID_AGENT"
  | "DALB_UNKNOWN_AGENT"
  | "DALB_AGENT_BUSY"
  | "DALB_INVALID_TASK"
  | "DALB_UNKNOWN_TASK"
  | "DALB_TASK_NOT_RUNNING"
  | "DALB_TASK_TIMEOUT"
  | "DALB_NO_CANDIDATE"
  | "DALB_INVALID_OPTIONS";

export class BalancerError extends Error {
  readonly code: BalancerErrorCode;

  constructor(code: BalancerErrorCode, message: string) {
    super(message);
    this.name = "BalancerError";
    this.code = code;
  }
}

export function invalidAgent(message: string): BalancerError {
  return new BalancerError("DALB_INVALID_AGENT", message);
}

export function unknownAgent(agentId: string): BalancerError {
  return new BalancerError("DALB_UNKNOWN_AGENT", `unknown agent "${agentId}"`);
}

export function invalidTask(message: string): BalancerError {
  return new BalancerError("DALB_INVALID_TASK", message);
}

export function unknownTask(taskId: string): BalancerError {
  return new BalancerError("DALB_UNKNOWN_TASK", `unknown task "${taskId}"`);
}

export function taskNotRunning(taskId: string, status: string): BalancerError {
  return new BalancerError(
    "DALB_TASK_NOT_RUNNING",
    `task "${taskId}" is ${status}, not running`,
  );
}

export function taskTimeout(taskId: string, agentId: string, timeoutMs: number): BalancerError {
  return new BalancerError(
    "DALB_TASK_TIMEOUT",
    `task "${taskId}" exceeded ${timeoutMs}ms on agent "${agentId}"`,
  );
}

export function noCandidate(taskId: string): BalancerError {
  return new BalancerError("DALB_NO_CANDIDATE", `no candidate agent for task "${taskId}"`);
}

export function invalidOptions(message: string): BalancerError {
  return new BalancerError("DALB_INVALID_OPTIONS", message);
}
