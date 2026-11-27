import { vi } from "vitest";

/**
 * Fakes the timers `Effect.sleep` waits on, so a grant's retry pause costs no
 * real time. Effect's scheduler yields with `setImmediate`, which stays real:
 * faking it would stop every fiber. Pair with `vi.useRealTimers()` in
 * `afterEach`.
 */
export function fakeSleeps(): void {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
}

/**
 * Moves the faked clock on 50 ms at a time until `promise` settles, and fails
 * if it has not settled after `limitMs` of faked time, so a call that never
 * ends fails here rather than at the test's timeout.
 */
export async function untilSettled<T>(promise: Promise<T>, limitMs = 10_000): Promise<T> {
  // An object, not a `let`: the callbacks below set it between loop turns.
  const state = { settled: false };
  promise.then(
    () => (state.settled = true),
    () => (state.settled = true),
  );
  for (let elapsed = 0; !state.settled && elapsed < limitMs; elapsed += 50) {
    await vi.advanceTimersByTimeAsync(50);
  }
  if (!state.settled) throw new Error(`still pending after ${limitMs} ms of faked time`);
  return promise;
}
