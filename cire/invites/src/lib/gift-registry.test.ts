import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  claimGiftRegistryItem,
  fetchGiftRegistry,
  fetchGiftRegistryHousehold,
  formatGiftPrice,
  giftRegistryExternalHref,
  giftRegistryImageBase,
  giftRegistryRemaining,
  giftRegistryRemainingCopy,
  releaseGiftRegistryItem,
  sortGiftRegistryItems,
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
  it("reads the public list without credentials and without cache", async () => {
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
    // The public read must NOT carry the household cookie.
    expect(lastInit().credentials).toBeUndefined();
  });

  it("treats 404 as hidden — unpublished, unentitled and unknown-slug alike", async () => {
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
