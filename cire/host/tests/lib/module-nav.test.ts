import { describe, expect, it } from "vitest";

import { MODULES, type Module } from "../../src/lib/dashboard-route";
import { isModuleLocked, MODULE_NAV, moduleDef } from "../../src/lib/module-nav";

/**
 * The nav table and the lock predicate every surface reads — the rail, the
 * sheet, the command palette and the Overview cards all decide what to show
 * from these two exports, so a wrong answer here is wrong in four places at
 * once.
 */
describe("MODULE_NAV", () => {
  it("has an entry for every module in the route grammar", () => {
    // Two independent lists with nothing in the type system tying them
    // together: a module priced and routed but forgotten here would fall back
    // to Overview's entry, which carries no lock — so it would silently be
    // reachable. This is the only thing that catches that.
    expect(MODULE_NAV.map((mod) => mod.id)).toEqual([...MODULES]);
  });

  it("gives every module its own icon", () => {
    // Two modules sharing a mark is the failure the icons exist to prevent:
    // the rail stops telling them apart at a glance, and Overview's agenda —
    // which borrows these by module — would mark two kinds of row alike.
    const icons = MODULE_NAV.map((mod) => mod.icon);
    expect(icons.every((icon) => typeof icon === "function")).toBe(true);
    expect(new Set(icons).size).toBe(MODULE_NAV.length);
  });

  it("gates exactly the two paid modules", () => {
    const gated = MODULE_NAV.filter((mod) => mod.lock !== undefined).map((mod) => mod.id);
    expect(gated).toEqual(["vendors", "registry"]);
  });

  it("names a real entitlement key on every lock, with copy to show", () => {
    for (const mod of MODULE_NAV) {
      if (!mod.lock) continue;
      // The key is what `isModuleLocked` compares against the wedding's rows;
      // a typo here locks the module for everyone, for ever, with no error.
      expect(mod.lock.entitlement, `${mod.id} lock key`).toBe(mod.id);
      expect(mod.lock.title.length, `${mod.id} lock title`).toBeGreaterThan(0);
      expect(mod.lock.blurb.length, `${mod.id} lock blurb`).toBeGreaterThan(0);
    }
  });
});

describe("isModuleLocked", () => {
  it("locks a gated module the wedding has no row for", () => {
    expect(isModuleLocked("vendors", [])).toBe(true);
    expect(isModuleLocked("registry", [])).toBe(true);
  });

  it("unlocks a gated module once its own key is held", () => {
    expect(isModuleLocked("vendors", ["vendors"])).toBe(false);
    expect(isModuleLocked("registry", ["registry"])).toBe(false);
  });

  it("reads only its own key, not the size of the entitlement set", () => {
    // A wedding on a paid plan still has no claim on a module it did not buy.
    const other = ["premium_templates", "ai", "capacity_1000", "registry"];
    expect(isModuleLocked("vendors", other)).toBe(true);
    expect(isModuleLocked("registry", other)).toBe(false);
  });

  it("never locks an ungated module, whatever the wedding holds", () => {
    for (const mod of MODULE_NAV) {
      if (mod.lock) continue;
      expect(isModuleLocked(mod.id, []), `${mod.id} with no entitlements`).toBe(false);
    }
  });

  it("treats an unknown module as unlocked, because `moduleDef` falls back to Overview", () => {
    // Not a wish — a statement of what the code does, so the fallback is a
    // decision on the record rather than a surprise. `Module` makes this
    // unreachable from typed code; the assertion above ("an entry for every
    // module") is what keeps it unreachable in practice.
    const unknown = "gifts-received" as Module;
    expect(moduleDef(unknown)).toBe(MODULE_NAV[0]);
    expect(isModuleLocked(unknown, [])).toBe(false);
  });
});
