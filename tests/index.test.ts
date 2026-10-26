import { describe, expect, test } from "bun:test";
import * as api from "../src/index.js";
import { BalancerError } from "../src/errors.js";
import { FleetBalancer } from "../src/balancer.js";
import { FleetRunner } from "../src/runner.js";
import { ManualClock } from "../src/clock.js";

describe("public API surface", () => {
  test("exports the documented entry points", () => {
    expect(api.FleetBalancer).toBeTypeOf("function");
    expect(api.FleetRunner).toBeTypeOf("function");
    expect(api.runTask).toBeTypeOf("function");
    expect(api.simulate).toBeTypeOf("function");
    expect(api.runDemo).toBeTypeOf("function");
    expect(api.SystemClock).toBeTypeOf("function");
    expect(api.ManualClock).toBeTypeOf("function");
    expect(api.BalancerError).toBeTypeOf("function");
    expect(api.EXIT_CODES.OK).toBe(0);
    expect(api.DEFAULT_WEIGHTS).toEqual({ capacity: 0.4, specialization: 0.35, performance: 0.25 });
    expect(typeof api.laplaceSuccessRate).toBe("function");
    expect(typeof api.median).toBe("function");
    expect(typeof api.validateWeights).toBe("function");
  });

  test("BalancerError carries machine-readable codes", () => {
    const error = new BalancerError("DALB_UNKNOWN_TASK", "nope");
    expect(error.code).toBe("DALB_UNKNOWN_TASK");
    expect(error.name).toBe("BalancerError");
    expect(error).toBeInstanceOf(Error);
  });

  test("the full stack works end to end through index exports", async () => {
    const balancer = new FleetBalancer({ clock: new ManualClock() });
    balancer.registerAgent({ id: "a", capabilities: ["t"], maxConcurrency: 2 });
    const value = await api.runTask(
      balancer,
      { id: "job", requiredCapabilities: ["t"] },
      () => "done",
    );
    expect(value).toBe("done");
    expect(balancer.snapshot().completed).toBe(1);
    expect(new FleetRunner(balancer, () => 1)).toBeInstanceOf(FleetRunner);
  });
});
