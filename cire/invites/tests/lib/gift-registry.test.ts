import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  claimGiftRegistryItem,
  contributeGift,
  fetchGiftRegistryHousehold,
  formatGiftPrice,
  giftPageTitle,
  giftRegistryClaimedCopy,
  giftRegistryExternalHref,
  giftRegistryQuantityHint,
  giftRegistryRemaining,
  GIFT_REGISTRY_MAX_QUANTITY,
  groupGiftRegistryItems,
  hasGiftRegistryCategories,
  releaseGiftRegistryItem,
  type GiftRegistryHouseholdClaim,
} from "../../src/lib/gift-registry";
import type { GiftRegistryItem } from "../../src/lib/gift-registry-read";

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

  it("reads the preview refusal by its code, not by its status", async () => {
    // The organiser's preview session reads the list and may not write to it.
    fetchMock.mockResolvedValueOnce(json({ error: "preview_read_only" }, 403));
    expect(await claimGiftRegistryItem(API, SLUG, "gi-1")).toEqual({ kind: "preview" });
    fetchMock.mockResolvedValueOnce(json({ error: "preview_read_only" }, 403));
    expect(await releaseGiftRegistryItem(API, SLUG, "gi-1")).toEqual({ kind: "preview" });

    // The origin guard answers 403 too, and that is not a preview; nor is the
    // code on any other status.
    fetchMock.mockResolvedValueOnce(json({ error: "forbidden" }, 403));
    expect(await claimGiftRegistryItem(API, SLUG, "gi-1")).toEqual({ kind: "error" });
    fetchMock.mockResolvedValueOnce(json({ error: "preview_read_only" }, 500));
    expect(await claimGiftRegistryItem(API, SLUG, "gi-1")).toEqual({ kind: "error" });
  });
});

describe("releaseGiftRegistryItem", () => {
  it("DELETEs the claim credentialed", async () => {
    fetchMock.mockResolvedValueOnce(json({ ok: true }));
    expect(await releaseGiftRegistryItem(API, SLUG, "gi-1")).toEqual({ kind: "ok" });
    expect(lastUrl()).toBe(`${API}/api/invite/${SLUG}/registry/items/gi-1/claim`);
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
});

describe("the reserve-ceiling hint", () => {
  it("names the ceiling once someone else has taken some", () => {
    expect(giftRegistryQuantityHint(2, 3)).toBe("You can reserve up to 2.");
    expect(giftRegistryQuantityHint(1, 3)).toBe("You can reserve 1.");
  });

  it("says nothing where the ceiling IS what the couple asked for", () => {
    // Nothing has been taken, so the number is not a surprise and repeating it
    // explains nothing. A single-quantity gift lives here, and most gifts are
    // single-quantity — a hint on every form is a hint nobody reads.
    expect(giftRegistryQuantityHint(1, 1)).toBeNull();
    expect(giftRegistryQuantityHint(3, 3)).toBeNull();
  });

  it("still speaks where the claim cap bites below the couple's ask", () => {
    // A row asking for more than any one claim may carry. The ceiling is real
    // and is not the couple's number, so it is explained like any other.
    expect(giftRegistryQuantityHint(GIFT_REGISTRY_MAX_QUANTITY, 200)).toBe(
      "You can reserve up to 99.",
    );
  });

  it("says nothing below 1, where there is no form to be in", () => {
    expect(giftRegistryQuantityHint(0, 2)).toBeNull();
    expect(giftRegistryQuantityHint(-2, 2)).toBeNull();
    expect(giftRegistryQuantityHint(Number.NaN, 2)).toBeNull();
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

/**
 * THE GIFT LIST'S OWN PAGE — the pure parts of it.
 *
 * What it is called, and how a whole list is read out in one line. All of it has to hold without a DOM, because the page's shell is Astro
 * (there is no Astro test harness in this workspace) and the shell is where the
 * heading, the title and the route all come from.
 */
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

/**
 * The "give money" call.
 *
 * Two properties, both silent when broken: without `credentials: "include"` the
 * host-scoped session cookie never leaves the browser and every attempt reads
 * as signed out; and a `url` that is not Stripe's own checkout is a full-page
 * navigation out of a payment flow to somewhere else entirely.
 */
describe("contributeGift", () => {
  it("carries the household cookie, and never caches", async () => {
    fetchMock.mockResolvedValueOnce(json({ url: "https://checkout.stripe.com/c/pay/cs_1" }));
    await contributeGift(API, SLUG, { amountMinor: 5000 });
    expect(lastUrl()).toBe(`${API}/api/invite/${SLUG}/registry/contribute`);
    expect(lastInit().credentials).toBe("include");
    expect(lastInit().cache).toBe("no-store");
    expect(lastInit().method).toBe("POST");
  });

  it("takes a Stripe checkout URL, and refuses anything else", async () => {
    fetchMock.mockResolvedValueOnce(json({ url: "https://checkout.stripe.com/c/pay/cs_1" }));
    expect(await contributeGift(API, SLUG, { amountMinor: 5000 })).toEqual({
      kind: "ok",
      url: "https://checkout.stripe.com/c/pay/cs_1",
    });

    for (const url of [
      "https://checkout.stripe.com.evil.test/c/pay/cs_1",
      "http://checkout.stripe.com/c/pay/cs_1",
      "javascript:alert(1)",
      "",
    ]) {
      fetchMock.mockResolvedValueOnce(json({ url }));
      expect(await contributeGift(API, SLUG, { amountMinor: 5000 })).toEqual({ kind: "error" });
    }
  });

  it("tells each refusal apart, because the guest can act on some of them", async () => {
    const cases: [number, unknown, unknown][] = [
      [401, { error: "Unauthorized" }, { kind: "signed-out" }],
      [409, { error: "cash_gifts_unavailable" }, { kind: "unavailable" }],
      [400, { error: "Missing or invalid fields" }, { kind: "invalid" }],
      [502, { error: "stripe_unavailable" }, { kind: "error" }],
      // The organiser's preview session may read the list and never give.
      [403, { error: "preview_read_only" }, { kind: "preview" }],
      // The origin guard's 403 is not a preview.
      [403, { error: "forbidden" }, { kind: "error" }],
    ];
    for (const [status, body, expected] of cases) {
      fetchMock.mockResolvedValueOnce(json(body, status));
      expect(await contributeGift(API, SLUG, { amountMinor: 5000 })).toEqual(expected);
    }
  });

  it("names a wait only when the server named one", async () => {
    fetchMock.mockResolvedValueOnce(json({}, 429, { "retry-after": "45" }));
    expect(await contributeGift(API, SLUG, { amountMinor: 5000 })).toEqual({
      kind: "rate-limited",
      retryAfterSeconds: 45,
    });
    fetchMock.mockResolvedValueOnce(json({}, 429));
    expect(await contributeGift(API, SLUG, { amountMinor: 5000 })).toEqual({
      kind: "rate-limited",
      retryAfterSeconds: null,
    });
  });
});
