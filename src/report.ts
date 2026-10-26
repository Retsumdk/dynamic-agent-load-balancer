/** Deterministic text rendering for events, stats, scores, and snapshots. */

import type {
  AgentRegistration,
  AgentStat,
  ScoreBreakdown,
  FleetSnapshot,
  TaskRecord,
} from "./types.js";
import type { SimEvent } from "./simulate.js";

function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((header, column) =>
    Math.max(header.length, ...rows.map((row) => (row[column] ?? "").length)),
  );
  const line = (cells: string[]): string =>
    cells.map((cell, column) => (cell ?? "").padEnd(widths[column] ?? 0)).join("  ").trimEnd();
  const lines = [
    line(headers),
    widths.map((width) => "-".repeat(width)).join("  "),
    ...rows.map(line),
  ];
  return lines.join("\n");
}

export function renderFleet(agents: AgentRegistration[]): string {
  return table(
    ["AGENT", "CAPABILITIES", "CONCURRENCY"],
    agents.map((agent) => [
      agent.id,
      agent.capabilities.join(",") || "(any)",
      String(agent.maxConcurrency),
    ]),
  );
}

export function renderEvents(events: SimEvent[]): string {
  return events
    .map((event) => {
      const who = event.agentId ? `${event.taskId} -> ${event.agentId}` : event.taskId;
      const tail = event.detail ? ` (${event.detail})` : "";
      return `[t=${String(event.t).padStart(6)}ms] ${event.kind.padEnd(9)} ${who}${tail}`;
    })
    .join("\n");
}

export function renderAgentStats(stats: AgentStat[]): string {
  return table(
    ["AGENT", "CAPS", "CONC", "IN-FLIGHT", "OK/ATT", "FAIL", "SR*", "EWMA(ms)"],
    stats.map((stat) => [
      stat.id,
      stat.capabilities.join(",") || "(any)",
      `${stat.inFlight}/${stat.maxConcurrency}`,
      String(stat.inFlight),
      `${stat.completions}/${stat.attempts}`,
      String(stat.failures),
      `${(stat.successRate * 100).toFixed(0)}%`,
      stat.ewmaLatencyMs === null ? "-" : stat.ewmaLatencyMs.toFixed(0),
    ]),
  );
}

export function renderScoreTable(scores: ScoreBreakdown[]): string {
  return table(
    ["AGENT", "CAPACITY", "SPECIALIZATION", "PERFORMANCE", "TOTAL"],
    scores.map((score) => [
      score.agentId,
      score.capacity.toFixed(3),
      score.specialization.toFixed(3),
      score.performance.toFixed(3),
      score.total.toFixed(3),
    ]),
  );
}

export function renderSnapshot(snapshot: FleetSnapshot): string {
  const total = snapshot.completed + snapshot.failed + snapshot.queued + snapshot.running;
  const utilization = `${(snapshot.utilization * 100).toFixed(0)}%`;
  return [
    `fleet : ${snapshot.agents} agent(s), ${snapshot.inFlight}/${snapshot.capacitySlots} slots in use (utilization ${utilization})`,
    `tasks : ${total} total | completed ${snapshot.completed} | failed ${snapshot.failed} | running ${snapshot.running} | queued ${snapshot.queued}`,
  ].join("\n");
}

export function renderFailedTasks(records: TaskRecord[]): string {
  return table(
    ["TASK", "REASON", "ATTEMPTS", "ERROR"],
    records.map((record) => [
      record.id,
      record.failureReason ?? "-",
      String(record.attempts),
      record.lastError ?? "-",
    ]),
  );
}
