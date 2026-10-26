import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../src/cli.js";
import { runDemo } from "../src/demo.js";
import { EXIT_CODES } from "../src/errors.js";
import { VERSION } from "../src/version.js";

const workdir = mkdtempSync(join(tmpdir(), "dalb-cli-"));
afterAll(() => {
  rmSync(workdir, { recursive: true, force: true });
});

function capture(callback: () => Promise<number>): Promise<{ code: number; out: string; err: string }> {
  const chunks: Array<{ stream: "out" | "err"; text: string }> = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: unknown) => {
    chunks.push({ stream: "out", text: String(chunk) });
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown) => {
    chunks.push({ stream: "err", text: String(chunk) });
    return true;
  }) as typeof process.stderr.write;
  return callback()
    .then((code) => {
      process.stdout.write = origOut;
      process.stderr.write = origErr;
      return {
        code,
        out: chunks.filter((c) => c.stream === "out").map((c) => c.text).join(""),
        err: chunks.filter((c) => c.stream === "err").map((c) => c.text).join(""),
      };
    })
    .catch((error) => {
      process.stdout.write = origOut;
      process.stderr.write = origErr;
      throw error;
    });
}

function writePlan(name: string, content: unknown): string {
  const path = join(workdir, name);
  writeFileSync(path, JSON.stringify(content));
  return path;
}

describe("dalb CLI", () => {
  test("demo output is byte-identical across calls", () => {
    const first = runDemo();
    const second = runDemo();
    expect(second).toBe(first);
    expect(first).toContain("dynamic-agent-load-balancer demo");
    expect(first).toContain("Failed tasks:");
  });

  test("demo output hash is stable (CI determinism gate value)", () => {
    const hash = createHash("sha256").update(runDemo()).digest("hex");
    expect(hash).toBe(createHash("sha256").update(runDemo()).digest("hex"));
  });

  test("version prints the package version", async () => {
    const result = await capture(() => runCli(["version"]));
    expect(result.code).toBe(0);
    expect(result.out).toBe(`dalb ${VERSION}\n`);
  });

  test("no command and unknown commands exit with usage codes", async () => {
    const bare = await capture(() => runCli([]));
    expect(bare.code).toBe(EXIT_CODES.USAGE);
    expect(bare.out).toContain("Usage:");

    const helped = await capture(() => runCli(["--help"]));
    expect(helped.code).toBe(0);

    const unknown = await capture(() => runCli(["warp"]));
    expect(unknown.code).toBe(EXIT_CODES.USAGE);
    expect(unknown.err).toContain('unknown command "warp"');
  });

  test("run executes a plan and reports the fleet", async () => {
    const path = writePlan("plan.json", {
      agents: [
        { id: "a", capabilities: ["t"], maxConcurrency: 1 },
        { id: "b", capabilities: ["t"], maxConcurrency: 1 },
      ],
      tasks: [
        { id: "t1", requiredCapabilities: ["t"], durationMs: 50 },
        { id: "t2", requiredCapabilities: ["t"], priority: 1, durationMs: 50, failOnAgents: ["a"], failTimes: 1 },
      ],
      maxAttempts: 2,
    });
    const result = await capture(() => runCli(["run", path]));
    expect(result.code).toBe(0);
    expect(result.out).toContain("assign");
    expect(result.out).toContain("t2 -> a"); // first attempt lands on the flaky agent
    expect(result.out).toContain("requeue");
    expect(result.out).toContain("t2 -> b"); // retry migrates off it
  });

  test("run fails with PLAN_ERROR on unreadable or invalid plans", async () => {
    const missing = await capture(() => runCli(["run", join(workdir, "missing.json")]));
    expect(missing.code).toBe(EXIT_CODES.PLAN_ERROR);
    expect(missing.err).toContain("cannot read plan");

    const malformed = join(workdir, "broken.json");
    writeFileSync(malformed, "{not json");
    const broken = await capture(() => runCli(["run", malformed]));
    expect(broken.code).toBe(EXIT_CODES.PLAN_ERROR);

    const badPlan = writePlan("bad.json", { agents: [], tasks: [] });
    const empty = await capture(() => runCli(["run", badPlan]));
    expect(empty.code).toBe(EXIT_CODES.PLAN_ERROR);
    expect(empty.err).toContain("non-empty array");
  });

  test("run honors strict priority: the tail waits for the blocked head", async () => {
    const path = writePlan("strict.json", {
      allowSkipAhead: false,
      agents: [
        { id: "ocr", capabilities: ["ocr"], maxConcurrency: 1 },
        { id: "t", capabilities: ["t"], maxConcurrency: 1 },
      ],
      tasks: [
        { id: "blocker", requiredCapabilities: ["ocr"], priority: 9, durationMs: 100 },
        { id: "head", requiredCapabilities: ["ocr"], priority: 5, durationMs: 10 },
        { id: "tail", requiredCapabilities: ["t"], durationMs: 10 },
      ],
    });
    const result = await capture(() => runCli(["run", path]));
    expect(result.code).toBe(0);
    expect(result.out).toContain("head -> ocr");
    // strict priority: while the head waits (ocr agent busy), the placeable tail holds
    expect(result.out).not.toContain("[t=     0ms] assign    tail");
    // the moment the head is placed, the tail flows too
    expect(result.out).toContain("[t=   100ms] assign    tail");
  });

  test("score prints candidate breakdowns for every task", async () => {
    const path = writePlan("score.json", {
      agents: [
        { id: "spec", capabilities: ["t"], maxConcurrency: 1 },
        { id: "general", capabilities: ["t", "ocr"], maxConcurrency: 1 },
      ],
      tasks: [{ id: "t1", requiredCapabilities: ["t"] }],
    });
    const result = await capture(() => runCli(["score", path]));
    expect(result.code).toBe(0);
    expect(result.out).toContain("t1");
    expect(result.out).toContain("SPECIALIZATION");
    expect(result.out).toContain("spec");
    expect(result.out).toContain("general");
  });

  test("score fails cleanly on missing files", async () => {
    const result = await capture(() => runCli(["score", join(workdir, "nope.json")]));
    expect(result.code).toBe(EXIT_CODES.PLAN_ERROR);
  });
});

describe("package/version coherence", () => {
  test("VERSION matches package.json", () => {
    const pkg = JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf-8")) as {
      version: string;
    };
    expect(VERSION).toBe(pkg.version);
  });
});
