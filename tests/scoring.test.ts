import { describe, expect, test } from "bun:test";
import { performanceScore, specializationScore, laplaceSuccessRate, median } from "../src/scoring.js";
import { DEFAULT_WEIGHTS } from "../src/scoring.js";

describe("laplaceSuccessRate", () => {
  test("unproven agents sit at a neutral 0.5", () => {
    expect(laplaceSuccessRate(0, 0)).toBe(0.5);
  });

  test("a perfect record converges upward, a failing one downward", () => {
    expect(laplaceSuccessRate(8, 8)).toBe(0.9);
    expect(laplaceSuccessRate(8, 0)).toBeCloseTo(1 / 10);
  });
});

describe("specializationScore", () => {
  test("exact specialists score 1.0; broad agents score lower", () => {
    expect(specializationScore(1, 1)).toBe(1);
    expect(specializationScore(2, 2)).toBe(1);
    expect(specializationScore(1, 4)).toBe(0.25);
  });

  test("a capability-less agent is neutral only for requirement-free tasks", () => {
    expect(specializationScore(0, 0)).toBe(0.5);
    expect(specializationScore(1, 0)).toBe(0);
  });
});

describe("performanceScore", () => {
  test("unproven agents get the neutral prior regardless of fleet speed", () => {
    expect(performanceScore({ attempts: 0, completions: 0, ewmaLatencyMs: null }, 100)).toBeCloseTo(0.5);
  });

  test("faster-than-median agents outrun slower ones at equal reliability", () => {
    const fast = performanceScore({ attempts: 4, completions: 4, ewmaLatencyMs: 50 }, 100);
    const slow = performanceScore({ attempts: 4, completions: 4, ewmaLatencyMs: 400 }, 100);
    expect(fast).toBeGreaterThan(slow);
  });

  test("speed is clamped so one outlier cannot dominate", () => {
    const floor = performanceScore({ attempts: 4, completions: 4, ewmaLatencyMs: 100_000 }, 100);
    const ceiling = performanceScore({ attempts: 4, completions: 4, ewmaLatencyMs: 1 }, 100);
    expect(floor).toBeCloseTo(0.7 * (5 / 6) + 0.3 * (0.25 / 2));
    expect(ceiling).toBeCloseTo(0.7 * (5 / 6) + 0.3 * 1);
  });
});

describe("median", () => {
  test("odd and even lengths", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(median([])).toBeNull();
  });
});

describe("DEFAULT_WEIGHTS", () => {
  test("capacity leads, performance trails, and they sum to one", () => {
    expect(DEFAULT_WEIGHTS.capacity).toBe(0.4);
    expect(DEFAULT_WEIGHTS.specialization).toBe(0.35);
    expect(DEFAULT_WEIGHTS.performance).toBe(0.25);
    expect(DEFAULT_WEIGHTS.capacity + DEFAULT_WEIGHTS.specialization + DEFAULT_WEIGHTS.performance).toBeCloseTo(1);
  });
});
