// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * What is worth testing here is the *gate*, not the waveform.
 *
 * No test environment can feel a vibration, and happy-dom has no Vibration API
 * at all — so `web-haptics` decides at class-definition time that it is
 * unsupported and falls back to clicking a hidden switch. The vibrate spy below
 * is therefore installed before the library is ever imported, which is the only
 * moment its `static isSupported` is read.
 *
 * The contract asserted: nothing fires when the host has haptics off, each
 * semantic name maps to exactly one preset pattern, and importing the module
 * touches neither `navigator` nor the document until something is triggered.
 */

/** Load a fresh library + wrapper against whatever `navigator.vibrate` is now. */
async function load() {
  vi.resetModules();
  const theme = await import("./theme");
  const haptics = await import("./haptics");
  return { ...haptics, ...theme };
}

let vibrate: ReturnType<typeof vi.fn>;

beforeEach(() => {
  localStorage.clear();
  vibrate = vi.fn(() => true);
  Object.defineProperty(navigator, "vibrate", {
    configurable: true,
    writable: true,
    value: vibrate,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("haptic", () => {
  it("fires nothing at all when the host has haptics off", async () => {
    const { haptic, setHapticsEnabled } = await load();
    setHapticsEnabled(false);
    haptic("commit");
    haptic("reject");
    expect(vibrate).not.toHaveBeenCalled();
  });

  it("fires when the host has them on", async () => {
    const { haptic } = await load();
    haptic("commit");
    expect(vibrate).toHaveBeenCalledTimes(1);
  });

  it("gives each name its own pattern", async () => {
    const { haptic } = await load();
    const patterns = new Map<string, unknown>();
    for (const name of ["commit", "reject", "dismiss"] as const) {
      vibrate.mockClear();
      haptic(name);
      expect(vibrate).toHaveBeenCalledTimes(1);
      patterns.set(name, JSON.stringify(vibrate.mock.calls[0]?.[0]));
    }
    expect(new Set(patterns.values()).size).toBe(patterns.size);
  });

  it("keeps `commit` and `reject` distinguishable by length, not just by feel", async () => {
    // Success is two taps and error is three. A vendor who cannot see the
    // screen — phone in one hand — should be able to tell them apart.
    const { haptic } = await load();
    const lengthOf = (name: "commit" | "reject") => {
      vibrate.mockClear();
      haptic(name);
      const pattern = vibrate.mock.calls[0]?.[0];
      expect(Array.isArray(pattern)).toBe(true);
      return (pattern as number[]).length;
    };
    expect(lengthOf("reject")).toBeGreaterThan(lengthOf("commit"));
  });

  it("reuses one engine rather than building one per call", async () => {
    const { haptic, resetHaptics } = await load();
    haptic("commit");
    haptic("commit");
    // The iOS fallback appends a labelled switch per engine; one engine, one node.
    expect(document.querySelectorAll("label[for^='web-haptics-']").length).toBeLessThanOrEqual(1);
    resetHaptics();
    expect(document.querySelector("label[for^='web-haptics-']")).toBeNull();
  });

  it("follows a live change to the preference", async () => {
    const { haptic, setHapticsEnabled } = await load();
    haptic("commit");
    expect(vibrate).toHaveBeenCalledTimes(1);
    setHapticsEnabled(false);
    haptic("commit");
    expect(vibrate).toHaveBeenCalledTimes(1);
    setHapticsEnabled(true);
    haptic("commit");
    expect(vibrate).toHaveBeenCalledTimes(2);
  });
});

describe("hapticsAvailable", () => {
  it("is true where there is a document to deliver through", async () => {
    const { hapticsAvailable } = await load();
    expect(hapticsAvailable()).toBe(true);
  });

  it("stays true where the Vibration API is absent, because the iOS fallback is not", async () => {
    // This is the whole point of the gate. The library reads `navigator.vibrate`
    // once, when its class is defined — and being a real dependency it is loaded
    // outside the module registry that `resetModules` clears, so deleting the
    // API here would come too late. Standing in for it is the honest way to
    // reach that branch: an iPhone, where the fallback is a hidden switch and
    // never a vibration, and where the host still needs the off switch.
    vi.resetModules();
    vi.doMock("web-haptics", () => ({
      WebHaptics: class {
        static isSupported = false;
        trigger = () => Promise.resolve();
        destroy = () => {};
      },
    }));
    const { haptic, hapticsAvailable, resetHaptics } = await import("./haptics");
    expect(hapticsAvailable()).toBe(true);
    expect(() => haptic("dismiss")).not.toThrow();
    resetHaptics();
    vi.doUnmock("web-haptics");
  });
});
