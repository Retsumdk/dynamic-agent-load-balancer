/**
 * Placement scoring. Every component is normalized to [0,1] so the weighted
 * total stays comparable across configurations:
 *
 *  capacity      1 - inFlight/maxConcurrency (candidates always have headroom)
 *  specialization required-caps/agent-caps — exact specialists score 1.0,
 *                generalists score lower so their broad slots stay free for
 *                tasks only they can run
 *  performance   0.7 * Laplace-smoothed success rate + 0.3 * relative speed
 *                (fleet median latency / agent EWMA, clamped to [0.25,1] after
 *                halving); unproven agents sit at a neutral ~0.5 so cold agents
 *                still get placed
 */

import type { AgentStat, ScoringWeights, ScoreBreakdown } from "./types.js";

export const DEFAULT_WEIGHTS: Readonly<ScoringWeights> = {
  capacity: 0.4,
  specialization: 0.35,
  performance: 0.25,
};

export const PERF_RELIABILITY_SHARE = 0.7;
export const SPEED_CLAMP_MIN = 0.25;
export const SPEED_CLAMP_MAX = 2;

export interface PerformanceInputs {
  attempts: number;
  completions: number;
  ewmaLatencyMs: number | null;
}

export function laplaceSuccessRate(attempts: number, completions: number): number {
  return (completions + 1) / (attempts + 2);
}

export function performanceScore(inputs: PerformanceInputs, fleetMedianMs: number | null): number {
  const reliability = laplaceSuccessRate(inputs.attempts, inputs.completions);
  let speed = 0.5;
  if (inputs.ewmaLatencyMs !== null && fleetMedianMs !== null && fleetMedianMs > 0) {
    const ratio = fleetMedianMs / inputs.ewmaLatencyMs;
    speed = clamp(ratio, SPEED_CLAMP_MIN, SPEED_CLAMP_MAX) / 2;
  }
  return PERF_RELIABILITY_SHARE * reliability + (1 - PERF_RELIABILITY_SHARE) * speed;
}

export function specializationScore(requiredCount: number, agentCapabilityCount: number): number {
  if (agentCapabilityCount === 0) return requiredCount === 0 ? 0.5 : 0;
  return clamp(requiredCount / agentCapabilityCount, 0, 1);
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function validateWeights(weights: ScoringWeights): void {
  for (const key of ["capacity", "specialization", "performance"] as const) {
    const value = weights[key];
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`weights.${key} must be a finite non-negative number`);
    }
  }
  if (weights.capacity + weights.specialization + weights.performance <= 0) {
    throw new Error("at least one scoring weight must be positive");
  }
}

export interface ScoreCandidateInput {
  stat: AgentStat;
  requiredCount: number;
  eligible: boolean;
  weights: ScoringWeights;
  fleetMedianMs: number | null;
}

export function scoreCandidate(input: ScoreCandidateInput): ScoreBreakdown {
  const { stat, requiredCount, eligible, weights, fleetMedianMs } = input;
  const capacity = eligible && stat.maxConcurrency > 0
    ? 1 - stat.inFlight / stat.maxConcurrency
    : 0;
  const specialization = specializationScore(requiredCount, stat.capabilities.length);
  const performance = performanceScore(
    { attempts: stat.attempts, completions: stat.completions, ewmaLatencyMs: stat.ewmaLatencyMs },
    fleetMedianMs,
  );
  const total = eligible
    ? weights.capacity * capacity + weights.specialization * specialization + weights.performance * performance
    : 0;
  return {
    agentId: stat.id,
    capacity: round3(capacity),
    specialization: round3(specialization),
    performance: round3(performance),
    total: round3(total),
  };
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
