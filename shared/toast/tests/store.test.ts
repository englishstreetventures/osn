import { afterEach, describe, expect, it, vi } from "vitest";

import { dismiss, EXIT_MS, resetToasts, scheduleDismiss, toasts, upsert } from "../src/store";

afterEach(() => {
  resetToasts();
  vi.useRealTimers();
});

describe("the toast queue", () => {
  it("raises a toast and hands back its id", () => {
    const id = upsert({ tone: "success", message: "Saved" });
    expect(toasts()).toHaveLength(1);
    expect(toasts()[0]).toMatchObject({ id, tone: "success", message: "Saved" });
  });

  it("gives each toast a distinct auto id, so two raises stack", () => {
    upsert({ tone: "success", message: "One" });
    upsert({ tone: "success", message: "Two" });
    expect(toasts()).toHaveLength(2);
    expect(toasts()[0]!.id).not.toBe(toasts()[1]!.id);
  });

  it("UPDATES in place when the id is already on screen rather than stacking a copy", () => {
    upsert({ tone: "loading", message: "Saving…", id: "save" });
    upsert({ tone: "success", message: "Saved", id: "save" });
    expect(toasts()).toHaveLength(1);
    expect(toasts()[0]).toMatchObject({ id: "save", tone: "success", message: "Saved" });
  });

  it("keeps raise order through an in-place update", () => {
    upsert({ tone: "info", message: "First", id: "a" });
    upsert({ tone: "info", message: "Second", id: "b" });
    upsert({ tone: "success", message: "First done", id: "a" });
    // `seq` is assigned once at raise, so an update must not jump the queue.
    expect(toasts().map((t) => t.seq)).toEqual([1, 2]);
  });

  it("revives a dismissing toast when its id is re-raised, rather than leaving a zombie", () => {
    vi.useFakeTimers();
    upsert({ tone: "loading", message: "Saving…", id: "save" });
    dismiss("save");
    expect(toasts()[0]!.dismissing).toBe(true);
    upsert({ tone: "success", message: "Saved", id: "save" });
    expect(toasts()[0]!.dismissing).toBe(false);
    // The pending removal must not fire now that the toast is live again.
    vi.advanceTimersByTime(EXIT_MS + 10);
    expect(toasts()).toHaveLength(1);
  });
});

describe("dismissal", () => {
  it("marks the toast leaving first, then removes it once the exit has run", () => {
    vi.useFakeTimers();
    const id = upsert({ tone: "success", message: "Saved" });
    dismiss(id);
    // Still mounted — otherwise the exit animation has nothing to animate.
    expect(toasts()).toHaveLength(1);
    expect(toasts()[0]!.dismissing).toBe(true);
    vi.advanceTimersByTime(EXIT_MS);
    expect(toasts()).toHaveLength(0);
  });

  it("is idempotent — a second dismiss does not race the first", () => {
    vi.useFakeTimers();
    const id = upsert({ tone: "success", message: "Saved" });
    dismiss(id);
    dismiss(id);
    vi.advanceTimersByTime(EXIT_MS);
    expect(toasts()).toHaveLength(0);
  });

  it("dismisses everything when called with no id", () => {
    vi.useFakeTimers();
    upsert({ tone: "info", message: "One" });
    upsert({ tone: "info", message: "Two" });
    dismiss();
    vi.advanceTimersByTime(EXIT_MS);
    expect(toasts()).toHaveLength(0);
  });
});

describe("the auto-dismiss clock", () => {
  it("dismisses after the duration elapses", () => {
    vi.useFakeTimers();
    const id = upsert({ tone: "success", message: "Saved" });
    scheduleDismiss(id, 1000);
    vi.advanceTimersByTime(1000 + EXIT_MS);
    expect(toasts()).toHaveLength(0);
  });

  it("pins the toast when the duration is Infinity — a spinner must not time out", () => {
    vi.useFakeTimers();
    const id = upsert({ tone: "loading", message: "Saving…" });
    scheduleDismiss(id, Number.POSITIVE_INFINITY);
    vi.advanceTimersByTime(600_000);
    expect(toasts()).toHaveLength(1);
  });

  it("restarts the clock rather than stacking two timers", () => {
    vi.useFakeTimers();
    const id = upsert({ tone: "success", message: "Saved" });
    scheduleDismiss(id, 1000);
    vi.advanceTimersByTime(900);
    scheduleDismiss(id, 1000);
    vi.advanceTimersByTime(500);
    expect(toasts(), "the first timer should have been cancelled").toHaveLength(1);
    vi.advanceTimersByTime(500 + EXIT_MS);
    expect(toasts()).toHaveLength(0);
  });
});

describe("the queue is bounded (S-L1)", () => {
  it("expires a toast that never renders", () => {
    // The zombie path. A `Toaster` caps what it RENDERS, and an item-owned
    // clock only starts on mount — so a burst raised inside one Solid batch
    // leaves everything past the limit un-mounted, un-clocked, and in the queue
    // for the life of the page. The store starting the clock is what closes it.
    vi.useFakeTimers();
    for (let i = 0; i < 10; i++) upsert({ tone: "info", message: `m${i}` });
    expect(toasts()).toHaveLength(10);
    vi.advanceTimersByTime(4000 + EXIT_MS);
    expect(toasts(), "un-rendered toasts never expired").toHaveLength(0);
  });

  it("caps the queue, so a runaway raise cannot grow it without bound", () => {
    vi.useFakeTimers();
    for (let i = 0; i < 200; i++) upsert({ tone: "error", message: `m${i}` });
    expect(toasts().length).toBeLessThanOrEqual(24);
    // The survivors are the newest — the oldest are what get evicted.
    expect(toasts().at(-1)?.message).toBe("m199");
  });

  it("honours a per-toast duration over the default", () => {
    vi.useFakeTimers();
    upsert({ tone: "success", message: "quick", duration: 100 });
    vi.advanceTimersByTime(100 + EXIT_MS);
    expect(toasts()).toHaveLength(0);
  });
});
