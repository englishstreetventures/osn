// @vitest-environment happy-dom
import { createRoot } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createIsMobile } from "../../src/lib/useIsMobile";

interface MqlStub {
  matches: boolean;
  media: string;
  addEventListener: ReturnType<typeof vi.fn>;
  removeEventListener: ReturnType<typeof vi.fn>;
  dispatch: (matches: boolean) => void;
}

function makeMqlStub(initial: boolean): MqlStub {
  let listener: ((e: MediaQueryListEvent) => void) | null = null;
  return {
    matches: initial,
    media: "(max-width: 640px)",
    addEventListener: vi.fn((_event: string, handler: (e: MediaQueryListEvent) => void) => {
      listener = handler;
    }),
    removeEventListener: vi.fn(() => {
      listener = null;
    }),
    dispatch(matches: boolean) {
      this.matches = matches;
      listener?.({ matches } as MediaQueryListEvent);
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createIsMobile", () => {
  it("returns the initial matchMedia state", () => {
    const mql = makeMqlStub(true);
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => mql),
    );
    createRoot((dispose) => {
      const isMobile = createIsMobile();
      expect(isMobile()).toBe(true);
      dispose();
    });
  });

  it("flips when the media query fires a change event", () => {
    const mql = makeMqlStub(false);
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => mql),
    );
    createRoot((dispose) => {
      const isMobile = createIsMobile();
      expect(isMobile()).toBe(false);
      mql.dispatch(true);
      expect(isMobile()).toBe(true);
      mql.dispatch(false);
      expect(isMobile()).toBe(false);
      dispose();
    });
  });

  it("subscribes and unsubscribes on root disposal", () => {
    const mql = makeMqlStub(false);
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => mql),
    );
    createRoot((dispose) => {
      createIsMobile();
      expect(mql.addEventListener).toHaveBeenCalledTimes(1);
      dispose();
    });
    expect(mql.removeEventListener).toHaveBeenCalledTimes(1);
  });

  it("returns a stable false signal when matchMedia is unavailable", () => {
    vi.stubGlobal("matchMedia", undefined);
    createRoot((dispose) => {
      const isMobile = createIsMobile();
      expect(isMobile()).toBe(false);
      dispose();
    });
  });
});
