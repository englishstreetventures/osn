import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  claimGiftRegistryItem,
  DEFAULT_GIFT_REGISTRY_EYEBROW,
  DEFAULT_GIFT_REGISTRY_HEADING,
  fetchGiftRegistry,
  fetchGiftRegistryHousehold,
  formatGiftPrice,
  giftPageTitle,
  giftRegistryAvailability,
  giftRegistryAvailabilityCopy,
  giftRegistryBody,
  giftRegistryClaimedCopy,
  giftRegistryExternalHref,
  giftRegistryEyebrow,
  giftRegistryHeading,
  giftRegistryImageBase,
  giftRegistryPath,
  giftRegistryRemaining,
  giftRegistryRemainingCopy,
  groupGiftRegistryItems,
  hasGiftRegistryCategories,
  releaseGiftRegistryItem,
  sortGiftRegistryItems,
  type GiftRegistryHouseholdClaim,
  type GiftRegistryItem,
} from "./gift-registry";

/**
 * The guest-side gift-registry client.
 *
 * The properties worth a test here are the ones that are silent when broken:
 * a dropped cookie mode reads as "signed out" forever with no error, a 409
 * folded into a generic failure reads as "something went wrong" when in fact
 * another guest took the last one, and an unchecked `external_url` is a script
 * sink that renders perfectly.
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

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

const realFetch = globalThis.fetch;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(async () => json({ ok: true }));
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

/** The init object the last `fetch` call was given. */
function lastInit(): RequestInit {
  return (fetchMock.mock.calls.at(-1)?.[1] ?? {}) as RequestInit;
}

function lastUrl(): string {
  return String(fetchMock.mock.calls.at(-1)?.[0]);
}

describe("fetchGiftRegistry", () => {
  it("reads the list with credentials and without cache", async () => {
    fetchMock.mockResolvedValueOnce(
      json({
        headline: null,
        message: null,
        cashGiftsEnabled: false,
        currency: "AUD",
        items: [],
      }),
    );

    const result = await fetchGiftRegistry(API, SLUG);

    expect(result).toEqual({
      kind: "ok",
      registry: {
        headline: null,
        message: null,
        cashGiftsEnabled: false,
        currency: "AUD",
        items: [],
      },
    });
    expect(lastUrl()).toBe(`${API}/api/invite/${SLUG}/registry`);
    expect(lastInit().cache).toBe("no-store");
    // The list is for the couple's guests, so the read carries the household
    // cookie — and `cire_session` is host-scoped to the API ORIGIN, a different
    // origin from the guest site, so on the default `same-origin` mode it is
    // dropped silently and every read reads as signed out forever.
    expect(lastInit().credentials).toBe("include");
  });

  it("treats 401 as signed out — a way in, not a failure", async () => {
    fetchMock.mockResolvedValueOnce(json({ error: "Unauthorized" }, 401));
    expect(await fetchGiftRegistry(API, SLUG)).toEqual({ kind: "signed-out" });
  });

  it("treats 404 as hidden — unpublished, unentitled, unknown-slug and another wedding alike", async () => {
    fetchMock.mockResolvedValueOnce(json({ error: "registry_not_found" }, 404));
    expect(await fetchGiftRegistry(API, SLUG)).toEqual({ kind: "hidden" });
  });

  it("returns an error value rather than throwing when the network fails", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("offline"));
    expect(await fetchGiftRegistry(API, SLUG)).toEqual({ kind: "error" });
  });

  it("percent-encodes the slug into the path", async () => {
    fetchMock.mockResolvedValueOnce(json({}, 404));
    await fetchGiftRegistry(API, "a b/c");
    expect(lastUrl()).toBe(`${API}/api/invite/a%20b%2Fc/registry`);
  });
});

describe("fetchGiftRegistryHousehold", () => {
  it("sends the household cookie cross-origin (credentials: include)", async () => {
    fetchMock.mockResolvedValueOnce(json({ claims: [] }));

    const result = await fetchGiftRegistryHousehold(API, SLUG);

    expect(result).toEqual({ kind: "ok", household: { claims: [] } });
    expect(lastUrl()).toBe(`${API}/api/invite/${SLUG}/registry/mine`);
    // Without this the API origin's HttpOnly cookie is dropped silently and
    // every guest reads as signed out.
    expect(lastInit().credentials).toBe("include");
    expect(lastInit().cache).toBe("no-store");
  });

  it("maps 401 to signed-out, not to an error", async () => {
    fetchMock.mockResolvedValueOnce(json({ error: "unauthorised" }, 401));
    expect(await fetchGiftRegistryHousehold(API, SLUG)).toEqual({ kind: "signed-out" });
  });

  it("maps 404 to hidden", async () => {
    fetchMock.mockResolvedValueOnce(json({ error: "registry_not_found" }, 404));
    expect(await fetchGiftRegistryHousehold(API, SLUG)).toEqual({ kind: "hidden" });
  });
});

describe("claimGiftRegistryItem", () => {
  it("POSTs the claim credentialed, as JSON", async () => {
    fetchMock.mockResolvedValueOnce(json({ ok: true }, 200));

    const result = await claimGiftRegistryItem(API, SLUG, "gi-1", {
      quantity: 2,
      note: "For the kitchen",
      displayName: null,
    });

    expect(result).toEqual({ kind: "ok" });
    expect(lastUrl()).toBe(`${API}/api/invite/${SLUG}/registry/items/gi-1/claim`);
    const init = lastInit();
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("include");
    expect(init.cache).toBe("no-store");
    expect(JSON.parse(String(init.body))).toEqual({
      quantity: 2,
      note: "For the kitchen",
      displayName: null,
    });
  });

  it("distinguishes the 409 race from every other failure", async () => {
    fetchMock.mockResolvedValueOnce(json({ error: "item_fully_claimed" }, 409));
    expect(await claimGiftRegistryItem(API, SLUG, "gi-1")).toEqual({ kind: "fully-claimed" });
  });

  it("does not inherit the race copy for an unrelated future 409", async () => {
    fetchMock.mockResolvedValueOnce(json({ error: "something_else" }, 409));
    expect(await claimGiftRegistryItem(API, SLUG, "gi-1")).toEqual({ kind: "error" });
  });

  it("tells a removed item apart from a closed registry on the same status", async () => {
    fetchMock.mockResolvedValueOnce(json({ error: "registry_item_not_found" }, 404));
    expect(await claimGiftRegistryItem(API, SLUG, "gi-1")).toEqual({ kind: "item-gone" });

    fetchMock.mockResolvedValueOnce(json({ error: "registry_not_found" }, 404));
    expect(await claimGiftRegistryItem(API, SLUG, "gi-1")).toEqual({ kind: "hidden" });
  });

  it("reports the rate limit with the server's retry-after in seconds", async () => {
    fetchMock.mockResolvedValueOnce(json({ error: "rate_limited" }, 429, { "retry-after": "60" }));
    expect(await claimGiftRegistryItem(API, SLUG, "gi-1")).toEqual({
      kind: "rate-limited",
      retryAfterSeconds: 60,
    });
  });

  it("reports a rate limit with no usable retry-after as null, never a guess", async () => {
    fetchMock.mockResolvedValueOnce(json({ error: "rate_limited" }, 429));
    expect(await claimGiftRegistryItem(API, SLUG, "gi-1")).toEqual({
      kind: "rate-limited",
      retryAfterSeconds: null,
    });

    // An HTTP-date `retry-after` is valid per the RFC but not a number: rather
    // than parse `"Wed"` as a duration, say nothing about how long.
    fetchMock.mockResolvedValueOnce(
      json({}, 429, { "retry-after": "Wed, 21 Oct 2026 07:28:00 GMT" }),
    );
    expect(await claimGiftRegistryItem(API, SLUG, "gi-1")).toEqual({
      kind: "rate-limited",
      retryAfterSeconds: null,
    });
  });

  it("maps 401 to signed-out and 400 to invalid", async () => {
    fetchMock.mockResolvedValueOnce(json({}, 401));
    expect(await claimGiftRegistryItem(API, SLUG, "gi-1")).toEqual({ kind: "signed-out" });

    fetchMock.mockResolvedValueOnce(json({}, 400));
    expect(await claimGiftRegistryItem(API, SLUG, "gi-1")).toEqual({ kind: "invalid" });
  });

  it("survives a non-JSON error body", async () => {
    fetchMock.mockResolvedValueOnce(new Response("<html>gateway</html>", { status: 409 }));
    expect(await claimGiftRegistryItem(API, SLUG, "gi-1")).toEqual({ kind: "error" });
  });
});

describe("releaseGiftRegistryItem", () => {
  it("DELETEs the claim credentialed", async () => {
    fetchMock.mockResolvedValueOnce(json({ ok: true }));
    expect(await releaseGiftRegistryItem(API, SLUG, "gi-1")).toEqual({ kind: "ok" });
    expect(lastInit().method).toBe("DELETE");
    expect(lastInit().credentials).toBe("include");
  });

  it("maps a release of an item that is gone", async () => {
    fetchMock.mockResolvedValueOnce(json({ error: "registry_item_not_found" }, 404));
    expect(await releaseGiftRegistryItem(API, SLUG, "gi-1")).toEqual({ kind: "item-gone" });
  });
});

describe("giftRegistryExternalHref", () => {
  it("accepts https and returns the parsed href", () => {
    expect(giftRegistryExternalHref("https://shop.example/pan")).toBe("https://shop.example/pan");
    expect(giftRegistryExternalHref("  https://shop.example/pan  ")).toBe(
      "https://shop.example/pan",
    );
  });

  it("rejects every non-https scheme, including the script sinks", () => {
    for (const raw of [
      "javascript:alert(1)",
      "JavaScript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "http://shop.example/pan",
      "vbscript:msgbox(1)",
      "file:///etc/passwd",
    ]) {
      expect(giftRegistryExternalHref(raw)).toBeNull();
    }
  });

  it("rejects embedded credentials, which disguise the real host", () => {
    expect(giftRegistryExternalHref("https://shop.example@evil.test/pan")).toBeNull();
    expect(giftRegistryExternalHref("https://user:pw@evil.test/pan")).toBeNull();
  });

  it("returns null for absent, blank and unparseable values", () => {
    expect(giftRegistryExternalHref(null)).toBeNull();
    expect(giftRegistryExternalHref(undefined)).toBeNull();
    expect(giftRegistryExternalHref("   ")).toBeNull();
    expect(giftRegistryExternalHref("not a url")).toBeNull();
  });
});

describe("counts", () => {
  it("subtracts claimed from wanted", () => {
    expect(giftRegistryRemaining(item({ quantityWanted: 3, quantityClaimed: 1 }))).toBe(2);
  });

  it("never goes negative, whatever the row says", () => {
    expect(giftRegistryRemaining(item({ quantityWanted: 1, quantityClaimed: 4 }))).toBe(0);
  });

  it("says counts and only counts", () => {
    expect(giftRegistryRemainingCopy(item({ quantityWanted: 2, quantityClaimed: 1 }))).toBe(
      "1 of 2 left",
    );
    expect(giftRegistryRemainingCopy(item({ quantityWanted: 1, quantityClaimed: 0 }))).toBe(
      "Available",
    );
    expect(giftRegistryRemainingCopy(item({ quantityWanted: 2, quantityClaimed: 2 }))).toBe(
      "All reserved",
    );
  });
});

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

describe("formatGiftPrice", () => {
  it("renders a two-decimal currency from minor units", () => {
    // Locale-dependent symbol placement, so assert the digits, not the glyph.
    expect(formatGiftPrice(12_500, "AUD")).toContain("125.00");
  });

  it("honours the real minor-unit exponent instead of dividing by 100", () => {
    // JPY has no minor unit: 1000 minor units is ¥1000, not ¥10.
    expect(formatGiftPrice(1000, "JPY")).toContain("1,000");
    expect(formatGiftPrice(1000, "JPY")).not.toContain("10.00");
    // KWD uses three.
    expect(formatGiftPrice(1000, "KWD")).toContain("1.000");
  });

  it("renders no price at all when the item has none", () => {
    expect(formatGiftPrice(null, "AUD")).toBeNull();
  });

  it("degrades to a bare amount for a currency Intl cannot build", () => {
    expect(formatGiftPrice(12_500, "!!")).toBe("125.00");
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

/**
 * THE GIFT LIST'S OWN PAGE — the pure parts of it.
 *
 * Where it lives, what it is called, and how a whole list is read out in one
 * line. All of it has to hold without a DOM, because the page's shell is Astro
 * (there is no Astro test harness in this workspace) and the shell is where the
 * heading, the title and the route all come from.
 */
describe("giftRegistryPath", () => {
  it("points at the wedding's own gift page", () => {
    expect(giftRegistryPath("anita-and-ben")).toBe("/anita-and-ben/registry");
  });

  it("encodes a slug that would otherwise change the URL's shape", () => {
    // A slug is organiser input. Unencoded, `../` climbs out of the wedding and
    // `?`/`#` truncate the path — a link that silently goes somewhere else.
    expect(giftRegistryPath("a b")).toBe("/a%20b/registry");
    expect(giftRegistryPath("../other")).toBe("/..%2Fother/registry");
    expect(giftRegistryPath("a?b#c")).toBe("/a%3Fb%23c/registry");
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

describe("giftPageTitle", () => {
  it("names the couple first, like the invite's own title", () => {
    expect(giftPageTitle("Gift Registry", "Anita & Ben")).toBe("Anita & Ben — Gift Registry");
  });

  it("stands on the heading alone when the couple set no title", () => {
    expect(giftPageTitle("Gift Registry", null)).toBe("Gift Registry");
    expect(giftPageTitle("Gift Registry", "")).toBe("Gift Registry");
  });
});

describe("the ledger line", () => {
  it("counts quantities, not rows", () => {
    // One row for six glasses is six gifts to a guest, and five of them are
    // still something they can act on.
    const items = [
      item({ id: "a", quantityWanted: 6, quantityClaimed: 1 }),
      item({ id: "b", quantityWanted: 1, quantityClaimed: 0 }),
    ];
    expect(giftRegistryAvailability(items)).toEqual({ available: 6, total: 7 });
    expect(giftRegistryAvailabilityCopy(items)).toBe("6 of 7 still available");
  });

  it("says nothing at all about an empty list", () => {
    // An empty published list has its own copy; "0 of 0" is not a summary.
    expect(giftRegistryAvailabilityCopy([])).toBeNull();
  });

  it("has its own words for a list with nothing left", () => {
    expect(giftRegistryAvailabilityCopy([item({ quantityWanted: 2, quantityClaimed: 2 })])).toBe(
      "Every gift has been reserved",
    );
  });

  it("survives a row that says something impossible", () => {
    // Over-claimed and negative rows exist (a restored backup, a migration).
    // The one line that summarises the page must not print a negative number.
    const items = [
      item({ id: "a", quantityWanted: 1, quantityClaimed: 4 }),
      item({ id: "b", quantityWanted: -3, quantityClaimed: 0 }),
    ];
    expect(giftRegistryAvailability(items)).toEqual({ available: 0, total: 1 });
  });

  it("counts this household's own reservations, and names no one", () => {
    const claim = (quantity: number): GiftRegistryHouseholdClaim => ({
      itemId: "gi-1",
      quantity,
      status: "reserved",
      note: null,
      displayName: "The Ashworths",
    });
    expect(giftRegistryClaimedCopy([])).toBeNull();
    expect(giftRegistryClaimedCopy([claim(1)])).toBe("You reserved 1 gift");
    expect(giftRegistryClaimedCopy([claim(1), claim(2)])).toBe("You reserved 3 gifts");
    // Same clamp, and the same reason, as the availability line above: a
    // restored backup or a migration can hand this a negative quantity, and
    // "You reserved -1 gifts" is not a thing to print on a ledger.
    expect(giftRegistryClaimedCopy([claim(-2), claim(3)])).toBe("You reserved 3 gifts");
  });
});

describe("groupGiftRegistryItems", () => {
  it("keeps the couple's categories in the order the list already carries", () => {
    // First mention wins; nothing is alphabetised behind their back.
    const groups = groupGiftRegistryItems([
      item({ id: "a", category: "Kitchen" }),
      item({ id: "b", category: "Bedroom" }),
      item({ id: "c", category: "Kitchen" }),
    ]);
    expect(groups.map((group) => group.category)).toEqual(["Kitchen", "Bedroom"]);
    expect(groups[0]?.items.map((i) => i.id)).toEqual(["a", "c"]);
  });

  it("puts everything ungrouped in one tail, last", () => {
    const groups = groupGiftRegistryItems([
      item({ id: "a", category: null }),
      item({ id: "b", category: "Kitchen" }),
      item({ id: "c", category: "   " }),
    ]);
    expect(groups.map((group) => group.category)).toEqual(["Kitchen", null]);
    expect(groups[1]?.items.map((i) => i.id)).toEqual(["a", "c"]);
  });

  it("trims a category, so the same shelf under two spellings is one shelf", () => {
    const groups = groupGiftRegistryItems([
      item({ id: "a", category: "Kitchen" }),
      item({ id: "b", category: " Kitchen " }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.category).toBe("Kitchen");
  });

  it("reports whether any shelf is worth labelling", () => {
    // One unlabelled group is a plain list — heading it "More gifts" would name
    // a distinction the couple never made.
    expect(hasGiftRegistryCategories(groupGiftRegistryItems([item({ category: null })]))).toBe(
      false,
    );
    expect(hasGiftRegistryCategories(groupGiftRegistryItems([item({ category: "Kitchen" })]))).toBe(
      true,
    );
    expect(hasGiftRegistryCategories([])).toBe(false);
  });
});
