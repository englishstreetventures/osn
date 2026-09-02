import { createRoot } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createRsvpClosed } from "../../src/components/createRsvpClosed";
import type { RsvpDeadline } from "../../src/components/types";

const deadline = (over: Partial<RsvpDeadline> = {}): RsvpDeadline => ({
  date: "2026-09-01",
  timezone: "Australia/Sydney",
  closesAt: "2026-09-01T13:59:59.999Z",
  closed: false,
  ...over,
});

/**
 * Mount the primitive and hand back its accessor + disposer. Solid flushes
 * `createEffect`s when `createRoot`'s update batch completes, so the scheduling
 * effect has run by the time this returns — asserting inside the root body
 * would see a timer that hasn't been created yet.
 */
function mount(get: () => RsvpDeadline | null) {
  let closed!: () => boolean;
  let dispose!: () => void;
  createRoot((d) => {
    dispose = d;
    closed = createRsvpClosed(get);
  });
  return { closed, dispose };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("createRsvpClosed", () => {
  it("is false with no deadline and never schedules a timer", () => {
    vi.useFakeTimers();
    const { closed, dispose } = mount(() => null);
    expect(closed()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    dispose();
  });

  it("flips to closed on its own when the deadline passes mid-session", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-01T13:59:00.000Z")); // a minute to go

    const { closed, dispose } = mount(() => deadline());
    expect(closed()).toBe(false);
    // Nothing polls — one timer waits for the exact instant.
    expect(vi.getTimerCount()).toBe(1);

    vi.advanceTimersByTime(61_000);
    expect(closed()).toBe(true);
    dispose();
  });

  it("reports an already-passed deadline without waiting on a timer", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-01T00:00:00.000Z"));

    const { closed, dispose } = mount(() => deadline({ closed: true }));
    expect(closed()).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    dispose();
  });

  it("does not schedule a deadline beyond setTimeout's 32-bit range", () => {
    // A delay over ~24.8 days overflows and fires IMMEDIATELY, which would flip
    // a far-off invite closed the moment a guest opened it.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

    const { closed, dispose } = mount(() => deadline());
    expect(closed()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    dispose();
  });

  it("ignores an unparseable closesAt rather than scheduling on NaN", () => {
    vi.useFakeTimers();
    const { closed, dispose } = mount(() => deadline({ closesAt: "soon", closed: false }));
    expect(closed()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    dispose();
  });

  it("clears its timer on dispose", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-01T13:59:00.000Z"));

    const { dispose } = mount(() => deadline());
    expect(vi.getTimerCount()).toBe(1);
    dispose();
    expect(vi.getTimerCount()).toBe(0);
  });
});
