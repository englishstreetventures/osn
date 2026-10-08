import { describe, expect, it } from "vitest";

import { MODULES, type Module } from "../../src/lib/dashboard-route";
import { isModuleLocked, MODULE_NAV, moduleDef } from "../../src/lib/module-nav";
import { TIERS } from "../../src/lib/tiers";

const PAID_TIERS = TIERS.filter((tier) => tier !== "ivory");

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

  it("gates the Gold modules and the Crimson module, and nothing else", () => {
    const gated = Object.fromEntries(
      MODULE_NAV.filter((mod) => mod.lock !== undefined).map((mod) => [mod.id, mod.lock!.tier]),
    );
    // The same split as the API's tier gate: budget, the checklist and the
    // registry at Gold, vendors at Crimson. A module that disagrees would be
    // offered to a wedding the API then answers 402.
    expect(gated).toEqual({
      checklist: "gold",
      budget: "gold",
      registry: "gold",
      vendors: "crimson",
    });
  });

  it("never ends the nav on a locked module", () => {
    // The locked row's card hands Tab from its last button to the row and lets
    // the browser carry on to the next one (`onCardKeyDown` in
    // `ModuleSidebar.tsx`). A locked last row would have no next one.
    expect(MODULE_NAV.at(-1)?.lock).toBeUndefined();
  });

  it("names a paid tier on every lock, with copy to show", () => {
    for (const mod of MODULE_NAV) {
      if (!mod.lock) continue;
      // The tier is what `isModuleLocked` ranks the wedding's against; a value
      // that is not a paid tier locks the module for everyone, or no one.
      expect(PAID_TIERS, `${mod.id} lock tier`).toContain(mod.lock.tier);
      expect(mod.lock.title.length, `${mod.id} lock title`).toBeGreaterThan(0);
      expect(mod.lock.blurb.length, `${mod.id} lock blurb`).toBeGreaterThan(0);
    }
  });
});

describe("isModuleLocked", () => {
  it("locks every gated module on Ivory", () => {
    for (const id of ["checklist", "budget", "registry", "vendors"] as const) {
      expect(isModuleLocked(id, "ivory"), `${id} on Ivory`).toBe(true);
    }
  });

  it("opens the Gold modules on Gold and keeps Vendors locked", () => {
    expect(isModuleLocked("checklist", "gold")).toBe(false);
    expect(isModuleLocked("budget", "gold")).toBe(false);
    expect(isModuleLocked("registry", "gold")).toBe(false);
    expect(isModuleLocked("vendors", "gold")).toBe(true);
  });

  it("opens everything on Crimson, because a higher tier includes the lower", () => {
    for (const mod of MODULE_NAV) {
      expect(isModuleLocked(mod.id, "crimson"), `${mod.id} on Crimson`).toBe(false);
    }
  });

  it("never locks an ungated module, whatever the tier", () => {
    for (const mod of MODULE_NAV) {
      if (mod.lock) continue;
      for (const tier of TIERS) {
        expect(isModuleLocked(mod.id, tier), `${mod.id} on ${tier}`).toBe(false);
      }
    }
  });

  it("treats an unknown module as unlocked, because `moduleDef` falls back to Overview", () => {
    // Not a wish — a statement of what the code does, so the fallback is a
    // decision on the record rather than a surprise. `Module` makes this
    // unreachable from typed code; the assertion above ("an entry for every
    // module") is what keeps it unreachable in practice.
    const unknown = "gifts-received" as Module;
    expect(moduleDef(unknown)).toBe(MODULE_NAV[0]);
    expect(isModuleLocked(unknown, "ivory")).toBe(false);
  });
});
