import { describe, expect, test } from "bun:test";
import { ManualClock } from "../src/clock.js";
import { parseSimConfig, simulate } from "../src/simulate.js";
import type { SimConfig } from "../src/simulate.js";

const PLAN: SimConfig = {
  maxAttempts: 2,
  agents: [
    { id: "spec", capabilities: ["t"], maxConcurrency: 1 },
    { id: "general", capabilities: ["t", "ocr"], maxConcurrency: 1 },
  ],
  tasks: [
    { id: "t1", requiredCapabilities: ["t"], durationMs: 100 },
    { id: "t2", requiredCapabilities: ["t"], durationMs: 100, failOnAgents: ["spec"], failTimes: 1 },
  ],
};

describe("simulate", () => {
  test("is byte-identical across runs (determinism contract)", () => {
    const first = JSON.stringify(simulate(PLAN).events);
    const second = JSON.stringify(simulate(PLAN).events);
    expect(second).toBe(first);
  });

  test("reports the wall clock and terminal states", () => {
    const result = simulate(PLAN);
    expect(result.wallMs).toBeGreaterThan(0);
    expect(result.completed.map((record) => record.id)).toEqual(["t1", "t2"]);
    expect(result.failed).toEqual([]);
  });

  test("failOnAgents retries elsewhere; exhausted tasks land in failed", () => {
    const result = simulate({
      maxAttempts: 2,
      agents: [
        { id: "a", capabilities: ["t"], maxConcurrency: 1 },
        { id: "b", capabilities: ["t"], maxConcurrency: 1 },
      ],
      tasks: [{ id: "t1", requiredCapabilities: ["t"], durationMs: 50, failOnAgents: ["a", "b"] }],
    });
    expect(result.failed).toHaveLength(1);
    const record = result.failed[0];
    expect(record.failureReason).toBe("exhausted");
    expect(record.attempts).toBe(2);
    expect(result.events.some((event) => event.kind === "exhaust")).toBe(true);
  });

  test("priority order and concurrency are visible in the event stream", () => {
    const result = simulate({
      agents: [{ id: "a", capabilities: ["t"], maxConcurrency: 1 }],
      tasks: [
        { id: "low", requiredCapabilities: ["t"], priority: 0, durationMs: 10 },
        { id: "high", requiredCapabilities: ["t"], priority: 9, durationMs: 10 },
      ],
    });
    const assigns = result.events.filter((event) => event.kind === "assign");
    expect(assigns[0].taskId).toBe("high");
    expect(assigns[0].t).toBe(0);
    // with one slot, the low-priority task can only start after the high one completes
    expect(assigns[1].t).toBeGreaterThanOrEqual(10);
  });

  test("utilization never exceeds capacity", () => {
    const result = simulate(PLAN);
    expect(result.balancer.snapshot().utilization).toBeLessThanOrEqual(1);
  });

  test("the returned balancer retains per-agent stats", () => {
    const result = simulate(PLAN);
    const specStat = result.balancer.stats().find((stat) => stat.id === "spec");
    expect(specStat?.attempts).toBeGreaterThan(0);
  });
});

describe("parseSimConfig", () => {
  test("normalizes agent capabilities and applies task defaults", () => {
    const config = parseSimConfig({
      agents: [{ id: " A ", capabilities: [" OCR ", "ocr"], maxConcurrency: 2 }],
      tasks: [{ id: "t1", requiredCapabilities: ["OCR"] }],
    });
    expect(config.agents[0].id).toBe("A");
    expect(config.agents[0].capabilities).toEqual(["ocr"]);
    expect(config.tasks[0].durationMs).toBe(100);
    expect(config.tasks[0].priority).toBe(0);
  });

  test("rejects malformed plans with explicit errors", () => {
    expect(() => parseSimConfig(null)).toThrow();
    expect(() => parseSimConfig({ agents: [], tasks: [] })).toThrow(/non-empty array/);
    expect(() => parseSimConfig({ agents: [{ id: "a" }], tasks: [{ id: " " }] })).toThrow();
    expect(() => parseSimConfig({ agents: [{ id: "a" }], tasks: "nope" })).toThrow(/must be an array/);
  });

  test("weights, allowSkipAhead, and maxAttempts round-trip", () => {
    const config = parseSimConfig({
      weights: { capacity: 1 },
      allowSkipAhead: false,
      maxAttempts: 4,
      agents: [{ id: "a" }],
      tasks: [],
    });
    expect(config.weights).toEqual({ capacity: 1, specialization: undefined, performance: undefined });
    expect(config.allowSkipAhead).toBe(false);
    expect(config.maxAttempts).toBe(4);
    void new ManualClock();
  });
});
