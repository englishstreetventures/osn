import { describe, expect, it } from "vitest";

import {
  ENVELOPE_ATTR,
  ENVELOPE_BOOT_SCRIPT,
  ENVELOPE_CAPABLE_ATTR,
  ENVELOPE_KEY_ATTR,
  ENVELOPE_WATCHDOG_MS,
  seenStorageKey,
} from "../src/boot";

const KEY = "a".repeat(64);

/** A stand-in `<html>` holding attributes in a map. */
function fakeRoot(attrs: Record<string, string> = {}) {
  const map = new Map(Object.entries(attrs));
  return {
    map,
    getAttribute: (name: string) => map.get(name) ?? null,
    setAttribute: (name: string, value: string) => void map.set(name, value),
    removeAttribute: (name: string) => void map.delete(name),
    hasAttribute: (name: string) => map.has(name),
  };
}

interface World {
  requestPaint: boolean;
  webgl2: boolean;
  texElementSubImage2D: boolean;
  reducedMotion: boolean;
  key: string | null;
  search: string;
  stored: Record<string, string>;
  /** The storage throws on every read and write. */
  storageThrows: boolean;
  /** `matchMedia` throws, standing for anything the script calls that fails. */
  matchMediaThrows: boolean;
}

const CAPABLE: World = {
  requestPaint: true,
  webgl2: true,
  texElementSubImage2D: true,
  reducedMotion: false,
  key: KEY,
  search: "?slug=envelope-wedding",
  stored: {},
  storageThrows: false,
  matchMediaThrows: false,
};

/**
 * Runs the boot string itself, as the browser does before first paint, with
 * every global it may read passed in. Timers are queued, not run, so a test
 * decides when the watchdog fires.
 */
function boot(overrides: Partial<World> = {}) {
  const world = { ...CAPABLE, ...overrides };
  const root = fakeRoot(world.key === null ? {} : { [ENVELOPE_KEY_ATTR]: world.key });
  const stored = new Map(Object.entries(world.stored));
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const canvasProto = world.requestPaint ? { requestPaint() {} } : {};
  const glProto = world.texElementSubImage2D ? { texElementSubImage2D() {} } : {};
  const WebGL2 = world.webgl2
    ? Object.assign(function WebGL2() {}, { prototype: glProto })
    : undefined;
  const storage = {
    getItem(k: string) {
      if (world.storageThrows) throw new Error("SecurityError");
      return stored.get(k) ?? null;
    },
    setItem(k: string, v: string) {
      if (world.storageThrows) throw new Error("SecurityError");
      stored.set(k, v);
    },
  };
  const globals: Record<string, unknown> = {
    document: { documentElement: root },
    HTMLCanvasElement: { prototype: canvasProto },
    WebGL2RenderingContext: WebGL2,
    matchMedia: (query: string) => {
      if (world.matchMediaThrows) throw new Error("not supported");
      return { matches: query === "(prefers-reduced-motion: reduce)" && world.reducedMotion };
    },
    location: { search: world.search },
    localStorage: storage,
    URLSearchParams,
    setTimeout: (fn: () => void, ms: number) => timers.push({ fn, ms }),
  };
  const names = Object.keys(globals);
  // The string is the unit under test; running it is the only honest check.
  // oxlint-disable-next-line no-new-func
  new Function(...names, ENVELOPE_BOOT_SCRIPT)(...names.map((n) => globals[n]));
  return {
    root,
    stored,
    sealed: () => root.getAttribute(ENVELOPE_ATTR) === "sealed",
    capable: () => root.hasAttribute(ENVELOPE_CAPABLE_ATTR),
    fireTimers: () => {
      for (const t of timers.splice(0)) t.fn();
    },
    timers,
  };
}

describe("ENVELOPE_BOOT_SCRIPT", () => {
  it("seals the page when the API, WebGL2, full motion, a key and no seen flag all hold", () => {
    const run = boot();
    expect(run.sealed()).toBe(true);
    expect(run.capable()).toBe(true);
  });

  it.each([
    ["requestPaint is missing", { requestPaint: false }],
    ["WebGL2RenderingContext is missing", { webgl2: false }],
    ["texElementSubImage2D is missing", { texElementSubImage2D: false }],
    ["the device asks for reduced motion", { reducedMotion: true }],
  ] as const)("sets nothing when %s", (_name, world) => {
    const run = boot(world);
    expect([run.sealed(), run.capable()]).toEqual([false, false]);
  });

  it.each([
    ["there is no key", { key: null }],
    ["the link carries ?code=", { search: "?slug=envelope-wedding&code=ABC-DEF" }],
    ["the guest has opened it", { stored: { [seenStorageKey(KEY)]: "1" } }],
    ["the opening failed here before", { stored: { [seenStorageKey(KEY)]: "failed" } }],
  ] as const)("is capable but does not seal when %s", (_name, world) => {
    const run = boot(world);
    expect([run.sealed(), run.capable()]).toEqual([false, true]);
  });

  it("does not seal when reading the seen flag throws", () => {
    const run = boot({ storageThrows: true });
    expect(run.sealed()).toBe(false);
  });

  it("leaves the page unsealed when anything it calls throws", () => {
    const run = boot({ matchMediaThrows: true });
    expect(run.sealed()).toBe(false);
    expect(run.timers).toEqual([]);
  });

  it("reads the seen flag under this key only", () => {
    const run = boot({ stored: { [seenStorageKey("b".repeat(64))]: "1" } });
    expect(run.sealed()).toBe(true);
  });

  it("?envelope=1 overrides ?code= and the seen flag", () => {
    const run = boot({
      search: "?slug=envelope-wedding&code=ABC-DEF&envelope=1",
      stored: { [seenStorageKey(KEY)]: "1" },
    });
    expect(run.sealed()).toBe(true);
  });

  it.each([
    ["a missing API", { requestPaint: false }],
    ["reduced motion", { reducedMotion: true }],
    ["a missing key", { key: null }],
  ] as const)("?envelope=1 never overrides %s", (_name, world) => {
    expect(boot({ ...world, search: "?envelope=1" }).sealed()).toBe(false);
  });

  it("removes a cover still sealed when the watchdog fires, and marks the opening failed", () => {
    const run = boot();
    expect(run.timers.map((t) => t.ms)).toEqual([ENVELOPE_WATCHDOG_MS]);
    run.fireTimers();
    expect(run.root.hasAttribute(ENVELOPE_ATTR)).toBe(false);
    expect(run.stored.get(seenStorageKey(KEY))).toBe("failed");
  });

  it("leaves a revealed envelope alone when the watchdog fires", () => {
    const run = boot();
    run.root.setAttribute(ENVELOPE_ATTR, "ready");
    run.fireTimers();
    expect(run.root.getAttribute(ENVELOPE_ATTR)).toBe("ready");
    expect(run.stored.has(seenStorageKey(KEY))).toBe(false);
  });

  it("starts no watchdog when it does not seal", () => {
    expect(boot({ key: null }).timers).toEqual([]);
  });
});
