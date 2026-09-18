import { createRoot } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createRsvpDeadlineState } from "../../src/components/createRsvpDeadlineState";
import type { RsvpDeadlineState } from "../../src/components/rsvp-deadline";
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
  let state!: () => RsvpDeadlineState | null;
  let dispose!: () => void;
  createRoot((d) => {
    dispose = d;
    state = createRsvpDeadlineState(get);
  });
  return { state, dispose };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("createRsvpDeadlineState", () => {
  it("is null with no deadline and never schedules a timer", () => {
    vi.useFakeTimers();
    const { state, dispose } = mount(() => null);
    expect(state()).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    dispose();
  });

  it("flips to closed on its own when the deadline passes mid-session", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-01T13:59:00.000Z")); // a minute to go

    const { state, dispose } = mount(() => deadline());
    expect(state()).toBe("closing-soon");
    // Nothing polls — one timer waits for the exact instant.
    expect(vi.getTimerCount()).toBe(1);

    vi.advanceTimersByTime(61_000);
    expect(state()).toBe("closed");
    dispose();
  });

  it("reports an already-passed deadline without waiting on a timer", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-01T00:00:00.000Z"));

    const { state, dispose } = mount(() => deadline({ closed: true }));
    expect(state()).toBe("closed");
    expect(vi.getTimerCount()).toBe(0);
    dispose();
  });

  it("does not schedule a deadline beyond setTimeout's 32-bit range", () => {
    // A delay over ~24.8 days overflows and fires IMMEDIATELY, which would flip
    // a far-off invite closed the moment a guest opened it. Both boundaries are
    // out of range here, so nothing waits.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

    const { state, dispose } = mount(() => deadline());
    expect(state()).toBe("open");
    expect(vi.getTimerCount()).toBe(0);
    dispose();
  });

  it("walks open → closing-soon → closed on one chained timer", () => {
    // 30 days out: the "closing soon" boundary is 23 days away and schedulable,
    // the close itself is 30 and is not. Waiting for the near boundary and then
    // re-arming is what gets this session to `closed` at all — a second timer
    // created up front would have been out of range and never created.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-02T13:59:59.999Z"));

    const { state, dispose } = mount(() => deadline());
    expect(state()).toBe("open");
    expect(vi.getTimerCount()).toBe(1);

    vi.advanceTimersByTime(23 * 24 * 60 * 60 * 1000 + 2000);
    expect(state()).toBe("closing-soon");
    // Re-armed for the close rather than left hanging.
    expect(vi.getTimerCount()).toBe(1);

    vi.advanceTimersByTime(7 * 24 * 60 * 60 * 1000 + 2000);
    expect(state()).toBe("closed");
    expect(vi.getTimerCount()).toBe(0);
    dispose();
  });

  it("ignores an unparseable closesAt rather than scheduling on NaN", () => {
    vi.useFakeTimers();
    const { state, dispose } = mount(() => deadline({ closesAt: "soon", closed: false }));
    expect(state()).toBe("open");
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
