// @vitest-environment happy-dom
/**
 * What is worth testing here is the *gate*, not the waveform.
 *
 * No test environment can feel a vibration, and happy-dom has no Vibration API
 * at all — so `web-haptics` decides at class-definition time that it is
 * unsupported and falls back to clicking a hidden switch. The vibrate spy below
 * is therefore installed before the library is ever imported, which is the only
 * moment its `static isSupported` is read.
 *
 * The contract asserted: nothing fires when haptics are off, each semantic name
 * maps to exactly one preset pattern, a set plays only the names it was made
 * with, and importing the module touches neither `navigator` nor the document
 * until something is triggered.
 *
 * The keys are placeholders: each portal passes its own, and its own
 * `tests/lib/` holds that it reads and writes those and no others.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const KEYS = { themeKey: "test.theme", hapticsKey: "test.haptics" };
const EVERY_NAME = ["commit", "reject", "pickup", "step", "dismiss"] as const;

/** A fresh library, preferences and haptics set against whatever `navigator.vibrate` is now. */
async function load() {
  vi.resetModules();
  const { createPreferences } = await import("../../src/lib/theme");
  const { createHaptics } = await import("../../src/lib/haptics");
  const preferences = createPreferences(KEYS);
  const haptics = createHaptics({ enabled: preferences.hapticsEnabled, names: EVERY_NAME });
  return { ...haptics, ...preferences, createHaptics };
}

/**
 * Stands in for `web-haptics` on the next import: records each engine built
 * (by its options), each one destroyed and each one that played, by the order
 * it was built in.
 */
function mockEngine() {
  const engines = { built: [] as unknown[], destroyed: [] as number[], played: [] as number[] };
  vi.resetModules();
  vi.doMock("web-haptics", () => ({
    WebHaptics: class {
      readonly id: number;
      constructor(options: unknown) {
        this.id = engines.built.push(options) - 1;
      }
      trigger = () => {
        engines.played.push(this.id);
        return Promise.resolve();
      };
      destroy = () => {
        engines.destroyed.push(this.id);
      };
    },
  }));
  return engines;
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
  vi.doUnmock("web-haptics");
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("haptic", () => {
  it("fires nothing at all when haptics are off", async () => {
    const { haptic, setHapticsEnabled } = await load();
    setHapticsEnabled(false);
    haptic("commit");
    haptic("reject");
    expect(vibrate).not.toHaveBeenCalled();
  });

  it("gives each name its own pattern", async () => {
    const { haptic } = await load();
    const patterns = new Map<string, unknown>();
    for (const name of ["commit", "reject", "pickup", "step", "dismiss"] as const) {
      vibrate.mockClear();
      haptic(name);
      expect(vibrate).toHaveBeenCalledTimes(1);
      patterns.set(name, JSON.stringify(vibrate.mock.calls[0]?.[0]));
    }
    expect(new Set(patterns.values()).size).toBe(patterns.size);
  });

  it("keeps `commit` and `reject` distinguishable by length, not just by feel", async () => {
    // Success is two taps and error is three. A host who cannot see the screen
    // — mid-drag, phone in one hand — should be able to tell them apart.
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

  it("plays nothing for a name the set was not made with", async () => {
    const { createHaptics } = await load();
    const three = createHaptics({ enabled: () => true, names: ["commit", "reject", "dismiss"] });
    // Cast past the type, as a stored or computed name could be.
    three.haptic("pickup" as "commit");
    three.haptic("step" as "commit");
    expect(vibrate).not.toHaveBeenCalled();
    three.haptic("dismiss");
    expect(vibrate).toHaveBeenCalledTimes(1);
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

describe("createHaptics", () => {
  it("keeps each set's engine its own, so one set's reset leaves another playing", async () => {
    const engines = mockEngine();
    const { createHaptics } = await import("../../src/lib/haptics");
    const one = createHaptics({ enabled: () => true, names: EVERY_NAME });
    const two = createHaptics({ enabled: () => true, names: EVERY_NAME });
    one.haptic("commit");
    two.haptic("commit");
    expect(engines.built).toHaveLength(2);
    one.resetHaptics();
    expect(engines.destroyed).toEqual([0]);
    two.haptic("reject");
    expect(engines.built).toHaveLength(2);
    expect(engines.played.at(-1)).toBe(1);
    two.resetHaptics();
  });
});

describe("the engine", () => {
  it("is built once per set, with no visible switch, and destroyed on reset", async () => {
    const engines = mockEngine();
    const { createHaptics } = await import("../../src/lib/haptics");
    const set = createHaptics({ enabled: () => true, names: EVERY_NAME });
    expect(engines.built).toEqual([]);
    set.haptic("commit");
    set.haptic("step");
    expect(engines.built).toEqual([{ showSwitch: false }]);
    set.resetHaptics();
    expect(engines.destroyed).toEqual([0]);
    set.haptic("commit");
    expect(engines.built).toHaveLength(2);
  });
});

describe("hapticsAvailable", () => {
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
    const { createHaptics } = await import("../../src/lib/haptics");
    const { haptic, hapticsAvailable, resetHaptics } = createHaptics({
      enabled: () => true,
      names: EVERY_NAME,
    });
    expect(hapticsAvailable()).toBe(true);
    expect(() => haptic("dismiss")).not.toThrow();
    resetHaptics();
  });
});
