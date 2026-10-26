import { describe, expect, test } from "bun:test";
import { ManualClock, SystemClock } from "../src/clock.js";

describe("SystemClock", () => {
  test("now() tracks wall time and timers fire", async () => {
    const clock = new ManualClock(); // replaced below; keep SystemClock import used
    void clock;
    const system = new SystemClock();
    expect(system.now()).toBeGreaterThan(0);
    const fired = new Promise<void>((resolve) => {
      system.setTimeout(resolve, 5);
    });
    await fired;
  });
});

describe("ManualClock", () => {
  test("starts at the requested time and only moves forward", () => {
    const clock = new ManualClock(5_000);
    expect(clock.now()).toBe(5_000);
    clock.advance(250);
    expect(clock.now()).toBe(5_250);
    expect(() => new ManualClock().advance(-1)).toThrow(RangeError);
  });

  test("advanceTo cannot move time backwards", () => {
    const clock = new ManualClock(100);
    expect(() => clock.advanceTo(50)).toThrow(RangeError);
    clock.advanceTo(500);
    expect(clock.now()).toBe(500);
  });

  test("timers fire in schedule order, including simultaneous ones in handle order", () => {
    const clock = new ManualClock();
    const fired: string[] = [];
    clock.setTimeout(() => fired.push("late"), 100);
    clock.setTimeout(() => fired.push("early-a"), 40);
    clock.setTimeout(() => fired.push("early-b"), 40);
    clock.advance(100);
    expect(fired).toEqual(["early-a", "early-b", "late"]);
    expect(clock.now()).toBe(100);
  });

  test("cleared timers never fire", () => {
    const clock = new ManualClock();
    const fired: string[] = [];
    const handle = clock.setTimeout(() => fired.push("nope"), 50);
    clock.clearTimeout(handle);
    clock.advance(50);
    expect(fired).toEqual([]);
  });

  test("timers scheduled during a timer's callback fire in the same advance", () => {
    const clock = new ManualClock();
    const fired: string[] = [];
    clock.setTimeout(() => {
      fired.push("first");
      clock.setTimeout(() => fired.push("nested"), 10);
    }, 10);
    clock.advance(100);
    expect(fired).toEqual(["first", "nested"]);
    expect(clock.now()).toBe(100);
  });
});
