/** CLI entry. Exports runCli(argv) for tests; cli-run.ts is the bin shim. */

import { readFileSync } from "node:fs";
import { runDemo } from "./demo.js";
import { BalancerError, EXIT_CODES } from "./errors.js";
import {
  renderAgentStats,
  renderEvents,
  renderFailedTasks,
  renderScoreTable,
  renderSnapshot,
} from "./report.js";
import { FleetBalancer } from "./balancer.js";
import { parseSimConfig, simulate, type SimConfig, type SimTask } from "./simulate.js";
import { VERSION } from "./version.js";
import type { TaskSpec } from "./types.js";

function fail(message: string, code: number): number {
  process.stderr.write(`dalb: ${message}\n`);
  return code;
}

function usage(): string {
  return [
    "dalb - dynamic agent load balancer",
    "",
    "Usage:",
    "  dalb demo              Run the built-in deterministic fleet demo",
    "  dalb run <plan.json>   Simulate a fleet/task plan from a JSON file",
    "  dalb score <plan.json> Show scored candidate agents for every task",
    "  dalb version           Print the package version",
    "",
    "Plan file shape:",
    '  { "agents": [{ "id": "a1", "capabilities": ["transform"], "maxConcurrency": 2 }],',
    '    "tasks":  [{ "id": "t1", "requiredCapabilities": ["transform"],',
    '                 "priority": 1, "durationMs": 120,',
    '                 "failOnAgents": ["a1"], "failTimes": 1 }],',
    '    "maxAttempts": 2, "allowSkipAhead": true,',
    '    "weights": { "capacity": 0.4, "specialization": 0.35, "performance": 0.25 } }',
    "",
    "Exit codes: 0 ok, 2 usage, 3 plan/file error, 4 runtime error.",
  ].join("\n");
}

function taskHeading(task: SimTask): string {
  const caps = (task.requiredCapabilities ?? []).join(",") || "(any)";
  const pri = task.priority === undefined ? "" : ` priority=${task.priority}`;
  return `${task.id} [${caps}]${pri}`;
}

function scoreCommand(path: string): number {
  let plan: SimConfig;
  try {
    plan = JSON.parse(readFileSync(path, "utf-8")) as SimConfig;
  } catch (error) {
    return fail(
      `cannot read plan: ${error instanceof Error ? error.message : String(error)}`,
      EXIT_CODES.PLAN_ERROR,
    );
  }
  try {
    const balancer = new FleetBalancer({ weights: plan.weights });
    for (const agent of plan.agents) {
      balancer.registerAgent(agent);
    }
    for (const task of plan.tasks) {
      const spec: TaskSpec = {
        id: task.id,
        requiredCapabilities: task.requiredCapabilities ?? [],
        priority: task.priority ?? 0,
      };
      process.stdout.write(`${taskHeading(task)}\n`);
      process.stdout.write(renderScoreTable(balancer.scoreCandidates(spec)) + "\n\n");
    }
    return 0;
  } catch (error) {
    if (error instanceof BalancerError) {
      return fail(error.message, EXIT_CODES.PLAN_ERROR);
    }
    return fail(
      `scoring failed: ${error instanceof Error ? error.message : String(error)}`,
      EXIT_CODES.RUNTIME_ERROR,
    );
  }
}

function runCommand(path: string): number {
  let plan: SimConfig;
  try {
    plan = JSON.parse(readFileSync(path, "utf-8")) as SimConfig;
  } catch (error) {
    return fail(
      `cannot read plan: ${error instanceof Error ? error.message : String(error)}`,
      EXIT_CODES.PLAN_ERROR,
    );
  }
  try {
    const result = simulate(parseSimConfig(plan));
    process.stdout.write(renderEvents(result.events) + "\n\n");
    process.stdout.write(renderAgentStats(result.balancer.stats()) + "\n\n");
    process.stdout.write(renderSnapshot(result.balancer.snapshot()) + "\n\n");
    const failed = result.balancer.listTasks("failed");
    if (failed.length > 0) {
      process.stdout.write("Failed tasks:\n" + renderFailedTasks(failed) + "\n\n");
    }
    const stuck = result.balancer.queuedTasks().length;
    if (stuck > 0) {
      return fail(
        `${stuck} task(s) never dispatched (strict head-of-line blocking)`,
        EXIT_CODES.RUNTIME_ERROR,
      );
    }
    return 0;
  } catch (error) {
    if (error instanceof BalancerError) {
      return fail(error.message, EXIT_CODES.PLAN_ERROR);
    }
    return fail(
      `simulation failed: ${error instanceof Error ? error.message : String(error)}`,
      EXIT_CODES.RUNTIME_ERROR,
    );
  }
}

export async function runCli(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case undefined:
    case "-h":
    case "--help":
    case "help": {
      process.stdout.write(usage() + "\n");
      return command === undefined ? 2 : 0;
    }
    case "version":
    case "--version":
    case "-v": {
      process.stdout.write(`dalb ${VERSION}\n`);
      return 0;
    }
    case "demo": {
      process.stdout.write(runDemo());
      return 0;
    }
    case "run": {
      const path = rest[0];
      if (!path) return fail("run needs a plan file path", EXIT_CODES.USAGE);
      return runCommand(path);
    }
    case "score": {
      const path = rest[0];
      if (!path) return fail("score needs a plan file path", EXIT_CODES.USAGE);
      return scoreCommand(path);
    }
    default:
      return fail(`unknown command "${String(command)}"`, EXIT_CODES.USAGE);
  }
}
