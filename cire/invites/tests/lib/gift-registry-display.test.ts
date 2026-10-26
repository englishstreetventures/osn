import { describe, expect, it } from "vitest";

import {
  DEFAULT_GIFT_REGISTRY_EYEBROW,
  DEFAULT_GIFT_REGISTRY_HEADING,
  giftRegistryBody,
  giftRegistryEyebrow,
  giftRegistryHeading,
  giftRegistryImageBase,
  giftRegistryPath,
  sortGiftRegistryItems,
} from "../../src/lib/gift-registry-display";
import type { GiftRegistryItem } from "../../src/lib/gift-registry-read";

/**
 * What the gift list looks like on the invitation's band and on its own page:
 * its order, its picture URLs, where its page lives and its section copy. All
 * of it has to hold without a DOM, because the page's shell is Astro (there is
 * no Astro test harness in this workspace) and the shell is where the heading
 * and the route come from.
 */

const API = "https://api.test";
const SLUG = "anita-and-ben";

function item(overrides: Partial<GiftRegistryItem> = {}): GiftRegistryItem {
  return {
    id: "gi-1",
    kind: "product",
    title: "Copper pan",
    description: null,
    imageName: null,
    imageCrop: null,
    externalUrl: null,
    priceMinor: null,
    quantityWanted: 1,
    quantityClaimed: 0,
    category: null,
    sortOrder: 0,
    ...overrides,
  };
}

describe("sortGiftRegistryItems", () => {
  it("orders by sortOrder, then id, and copies rather than mutating", () => {
    const input = [
      item({ id: "c", sortOrder: 1 }),
      item({ id: "a", sortOrder: 2 }),
      item({ id: "b", sortOrder: 1 }),
    ];
    const sorted = sortGiftRegistryItems(input);
    expect(sorted.map((i) => i.id)).toEqual(["b", "c", "a"]);
    expect(input.map((i) => i.id)).toEqual(["c", "a", "b"]);
  });
});

describe("giftRegistryImageBase", () => {
  it("builds the route URL with no variant, and encodes the name", () => {
    expect(giftRegistryImageBase(API, SLUG, "registry-abc")).toBe(
      `${API}/api/invite/${SLUG}/registry/image/registry-abc`,
    );
    expect(giftRegistryImageBase(API, SLUG, "a/b")).toBe(
      `${API}/api/invite/${SLUG}/registry/image/a%2Fb`,
    );
  });
});

describe("giftRegistryPath", () => {
  it("points at the wedding's own gift page", () => {
    expect(giftRegistryPath("anita-and-ben")).toBe("/cire/registry?slug=anita-and-ben");
  });

  it("encodes a slug that would otherwise change the URL's shape", () => {
    // Query encoding preserves slugs that include URL punctuation.
    expect(giftRegistryPath("a b")).toBe("/cire/registry?slug=a%20b");
    expect(giftRegistryPath("../other")).toBe("/cire/registry?slug=..%2Fother");
    expect(giftRegistryPath("a?b#c")).toBe("/cire/registry?slug=a%3Fb%23c");
  });
});

describe("the section copy", () => {
  it("prefers the invite's own copy, then the module's, then the built-in", () => {
    expect(giftRegistryHeading("Gifts", "Our List")).toBe("Gifts");
    expect(giftRegistryHeading(null, "Our List")).toBe("Our List");
    expect(giftRegistryHeading(null, null)).toBe(DEFAULT_GIFT_REGISTRY_HEADING);
    expect(giftRegistryEyebrow(null)).toBe(DEFAULT_GIFT_REGISTRY_EYEBROW);
    expect(giftRegistryEyebrow("Thank You")).toBe("Thank You");
    expect(giftRegistryBody("Invite copy", "Module copy")).toBe("Invite copy");
    expect(giftRegistryBody(null, "Module copy")).toBe("Module copy");
    expect(giftRegistryBody(null, null)).toBeNull();
  });

  /**
   * Blank is unset, not an answer. A `??` chain took the first NON-NULL value,
   * so a heading saved as `""` beat both the module's headline and the built-in
   * default — an empty `<h1>`, and on the gift page an empty browser tab.
   */
  it("treats blank copy as unset", () => {
    expect(giftRegistryHeading("   ", "Our List")).toBe("Our List");
    expect(giftRegistryHeading("", "")).toBe(DEFAULT_GIFT_REGISTRY_HEADING);
    expect(giftRegistryEyebrow("  ")).toBe(DEFAULT_GIFT_REGISTRY_EYEBROW);
    expect(giftRegistryBody("", "  ")).toBeNull();
  });
});
