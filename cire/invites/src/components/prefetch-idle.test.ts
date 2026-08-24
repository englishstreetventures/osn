import { afterEach, describe, expect, it, vi } from "vitest";

import { prefetchOnIdle } from "./prefetch-idle";

type IdleWindow = Omit<typeof globalThis, "requestIdleCallback" | "cancelIdleCallback"> & {
  requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
  cancelIdleCallback?: (handle: number) => void;
};

const win = globalThis as IdleWindow;

afterEach(() => {
  delete win.requestIdleCallback;
  delete win.cancelIdleCallback;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("prefetchOnIdle", () => {
  it("runs the loader via requestIdleCallback when available", () => {
    const idle = vi.fn((cb: () => void) => {
      cb();
      return 1;
    });
    win.requestIdleCallback = idle;
    const load = vi.fn(() => Promise.resolve());

    prefetchOnIdle(load);

    expect(idle).toHaveBeenCalledOnce();
    expect(load).toHaveBeenCalledOnce();
  });

  it("passes a timeout so a permanently busy page still prefetches", () => {
    const idle = vi.fn((_cb: () => void, _opts?: { timeout: number }) => 1);
    win.requestIdleCallback = idle;

    prefetchOnIdle(() => Promise.resolve());

    expect(idle.mock.calls[0]?.[1]).toEqual({ timeout: 3000 });
  });

  it("falls back to a delayed timer when requestIdleCallback is missing (Safari < 17)", () => {
    vi.useFakeTimers();
    const load = vi.fn(() => Promise.resolve());

    prefetchOnIdle(load);
    // Not immediate — a prefetch must not compete with hydration.
    expect(load).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1500);
    expect(load).toHaveBeenCalledOnce();
  });

  it("cancel stops a pending timer-path prefetch", () => {
    vi.useFakeTimers();
    const load = vi.fn(() => Promise.resolve());

    prefetchOnIdle(load)();
    vi.advanceTimersByTime(5000);

    expect(load).not.toHaveBeenCalled();
  });

  it("cancel forwards to cancelIdleCallback on the idle path", () => {
    win.requestIdleCallback = () => 42;
    const cancel = vi.fn();
    win.cancelIdleCallback = cancel;

    prefetchOnIdle(() => Promise.resolve())();

    expect(cancel).toHaveBeenCalledWith(42);
  });

  it("swallows a failed prefetch — it is a hint, never a dependency", async () => {
    win.requestIdleCallback = (cb) => {
      cb();
      return 1;
    };
    const onUnhandled = vi.fn();
    process.on("unhandledRejection", onUnhandled);

    expect(() => prefetchOnIdle(() => Promise.reject(new Error("chunk 404")))).not.toThrow();
    // Let the rejection settle before asserting nothing escaped.
    await new Promise((r) => setTimeout(r, 0));

    process.off("unhandledRejection", onUnhandled);
    expect(onUnhandled).not.toHaveBeenCalled();
  });
});
