/**
 * Self-contained showcase: a six-agent fleet with uneven capabilities,
 * capacities, and a deliberately unreliable member. A priority-ordered task
 * batch exercises specialization routing, retry-on-failure migration, an
 * exhausted task, and the final fleet report. Runs on a ManualClock, so the
 * output is byte-identical every time.
 */

import { simulate } from "./simulate.js";
import {
  renderAgentStats,
  renderEvents,
  renderFailedTasks,
  renderFleet,
  renderSnapshot,
} from "./report.js";

const FLEET = [
  { id: "generalist", capabilities: ["transform", "summarize"], maxConcurrency: 2 },
  { id: "gpu-box", capabilities: ["embed", "transform"], maxConcurrency: 1 },
  { id: "economist", capabilities: ["summarize"], maxConcurrency: 3 },
  { id: "polyglot", capabilities: ["translate", "summarize", "embed"], maxConcurrency: 2 },
  { id: "flaky-fast", capabilities: ["transform", "ocr"], maxConcurrency: 2 },
  { id: "archivist", capabilities: ["ocr", "embed"], maxConcurrency: 1 },
];

const TASKS = [
  { id: "daily-brief", requiredCapabilities: ["summarize"], priority: 5, durationMs: 120 },
  { id: "inbox-digest", requiredCapabilities: ["summarize"], priority: 4, durationMs: 90 },
  { id: "vectorize-catalog", requiredCapabilities: ["embed"], priority: 4, durationMs: 300 },
  { id: "normalize-feed", requiredCapabilities: ["transform"], priority: 3, durationMs: 60 },
  {
    id: "normalize-legacy",
    requiredCapabilities: ["transform"],
    priority: 3,
    durationMs: 60,
    failOnAgents: ["flaky-fast"],
    failTimes: 1,
  },
  { id: "translate-manual", requiredCapabilities: ["translate"], priority: 3, durationMs: 240 },
  { id: "scan-receipts", requiredCapabilities: ["ocr"], priority: 2, durationMs: 200 },
  {
    id: "scan-damaged-fax",
    requiredCapabilities: ["ocr"],
    priority: 2,
    durationMs: 200,
    failOnAgents: ["archivist"],
    failTimes: 9,
  },
  { id: "normalize-logs", requiredCapabilities: ["transform"], priority: 1, durationMs: 60 },
  { id: "summarize-thread", requiredCapabilities: ["summarize"], priority: 1, durationMs: 150 },
  { id: "embed-support-tickets", requiredCapabilities: ["embed"], priority: 1, durationMs: 180 },
];

export function runDemo(): string {
  const result = simulate({ agents: FLEET, tasks: TASKS, maxAttempts: 2 });
  const balancer = result.balancer;
  const sections: string[] = [];

  sections.push("dynamic-agent-load-balancer demo");
  sections.push("=================================");
  sections.push("");
  sections.push("Fleet (capabilities and concurrency slots):");
  sections.push(renderFleet(FLEET));
  sections.push("");
  sections.push("Event log (simulated wall-clock time):");
  sections.push(renderEvents(result.events));
  sections.push("");
  sections.push("What to notice:");
  sections.push(
    "- summarize work lands on economist (3 slots) and polyglot first; the generalist keeps capacity for transform work",
  );
  sections.push(
    "- normalize-legacy fails on flaky-fast and its retry is placed on a different agent (exclusion per task)",
  );
  sections.push(
    "- scan-damaged-fax exhausts its attempt budget and is failed with reason exhausted instead of looping forever",
  );
  sections.push(
    "- embed work splits between gpu-box and archivist; neither exceeds one in-flight task",
  );
  sections.push("");
  sections.push("Final agent stats (SR* is Laplace-smoothed success rate; EWMA is attempt latency):");
  sections.push(renderAgentStats(balancer.stats()));
  sections.push("");
  sections.push(renderSnapshot(balancer.snapshot()));
  sections.push("");
  sections.push("Failed tasks:");
  sections.push(renderFailedTasks(balancer.listTasks("failed")));
  return sections.join("\n") + "\n";
}

if (import.meta.main) {
  process.stdout.write(runDemo());
}
