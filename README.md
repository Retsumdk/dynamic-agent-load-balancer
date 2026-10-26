# dynamic-agent-load-balancer

Placement engine for fleets of AI agents. You submit tasks with capability requirements and priorities; the balancer decides which agent runs each task based on **real-time capacity**, **specialization**, and **performance history** — and it explains every decision.

```
[t=     0ms] submit    blocker
[t=     0ms] submit    head
[t=     0ms] assign    blocker -> ocr
[t=   100ms] complete  blocker -> ocr
[t=   100ms] assign    head -> ocr
[t=   110ms] complete  head -> ocr
```

## The problem

Agent fleets fail at placement long before they fail at execution. The common failure modes:

- **Saturation collapse** — a dispatcher round-robins work to a generalist until it melts while a specialist idles.
- **Generalist starvation** — tasks land on the one agent that can do everything, so the work only that agent can run queues behind it.
- **Cold-start bias and reputation lock-in** — new agents never get work because they have no track record; unproven agents are excluded forever instead of given bounded trust.
- **Silent retry loops** — a flaky agent keeps receiving the same task, failing, and receiving it again, with no exclusion memory and no terminal state.
- **Opaque placement** — nobody can answer *why* task 14 went to agent B, so nobody can tune the dispatcher.

`dynamic-agent-load-balancer` solves placement as an explicit, deterministic, testable state machine instead of scatter-gunned queue code.

## How it works

Three layers, all driven by an injected clock so every decision is reproducible:

```
FleetBalancer  →  placement state machine (this is the product)
FleetRunner    →  optional executor: dispatches and runs your handler with timeout + cross-agent retries
simulate()     →  discrete-event simulator for plans, demos, and CI
```

### Placement scoring

For each queued task, every candidate agent (right capabilities, not excluded, has a free concurrency slot) is scored on three components, each normalized to `[0, 1]`:

| Component | Formula | Why |
|---|---|---|
| **capacity** | `1 − inFlight / maxConcurrency` | Prefer agents with headroom; saturate the fleet evenly. |
| **specialization** | `\|required caps\| / \|agent caps\|` | Exact specialists score 1.0; generalists score lower, keeping their broad slots free for tasks only they can run. |
| **performance** | `0.7 · Laplace(success) + 0.3 · relative speed` | Smoothed success rate `(completions+1)/(attempts+2)` gives unproven agents a neutral 0.5 — cold agents still get placed. Speed is the fleet median EWMA latency over the agent's own, clamped so one outlier can't dominate. |

Weighted total with configurable weights (default `0.4 / 0.35 / 0.25`), ties broken deterministically by agent id. `balancer.scoreCandidates(taskId)` returns the full per-agent breakdown — capacity, specialization, performance, total — so placement is auditable, not folklore.

### Dispatch, queueing, and failure policy

- **Priority queue**: higher `priority` first, FIFO within a priority class.
- **Skip-ahead** (default on): if the head task has no available candidate, later placeable tasks still run. Set `allowSkipAhead: false` for strict priority — nothing dispatches while the head waits (max utilization vs. strict ordering; one flag, both semantics).
- **Attempt budget with exclusion**: `fail(taskId)` excludes that agent *for that task* and requeues it. Retries land on a different agent. When `maxAttempts` (default 2) is reached, the task settles as `failed` with reason `exhausted` — no infinite flapping.
- **Reaping**: a queued task whose capabilities no remaining agent can satisfy fails immediately as `no-candidates` instead of blocking the queue forever. An *empty* fleet means "not staffed yet" — tasks wait rather than fail.
- **Concurrency**: an agent never exceeds its `maxConcurrency` in-flight tasks.

## Getting started

```bash
git clone https://github.com/Retsumdk/dynamic-agent-load-balancer.git
cd dynamic-agent-load-balancer
bun install
bun test          # 73 tests
bun run demo      # deterministic 6-agent fleet demo
bun dist/cli-run.js --help
```

Or install straight from GitHub (the `prepare` script compiles `dist/` on install):

```bash
npm install github:Retsumdk/dynamic-agent-load-balancer
```

### Library use

```ts
import { FleetBalancer, FleetRunner } from "dynamic-agent-load-balancer";

const balancer = new FleetBalancer();
balancer.registerAgent({ id: "gpu-1", capabilities: ["embed"], maxConcurrency: 1 });
balancer.registerAgent({ id: "cpu-1", capabilities: ["transform", "summarize"], maxConcurrency: 3 });

// Placement only — you execute the task:
balancer.submit({ id: "t1", requiredCapabilities: ["embed"] });
const assignment = balancer.dispatch();        // → { taskId: "t1", agentId: "gpu-1", ... }
balancer.complete("t1");

// Or let FleetRunner execute handlers with timeout + cross-agent retries:
const runner = new FleetRunner(balancer, async (task, agent) => {
  return `ran ${task.id} on ${agent.id}`;
}, { timeoutMs: 5_000 });

const result = await runner.runOne<string>({ id: "t2", requiredCapabilities: ["summarize"] });
if (result.ok) console.log(result.value, "via", result.agentId, "attempt", result.attempt);
```

### CLI

```bash
dalb demo                # deterministic fleet demo (byte-identical output every run)
dalb run plan.json       # simulate a fleet/task plan, print event log + stats
dalb score plan.json     # print per-agent score breakdowns for every task
dalb version
```

A plan file:

```json
{
  "allowSkipAhead": true,
  "maxAttempts": 2,
  "weights": { "capacity": 0.4, "specialization": 0.35, "performance": 0.25 },
  "agents": [
    { "id": "a", "capabilities": ["t"], "maxConcurrency": 1 },
    { "id": "b", "capabilities": ["t"], "maxConcurrency": 1 }
  ],
  "tasks": [
    { "id": "t1", "requiredCapabilities": ["t"], "durationMs": 50 },
    { "id": "t2", "requiredCapabilities": ["t"], "durationMs": 50,
      "priority": 1, "failOnAgents": ["a"], "failTimes": 1 }
  ]
}
```

`dalb run` prints the event log, per-agent stats (completions/attempts, failures, Laplace success rate, EWMA latency), and a fleet snapshot. Exit codes: `0` ok, `2` usage, `3` plan error, `4` runtime error.

## Tests and CI

73 tests (9 files) cover scoring math, dispatch/ordering, exclusion + attempt budgets, reaping, empty-fleet semantics, EWMA from the injected clock, timeout migration, simulator determinism, and CLI exit codes. CI runs typecheck, the suite, a byte-identical demo diff, and installs the package from the pushed commit via git to verify the published artifact.

## License

MIT
