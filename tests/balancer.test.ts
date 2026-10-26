import { describe, expect, test } from "bun:test";
import { FleetBalancer } from "../src/balancer.js";
import { ManualClock } from "../src/clock.js";
import { BalancerError } from "../src/errors.js";
import type { TaskSpec } from "../src/types.js";

function makeBalancer(maxAttempts = 2, allowSkipAhead = true): FleetBalancer {
  return new FleetBalancer({ clock: new ManualClock(), maxAttempts, allowSkipAhead });
}

function task(id: string, required: string[] = [], priority = 0): TaskSpec {
  return { id, requiredCapabilities: required, priority };
}

describe("fleet management", () => {
  test("register, duplicate detection, and lookup", () => {
    const balancer = makeBalancer();
    balancer.registerAgent({ id: "a", capabilities: ["t"], maxConcurrency: 1 });
    expect(balancer.hasAgent("a")).toBe(true);
    expect(() => balancer.registerAgent({ id: "a", capabilities: [], maxConcurrency: 1 })).toThrow(BalancerError);
    expect(() => balancer.unregisterAgent("ghost")).toThrow(BalancerError);
  });

  test("capabilities are normalized: trimmed, lowercased, deduped", () => {
    const balancer = makeBalancer();
    balancer.registerAgent({ id: "a", capabilities: [" OCR ", "ocr", "T"], maxConcurrency: 1 });
    const stat = balancer.stats().find((s) => s.id === "a");
    expect(stat?.capabilities).toEqual(["ocr", "t"]);
  });

  test("invalid agent and task specs are rejected", () => {
    const balancer = makeBalancer();
    expect(() => balancer.registerAgent({ id: " ", capabilities: [], maxConcurrency: 1 })).toThrow(BalancerError);
    expect(() => balancer.registerAgent({ id: "a", capabilities: [], maxConcurrency: 0 })).toThrow(BalancerError);
    expect(() => balancer.registerAgent({ id: "a", capabilities: [], maxConcurrency: 1.5 })).toThrow(BalancerError);
    expect(() => balancer.submit(task(" "))).toThrow(BalancerError);
    expect(() => balancer.submit({ id: "t1", requiredCapabilities: [], priority: 1.5 })).toThrow(BalancerError);
  });

  test("unregister refuses while busy, works when idle", () => {
    const balancer = makeBalancer();
    balancer.registerAgent({ id: "a", capabilities: ["t"], maxConcurrency: 1 });
    balancer.submit(task("t1", ["t"]));
    balancer.dispatch();
    expect(() => balancer.unregisterAgent("a")).toThrow(/in flight/);
    balancer.complete("t1");
    balancer.unregisterAgent("a");
    expect(balancer.hasAgent("a")).toBe(false);
  });
});

describe("placement", () => {
  test("exact specialists outrank generalists", () => {
    const balancer = makeBalancer();
    balancer.registerAgent({ id: "general", capabilities: ["t", "ocr"], maxConcurrency: 1 });
    balancer.registerAgent({ id: "spec", capabilities: ["t"], maxConcurrency: 1 });
    balancer.submit(task("t1", ["t"]));
    const assignment = balancer.dispatch();
    expect(assignment?.agentId).toBe("spec");
  });

  test("more headroom wins after the first placement", () => {
    const balancer = makeBalancer();
    balancer.registerAgent({ id: "a", capabilities: ["t"], maxConcurrency: 2 });
    balancer.registerAgent({ id: "b", capabilities: ["t"], maxConcurrency: 1 });
    balancer.submit(task("t1", ["t"]));
    balancer.dispatch();
    balancer.submit(task("t2", ["t"]));
    expect(balancer.dispatch()?.agentId).toBe("b");
  });

  test("performance history dominates when capacity is equal", () => {
    const balancer = makeBalancer();
    balancer.registerAgent({ id: "flaky", capabilities: ["t"], maxConcurrency: 1 });
    balancer.registerAgent({ id: "solid", capabilities: ["t"], maxConcurrency: 1 });

    balancer.submit(task("warmup", ["t"]));
    expect(balancer.dispatch()?.agentId).toBe("flaky"); // unproven tie broken alphabetically
    balancer.fail("warmup", "boom"); // flaky excluded for this task, attempt requeued
    const retry = balancer.dispatch();
    expect(retry?.agentId).toBe("solid"); // reliability gap already decisive
    balancer.complete("warmup"); // solid earns clean history

    balancer.submit(task("t1", ["t"]));
    expect(balancer.dispatch()?.agentId).toBe("solid"); // history now dominates the tie
  });

  test("capability filtering excludes agents that cannot run the task", () => {
    const balancer = makeBalancer();
    balancer.registerAgent({ id: "t-only", capabilities: ["t"], maxConcurrency: 1 });
    balancer.registerAgent({ id: "ocr-only", capabilities: ["ocr"], maxConcurrency: 1 });
    balancer.submit(task("t1", ["t", "ocr"]));
    expect(balancer.dispatch()).toBeNull();
    const record = balancer.task("t1");
    expect(record.status).toBe("failed");
    expect(record.failureReason).toBe("no-candidates");
  });

  test("full-capacity agents are skipped under skip-ahead, then recovered", () => {
    const balancer = makeBalancer();
    balancer.registerAgent({ id: "single", capabilities: ["t"], maxConcurrency: 1 });
    balancer.submit(task("head", ["t"], 10));
    balancer.dispatch();
    balancer.submit(task("tail", ["t"]));
    expect(balancer.dispatch()).toBeNull(); // single is saturated
    balancer.complete("head");
    expect(balancer.dispatch()?.taskId).toBe("tail");
  });
});

describe("queueing", () => {
  test("higher priority dispatches first; FIFO within a priority class", () => {
    const balancer = makeBalancer();
    balancer.registerAgent({ id: "a", capabilities: ["t"], maxConcurrency: 1 });
    balancer.submit(task("low", ["t"], 0));
    balancer.submit(task("high", ["t"], 5));
    balancer.submit(task("high-later", ["t"], 5));
    expect(balancer.dispatch()?.taskId).toBe("high");
    balancer.complete("high");
    expect(balancer.dispatch()?.taskId).toBe("high-later");
    balancer.complete("high-later");
    expect(balancer.dispatch()?.taskId).toBe("low");
  });

  test("queuedTasks reflects the priority order", () => {
    const balancer = makeBalancer();
    balancer.submit(task("b", [], 1));
    balancer.submit(task("a", [], 9));
    expect(balancer.queuedTasks()).toEqual(["a", "b"]);
  });

  test("strict mode holds the line: nothing dispatches behind a blocked head task", () => {
    const balancer = makeBalancer(2, false);
    balancer.registerAgent({ id: "ocr", capabilities: ["ocr"], maxConcurrency: 1 });
    balancer.registerAgent({ id: "t", capabilities: ["t"], maxConcurrency: 1 });
    balancer.submit(task("blocker", ["ocr"], 9));
    balancer.dispatch(); // blocker occupies the only ocr slot
    balancer.submit(task("head", ["ocr"], 5)); // queued: ocr agent saturated
    balancer.submit(task("tail", ["t"])); // placeable, but strict mode holds the line
    expect(balancer.dispatch()).toBeNull();
    balancer.complete("blocker");
    expect(balancer.dispatch()?.taskId).toBe("head"); // priority order restored
  });

  test("dispatchAll drains until the fleet is saturated", () => {
    const balancer = makeBalancer();
    balancer.registerAgent({ id: "a", capabilities: ["t"], maxConcurrency: 2 });
    balancer.registerAgent({ id: "b", capabilities: ["t"], maxConcurrency: 1 });
    balancer.submit(task("t1", ["t"]));
    balancer.submit(task("t2", ["t"]));
    balancer.submit(task("t3", ["t"]));
    const placed = balancer.dispatchAll();
    expect(placed).toHaveLength(3);
    expect(balancer.snapshot().inFlight).toBe(3);
    balancer.complete("t1");
    expect(balancer.dispatchAll()).toEqual([]);
  });
});

describe("settlement and retries", () => {
  test("fail requeues with the agent excluded, then completes elsewhere", () => {
    const balancer = makeBalancer(3);
    balancer.registerAgent({ id: "a", capabilities: ["t"], maxConcurrency: 1 });
    balancer.registerAgent({ id: "b", capabilities: ["t"], maxConcurrency: 1 });
    balancer.submit(task("t1", ["t"]));
    expect(balancer.dispatch()?.agentId).toBe("a");
    const record = balancer.fail("t1", "crash");
    expect(record.status).toBe("queued");
    expect(record.excludedAgents).toEqual(["a"]);
    expect(record.attempts).toBe(1);
    expect(balancer.dispatch()?.agentId).toBe("b");
    expect(balancer.complete("t1").status).toBe("completed");
  });

  test("attempt budget exhaustion settles the task as failed", () => {
    const balancer = makeBalancer(2);
    balancer.registerAgent({ id: "a", capabilities: ["t"], maxConcurrency: 1 });
    balancer.registerAgent({ id: "b", capabilities: ["t"], maxConcurrency: 1 });
    balancer.submit(task("t1", ["t"]));
    balancer.dispatch();
    expect(balancer.fail("t1").status).toBe("queued");
    balancer.dispatch();
    const record = balancer.fail("t1", "again");
    expect(record.status).toBe("failed");
    expect(record.failureReason).toBe("exhausted");
    expect(record.attempts).toBe(2);
  });

  test("a requeued task whose only capable agent is excluded fails fast, not forever", () => {
    const balancer = makeBalancer(5);
    balancer.registerAgent({ id: "solo", capabilities: ["t"], maxConcurrency: 1 });
    balancer.submit(task("t1", ["t"]));
    balancer.dispatch();
    const record = balancer.fail("t1", "solo is down");
    expect(record.status).toBe("failed");
    expect(record.failureReason).toBe("no-candidates");
    expect(balancer.queuedTasks()).toEqual([]);
  });

  test("reaping fails queued tasks when their capability disappears", () => {
    const balancer = makeBalancer();
    balancer.registerAgent({ id: "a", capabilities: ["ocr"], maxConcurrency: 1 });
    balancer.registerAgent({ id: "b", capabilities: ["t"], maxConcurrency: 1 });
    balancer.submit(task("t1", ["ocr"]));
    balancer.unregisterAgent("a");
    expect(balancer.task("t1").failureReason).toBe("no-candidates");
  });

  test("an empty fleet keeps tasks queued instead of failing them", () => {
    const balancer = makeBalancer();
    balancer.submit(task("t1", ["t"]));
    expect(balancer.task("t1").status).toBe("queued");
    balancer.registerAgent({ id: "w", capabilities: ["t"], maxConcurrency: 1 });
    expect(balancer.dispatch()?.taskId).toBe("t1");
  });

  test("settlement requires a running task", () => {
    const balancer = makeBalancer();
    balancer.registerAgent({ id: "w", capabilities: [], maxConcurrency: 1 });
    balancer.submit(task("t1"));
    expect(() => balancer.complete("t1")).toThrow(BalancerError);
    expect(() => balancer.complete("ghost")).toThrow(BalancerError);
    balancer.dispatch();
    balancer.complete("t1");
    balancer.submit(task("t2"));
    balancer.dispatch();
    balancer.complete("t2");
    expect(() => balancer.fail("t2")).toThrow(BalancerError);
  });

  test("EWMA latency reflects the clock, not the wall", () => {
    const clock = new ManualClock();
    const balancer = new FleetBalancer({ clock });
    balancer.registerAgent({ id: "a", capabilities: ["t"], maxConcurrency: 1 });
    balancer.submit(task("t1", ["t"]));
    balancer.dispatch();
    clock.advance(120);
    balancer.complete("t1");
    expect(balancer.stats()[0].ewmaLatencyMs).toBe(120);
    balancer.submit(task("t2", ["t"]));
    balancer.dispatch();
    clock.advance(360);
    balancer.complete("t2");
    expect(balancer.stats()[0].ewmaLatencyMs).toBeCloseTo(0.3 * 360 + 0.7 * 120);
  });
});

describe("scoring introspection", () => {
  test("scoreCandidates ranks eligible agents and zeroes ineligible ones", () => {
    const balancer = makeBalancer();
    balancer.registerAgent({ id: "spec", capabilities: ["t"], maxConcurrency: 1 });
    balancer.registerAgent({ id: "general", capabilities: ["t", "ocr"], maxConcurrency: 1 });
    const scores = balancer.scoreCandidates({ id: "probe", requiredCapabilities: ["t"] });
    expect(scores[0].agentId).toBe("spec");
    expect(scores[0].specialization).toBe(1);
    expect(scores[1].agentId).toBe("general");
    expect(scores[1].specialization).toBeCloseTo(0.5);
    const ineligible = balancer.scoreCandidates({ id: "probe2", requiredCapabilities: ["zzz"] });
    expect(ineligible.every((score) => score.total === 0)).toBe(true);
  });

  test("scoreCandidates accepts a queued task id", () => {
    const balancer = makeBalancer();
    balancer.registerAgent({ id: "a", capabilities: ["t"], maxConcurrency: 1 });
    balancer.submit(task("t1", ["t"]));
    const scores = balancer.scoreCandidates("t1");
    expect(scores).toHaveLength(1);
    expect(scores[0].agentId).toBe("a");
    expect(() => balancer.scoreCandidates("ghost")).toThrow(BalancerError);
  });
});

describe("inspection and validation", () => {
  test("snapshot counts and utilization", () => {
    const balancer = makeBalancer();
    balancer.registerAgent({ id: "a", capabilities: ["t"], maxConcurrency: 2 });
    balancer.registerAgent({ id: "b", capabilities: ["t"], maxConcurrency: 1 });
    balancer.submit(task("t1", ["t"]));
    balancer.submit(task("t2", ["t"]));
    balancer.submit(task("t3", ["t"]));
    balancer.dispatchAll();
    const snapshot = balancer.snapshot();
    expect(snapshot.agents).toBe(2);
    expect(snapshot.inFlight).toBe(3);
    expect(snapshot.capacitySlots).toBe(3);
    expect(snapshot.running).toBe(3);
    expect(snapshot.utilization).toBe(1);
    balancer.complete("t1");
    expect(balancer.snapshot().completed).toBe(1);
    expect(balancer.snapshot().utilization).toBeCloseTo(2 / 3);
  });

  test("listTasks filters by status in submission order", () => {
    const balancer = makeBalancer();
    balancer.submit(task("t1"));
    balancer.submit(task("t2"));
    expect(balancer.listTasks().map((t) => t.id)).toEqual(["t1", "t2"]);
    expect(balancer.listTasks("queued").map((t) => t.id)).toEqual(["t1", "t2"]);
    expect(balancer.listTasks("completed")).toEqual([]);
  });

  test("duplicate task ids are rejected even after completion", () => {
    const balancer = makeBalancer();
    balancer.registerAgent({ id: "a", capabilities: [], maxConcurrency: 1 });
    balancer.submit(task("t1"));
    balancer.dispatch();
    balancer.complete("t1");
    expect(() => balancer.submit(task("t1"))).toThrow(/already used/);
  });

  test("task records expose the attempt trail", () => {
    const balancer = makeBalancer(3);
    balancer.registerAgent({ id: "a", capabilities: ["t"], maxConcurrency: 1 });
    balancer.registerAgent({ id: "b", capabilities: ["t"], maxConcurrency: 1 });
    balancer.registerAgent({ id: "c", capabilities: ["t"], maxConcurrency: 1 });
    balancer.submit(task("t1", ["t"]));
    balancer.dispatch();
    balancer.fail("t1");
    balancer.dispatch();
    balancer.fail("t1");
    balancer.dispatch();
    balancer.complete("t1");
    const record = balancer.task("t1");
    expect(record.attemptAgents).toEqual(["a", "b", "c"]);
    expect(record.attempts).toBe(3);
    expect(record.assignedAgent).toBeUndefined();
  });
});

describe("option validation", () => {
  test("invalid weights and attempt budgets are rejected", () => {
    expect(() => new FleetBalancer({ weights: { capacity: -1 } })).toThrow(BalancerError);
    expect(() => new FleetBalancer({ weights: { capacity: 0, specialization: 0, performance: 0 } })).toThrow(
      BalancerError,
    );
    expect(() => new FleetBalancer({ maxAttempts: 0 })).toThrow(BalancerError);
    expect(() => new FleetBalancer({ maxAttempts: 2.5 })).toThrow(BalancerError);
  });

  test("custom weights change the placement outcome", () => {
    const balanced = makeBalancer();
    balanced.registerAgent({ id: "spec", capabilities: ["t"], maxConcurrency: 1 });
    balanced.registerAgent({ id: "general", capabilities: ["t", "ocr"], maxConcurrency: 1 });
    balanced.submit(task("t1", ["t"]));
    expect(balanced.dispatch()?.agentId).toBe("spec");

    const performanceOnly = new FleetBalancer({
      clock: new ManualClock(),
      weights: { capacity: 0, specialization: 0, performance: 1 },
    });
    performanceOnly.registerAgent({ id: "spec", capabilities: ["t"], maxConcurrency: 1 });
    performanceOnly.registerAgent({ id: "general", capabilities: ["t", "ocr"], maxConcurrency: 1 });
    performanceOnly.submit(task("t1", ["t"]));
    // specialization is zeroed: the tie between equally-unproven agents breaks alphabetically
    expect(performanceOnly.dispatch()?.agentId).toBe("general");
  });
});
