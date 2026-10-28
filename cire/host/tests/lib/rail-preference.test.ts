// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  RAIL_PREFERENCE_KEY,
  readRailCollapsed,
  writeRailCollapsed,
} from "../../src/lib/rail-preference";

/**
 * The stored rail choice is a convenience. Every way storage can fail has to
 * land on the expanded rail, the portal's default, and never on an exception:
 * the sidebar reads it while it is being created, so a throw here would take the
 * whole module shell down with it.
 */

const realStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");

/** A storage whose named methods throw, standing in for the real one. Stubbed
 *  whole rather than spied on, so nothing of it outlives the test. */
function storageThatThrows(
  methods: readonly ("getItem" | "setItem" | "removeItem")[],
  stored: string | null = null,
): void {
  const fail = (name: string) => () => {
    throw new DOMException(`${name} refused`, "SecurityError");
  };
  vi.stubGlobal("localStorage", {
    getItem: methods.includes("getItem") ? fail("getItem") : () => stored,
    setItem: methods.includes("setItem") ? fail("setItem") : () => {},
    removeItem: methods.includes("removeItem") ? fail("removeItem") : () => {},
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  if (realStorage) Object.defineProperty(globalThis, "localStorage", realStorage);
  globalThis.localStorage.removeItem(RAIL_PREFERENCE_KEY);
});

describe("rail-preference", () => {
  it("reads expanded, and writes nothing, when reaching storage throws", () => {
    // Site data blocked by the browser: the `localStorage` getter itself throws
    // a SecurityError, which a `typeof localStorage` guard does not stop.
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() {
        throw new DOMException("The operation is insecure.", "SecurityError");
      },
    });
    expect(readRailCollapsed()).toBe(false);
    expect(() => writeRailCollapsed(true)).not.toThrow();
    expect(() => writeRailCollapsed(false)).not.toThrow();
  });

  it("reads expanded when there is no storage at all", () => {
    vi.stubGlobal("localStorage", undefined);
    expect(readRailCollapsed()).toBe(false);
    expect(() => writeRailCollapsed(true)).not.toThrow();
    expect(() => writeRailCollapsed(false)).not.toThrow();
  });

  it("reads expanded when a read throws", () => {
    storageThatThrows(["getItem"]);
    expect(readRailCollapsed()).toBe(false);
  });

  it("swallows a failed write in either direction", () => {
    // Quota, private mode: the read still works and says collapsed, so only
    // the writes are refused.
    storageThatThrows(["setItem", "removeItem"], "collapsed");
    expect(readRailCollapsed()).toBe(true);
    expect(() => writeRailCollapsed(true)).not.toThrow();
    expect(() => writeRailCollapsed(false)).not.toThrow();
  });

  it("reads expanded for any stored value but the one it writes", () => {
    for (const stale of ["true", "1", "Collapsed", "expanded", ""]) {
      globalThis.localStorage.setItem(RAIL_PREFERENCE_KEY, stale);
      expect(readRailCollapsed(), `stored ${JSON.stringify(stale)}`).toBe(false);
    }
  });

  it("forgets the choice when the rail is expanded again", () => {
    writeRailCollapsed(true);
    writeRailCollapsed(false);
    expect(readRailCollapsed()).toBe(false);
    expect(globalThis.localStorage.getItem(RAIL_PREFERENCE_KEY)).toBeNull();
  });
});
