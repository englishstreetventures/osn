import { createComputed, createRoot } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  dismiss,
  EXIT_MS,
  pause,
  resetToasts,
  scheduleDismiss,
  toasts,
  upsert,
} from "../src/store";

const roots: (() => void)[] = [];

afterEach(() => {
  for (const dispose of roots.splice(0)) dispose();
  resetToasts();
  vi.useRealTimers();
});

/**
 * What a toast holding focus does as `dismiss` re-renders it. The new object
 * `dismiss` writes makes `<For>` replace the row; Chromium fires `focusout`
 * from the row it takes away, and the row resumes its clock (`Toast.tsx`), all
 * inside the store's own write. happy-dom drops focus on removal without an
 * event, so a rendered `Toaster` cannot show this; a computation on the queue
 * runs at the same point instead.
 */
function resumeAsFocusLeaves(id: string, duration: number) {
  createRoot((dispose) => {
    roots.push(dispose);
    createComputed(() => {
      if (toasts().find((t) => t.id === id)?.dismissing) scheduleDismiss(id, duration);
    });
  });
}

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

describe("a leaving toast's clock", () => {
  it("leaves no timer but its removal, and none after resetToasts(), when it held focus", () => {
    vi.useFakeTimers();
    const id = upsert({ tone: "success", message: "Deleted", duration: 5000 });
    resumeAsFocusLeaves(id, 5000);

    dismiss(id);
    expect(vi.getTimerCount(), "a dwell outlived the dismissal beside its removal").toBe(1);

    resetToasts();
    expect(vi.getTimerCount(), "a timer outlived resetToasts()").toBe(0);
  });

  it("does not cut short a toast raised again under its id within the dwell", () => {
    vi.useFakeTimers();
    upsert({ tone: "success", message: "Deleted", id: "undo", duration: 5000 });
    resumeAsFocusLeaves("undo", 5000);
    vi.advanceTimersByTime(1000);
    dismiss("undo");
    vi.advanceTimersByTime(EXIT_MS);
    expect(toasts()).toHaveLength(0);

    // Raised at 1200, so its dwell runs to 6200. A dwell restarted by the
    // dismissal at 1000 would end it at 6000.
    upsert({ tone: "success", message: "Deleted again", id: "undo", duration: 5000 });
    vi.advanceTimersByTime(5000 - EXIT_MS + 50);
    expect(toasts()).toHaveLength(1);
    expect(toasts()[0]!.dismissing, "the toast raised again was cut short").toBeFalsy();

    vi.advanceTimersByTime(150 + EXIT_MS);
    expect(toasts()).toHaveLength(0);
  });

  it("still goes when the pointer comes to rest on it on its way out", () => {
    vi.useFakeTimers();
    const id = upsert({ tone: "success", message: "Saved" });
    dismiss(id);
    pause(id);
    vi.advanceTimersByTime(EXIT_MS);
    expect(toasts(), "the pause cancelled the removal").toHaveLength(0);
  });

  it("still goes on time when focus or the pointer leaves it on its way out", () => {
    vi.useFakeTimers();
    const id = upsert({ tone: "success", message: "Saved" });
    dismiss(id);
    scheduleDismiss(id, 4000);
    vi.advanceTimersByTime(EXIT_MS);
    expect(toasts(), "the resumed dwell replaced the removal").toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("the queue is bounded", () => {
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
