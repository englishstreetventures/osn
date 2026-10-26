import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fetchGiftRegistry } from "../../src/lib/gift-registry-read";

/**
 * The gift list's one read — the call every claimed guest's invitation makes,
 * and the one the band's own download waits on.
 *
 * Worth a test because it is silent when broken: a dropped cookie mode reads as
 * "signed out" forever with no error, and a 404 read as anything but "hidden"
 * would put a band on a wedding with no list.
 */

const API = "https://api.test";
const SLUG = "anita-and-ben";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
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
