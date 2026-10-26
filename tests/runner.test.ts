import { describe, expect, test } from "bun:test";
import { FleetBalancer } from "../src/balancer.js";
import { ManualClock } from "../src/clock.js";
import { FleetRunner, runTask } from "../src/runner.js";
import type { RunFailure, RunSuccess } from "../src/runner.js";
import type { TaskSpec } from "../src/types.js";

function spec(id: string, required: string[] = []): TaskSpec {
  return { id, requiredCapabilities: required };
}

function fleet(): { balancer: FleetBalancer; clock: ManualClock } {
  const clock = new ManualClock();
  const balancer = new FleetBalancer({ clock, maxAttempts: 2 });
  balancer.registerAgent({ id: "a", capabilities: ["t"], maxConcurrency: 1 });
  balancer.registerAgent({ id: "b", capabilities: ["t"], maxConcurrency: 1 });
  return { balancer, clock };
}

describe("FleetRunner.runOne", () => {
  test("executes the handler on the selected agent and reports placement", async () => {
    const { balancer } = fleet();
    const runner = new FleetRunner(balancer, (task, agent) => `ran on ${agent.id}: ${task.id}`);
    const result = await runner.runOne<string>(spec("t1", ["t"]));
    expect(result.ok).toBe(true);
    const success = result as RunSuccess<string>;
    expect(success.agentId).toBe("a");
    expect(success.value).toBe("ran on a: t1");
    expect(success.attempt).toBe(1);
  });

  test("migrates to another agent after a failure and succeeds", async () => {
    const { balancer } = fleet();
    const attemptedOn: string[] = [];
    const runner = new FleetRunner(balancer, (task, agent) => {
      attemptedOn.push(agent.id);
      if (agent.id === "a") throw new Error("transient failure");
      return `ok:${task.id}`;
    });
    const result = await runner.runOne<string>(spec("t1", ["t"]));
    expect(attemptedOn).toEqual(["a", "b"]);
    expect(result.ok).toBe(true);
    const success = result as RunSuccess<string>;
    expect(success.agentId).toBe("b");
    expect(success.attempt).toBe(2);
  });

  test("surfaces a structured failure when the attempt budget is spent", async () => {
    const { balancer } = fleet();
    const runner = new FleetRunner(
      balancer,
      (task, agent) => {
        void task;
        void agent;
        throw new Error("always broken");
      },
      { timeoutMs: 1_000 },
    );
    const result = await runner.runOne(spec("t1", ["t"]));
    expect(result.ok).toBe(false);
    const failure = result as RunFailure;
    expect(failure.attempts.map((attempt) => attempt.agentId)).toEqual(["a", "b"]);
    expect(failure.error.message).toContain("2 attempt(s)");
    expect(balancer.task("t1").status).toBe("failed");
  });

  test("times out a hung handler and retries on the other agent", async () => {
    const balancer = new FleetBalancer({ maxAttempts: 2 }); // SystemClock: real timers
    balancer.registerAgent({ id: "a", capabilities: ["t"], maxConcurrency: 1 });
    balancer.registerAgent({ id: "b", capabilities: ["t"], maxConcurrency: 1 });
    const slowOn = new Set<string>(["a"]);
    const runner = new FleetRunner(
      balancer,
      async (task, agent) => {
        void task;
        if (slowOn.has(agent.id)) {
          await new Promise(() => {}); // never resolves
        }
        return "fast";
      },
      { timeoutMs: 10 },
    );
    const result = await runner.runOne<string>(spec("t1", ["t"]));
    expect(result.ok).toBe(true);
    const success = result as RunSuccess<string>;
    expect(success.agentId).toBe("b");
    expect(success.attempt).toBe(2);
  });

  test("a task nobody can run settles as failed without dispatching", async () => {
    const { balancer } = fleet();
    const runner = new FleetRunner(balancer, () => "unused");
    const result = await runner.runOne(spec("t1", ["ocr"]));
    expect(result.ok).toBe(false);
    const failure = result as RunFailure;
    expect(failure.error.message).toContain("required capabilities");
    expect(balancer.task("t1").failureReason).toBe("no-candidates");
  });
});

describe("FleetRunner.runAll", () => {
  test("respects agent concurrency and resolves the full batch", async () => {
    const { balancer } = fleet();
    let peakInFlight = 0;
    let current = 0;
    const runner = new FleetRunner(balancer, async (task) => {
      void task;
      current += 1;
      peakInFlight = Math.max(peakInFlight, current);
      await new Promise((resolve) => setTimeout(resolve, 5));
      current -= 1;
      return "done";
    });
    const results = await runner.runAll<string>([spec("t1"), spec("t2"), spec("t3"), spec("t4")]);
    expect(results.every((result) => result.ok)).toBe(true);
    expect(peakInFlight).toBeLessThanOrEqual(2); // 1 slot each across two agents
    expect(balancer.snapshot().completed).toBe(4);
  });

  test("mixed batch: some succeed, budget-exhausted tasks fail individually", async () => {
    const { balancer } = fleet();
    const runner = new FleetRunner(balancer, (task, agent) => {
      if (task.id === "doomed") throw new Error(`broken on ${agent.id}`);
      return `ok:${task.id}`;
    });
    const results = await runner.runAll<string>([spec("healthy"), spec("doomed")]);
    const byId = new Map(results.map((result) => [result.taskId, result]));
    expect(byId.get("healthy")?.ok).toBe(true);
    expect(byId.get("doomed")?.ok).toBe(false);
  });
});

describe("runTask convenience wrapper", () => {
  test("unwraps success and throws the structured failure", async () => {
    const { balancer } = fleet();
    const value = await runTask(balancer, spec("t1"), () => 41 + 1);
    expect(value).toBe(42);

    const breaking = new FleetBalancer({ clock: new ManualClock(), maxAttempts: 1 });
    breaking.registerAgent({ id: "a", capabilities: [], maxConcurrency: 1 });
    await expect(runTask(breaking, spec("t2"), () => Promise.reject(new Error("nope")))).rejects.toThrow(
      /failed after 1 attempt/,
    );
  });
});
