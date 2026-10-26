/** Clock implementations: wall-clock for production, controllable for tests. */

import type { Clock } from "./types.js";

export class SystemClock implements Clock {
  now(): number {
    return Date.now();
  }

  setTimeout(callback: () => void, ms: number): number {
    return setTimeout(callback, Math.max(0, ms)) as unknown as number;
  }

  clearTimeout(handle: number): void {
    clearTimeout(handle);
  }
}

interface ManualTimer {
  handle: number;
  at: number;
  callback: () => void;
}

/**
 * Virtual clock with an ordered timer wheel. Deterministic: time only moves
 * through advance(), firing due timers in schedule order.
 */
export class ManualClock implements Clock {
  private currentMs: number;
  private nextHandle = 0;
  private readonly timers = new Map<number, ManualTimer>();

  constructor(startMs = 0) {
    this.currentMs = startMs;
  }

  now(): number {
    return this.currentMs;
  }

  setTimeout(callback: () => void, ms: number): number {
    const handle = ++this.nextHandle;
    this.timers.set(handle, { handle, at: this.currentMs + Math.max(0, ms), callback });
    return handle;
  }

  clearTimeout(handle: number): void {
    this.timers.delete(handle);
  }

  /** Advance time by `ms`, firing every timer due within the window in order. */
  advance(ms: number): void {
    if (ms < 0) throw new RangeError("advance() requires a non-negative duration");
    const target = this.currentMs + ms;
    for (;;) {
      let due: ManualTimer | null = null;
      for (const timer of this.timers.values()) {
        if (timer.at <= target && (due === null || timer.at < due.at || (timer.at === due.at && timer.handle < due.handle))) {
          due = timer;
        }
      }
      if (due === null) break;
      this.timers.delete(due.handle);
      this.currentMs = Math.max(this.currentMs, due.at);
      due.callback();
    }
    this.currentMs = target;
  }

  /** Move time to an absolute point, firing every timer due along the way. */
  advanceTo(targetMs: number): void {
    if (targetMs < this.currentMs) {
      throw new RangeError("advanceTo() cannot move time backwards");
    }
    this.advance(targetMs - this.currentMs);
  }
}
