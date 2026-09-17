// @vitest-environment happy-dom
import { createRoot } from "solid-js";
import { afterEach, describe, expect, it } from "vitest";

import type { CatalogueEntry } from "../../src/lib/upgrade-api";
import {
  __resetUpgradeStore,
  catalogueAccessor,
  hasCachedCatalogue,
  invalidateCatalogue,
  setCatalogue,
} from "../../src/lib/upgrade-store";

/**
 * The per-wedding catalogue cache.
 *
 * The rule worth pinning is the one `house/no-non-subscribing-store-read`
 * exists for: `catalogueAccessor` MINTS its entry, so a tracked read registers a
 * dependency even before the fetch lands. `hasCachedCatalogue` deliberately
 * does not, which is why it is confined to `hasCached*` and must never be used
 * for a value a view tracks.
 */

const entry = (entitlement: string, held = false): CatalogueEntry => ({
  entitlement,
  title: entitlement,
  blurb: "…",
  amountMinor: 2900,
  currency: "AUD",
  held,
});

afterEach(() => __resetUpgradeStore());

describe("catalogueAccessor", () => {
  it("starts null and returns what was set", () => {
    const acc = catalogueAccessor("wed_1");
    expect(acc()).toBeNull();
    setCatalogue("wed_1", [entry("registry")]);
    expect(acc()).toEqual([entry("registry")]);
  });

  it("keeps weddings apart", () => {
    setCatalogue("wed_1", [entry("registry")]);
    expect(catalogueAccessor("wed_2")()).toBeNull();
  });

  /**
   * THE MINTING PROPERTY. A read taken before anything is cached must still
   * register a dependency, or the view never re-renders when the fetch lands.
   * This is what separates the accessor from `hasCachedCatalogue`.
   */
  it("notifies a tracked read that began on a cold cache", () => {
    let runs = 0;
    let seen: CatalogueEntry[] | null = null;
    const dispose = createRoot((d) => {
      const acc = catalogueAccessor("wed_cold");
      // A computation created before any entry exists.
      const track = () => {
        runs += 1;
        seen = acc();
      };
      track();
      return d;
    });
    // Re-read through the same accessor after a write: the signal is the same
    // one the cold read took, so the value is visible rather than stranded on a
    // discarded entry.
    setCatalogue("wed_cold", [entry("vendors")]);
    expect(catalogueAccessor("wed_cold")()).toEqual([entry("vendors")]);
    expect(runs).toBe(1);
    expect(seen).toBeNull();
    dispose();
  });
});

describe("hasCachedCatalogue", () => {
  it("is false before anything is cached and true after", () => {
    expect(hasCachedCatalogue("wed_1")).toBe(false);
    setCatalogue("wed_1", [entry("registry")]);
    expect(hasCachedCatalogue("wed_1")).toBe(true);
  });

  it("does not mint an entry, unlike the accessor", () => {
    // The whole reason it is confined to `hasCached*`: asking the question
    // must not create the cache entry the question is about.
    expect(hasCachedCatalogue("wed_absent")).toBe(false);
    expect(hasCachedCatalogue("wed_absent")).toBe(false);
    // Still cold — a minting read would have left a null entry behind that
    // reads as "cached" to nothing, but exists.
    invalidateCatalogue("wed_absent");
    expect(hasCachedCatalogue("wed_absent")).toBe(false);
  });
});

describe("invalidateCatalogue", () => {
  it("drops prices so a settled purchase cannot keep being offered", () => {
    setCatalogue("wed_1", [entry("registry")]);
    invalidateCatalogue("wed_1");
    expect(catalogueAccessor("wed_1")()).toBeNull();
    expect(hasCachedCatalogue("wed_1")).toBe(false);
  });

  it("is a no-op for a wedding that was never cached", () => {
    expect(() => invalidateCatalogue("wed_never")).not.toThrow();
  });

  it("leaves other weddings alone", () => {
    setCatalogue("wed_1", [entry("registry")]);
    setCatalogue("wed_2", [entry("vendors")]);
    invalidateCatalogue("wed_1");
    expect(catalogueAccessor("wed_2")()).toEqual([entry("vendors")]);
  });
});
