import { describe, it, expect } from "bun:test";

import { canonicalizePinterestBoardUrl, isPinItHost, resolvePinUrl } from "./pinterest-resolve";

describe("canonicalizePinterestBoardUrl", () => {
  it("passes a board URL through, normalised to www + trailing slash", () => {
    expect(canonicalizePinterestBoardUrl("https://www.pinterest.com/user/board")).toBe(
      "https://www.pinterest.com/user/board/",
    );
    expect(canonicalizePinterestBoardUrl("https://pinterest.com/user/board/")).toBe(
      "https://www.pinterest.com/user/board/",
    );
  });

  it("keeps the `www.` prefix collapsed (no double www)", () => {
    expect(canonicalizePinterestBoardUrl("https://www.pinterest.com.au/u/b")).toBe(
      "https://www.pinterest.com.au/u/b/",
    );
  });

  it("strips ALL query params and fragments (tracking)", () => {
    expect(
      canonicalizePinterestBoardUrl("https://www.pinterest.com/user/board/?utm_source=share&x=1"),
    ).toBe("https://www.pinterest.com/user/board/");
    expect(canonicalizePinterestBoardUrl("https://pinterest.com/user/board#notes")).toBe(
      "https://www.pinterest.com/user/board/",
    );
  });

  it("accepts a board with a section sub-segment", () => {
    expect(canonicalizePinterestBoardUrl("https://pinterest.com/user/board/section")).toBe(
      "https://www.pinterest.com/user/board/section/",
    );
  });

  it("accepts supported regional TLDs", () => {
    expect(canonicalizePinterestBoardUrl("https://pinterest.co.uk/u/b")).toBe(
      "https://www.pinterest.co.uk/u/b/",
    );
  });

  it("rejects a pin.it short link as the FINAL location", () => {
    expect(canonicalizePinterestBoardUrl("https://pin.it/abc123")).toBeNull();
    expect(canonicalizePinterestBoardUrl("https://www.pin.it/abc123")).toBeNull();
  });

  it("rejects a non-pinterest host", () => {
    expect(canonicalizePinterestBoardUrl("https://evil.com/user/board")).toBeNull();
    expect(canonicalizePinterestBoardUrl("https://pinterest.com.evil.com/user/board")).toBeNull();
  });

  it("rejects a single pin (/pin/<id>) — a pin is not a board", () => {
    expect(canonicalizePinterestBoardUrl("https://pinterest.com/pin/123456789")).toBeNull();
    expect(canonicalizePinterestBoardUrl("https://www.pinterest.com/pin/123/")).toBeNull();
  });

  it("rejects a profile-only URL", () => {
    expect(canonicalizePinterestBoardUrl("https://pinterest.com/user")).toBeNull();
    expect(canonicalizePinterestBoardUrl("https://pinterest.com/")).toBeNull();
  });

  it("rejects non-https and unparseable input", () => {
    expect(canonicalizePinterestBoardUrl("http://pinterest.com/user/board")).toBeNull();
    expect(canonicalizePinterestBoardUrl("not a url")).toBeNull();
    expect(canonicalizePinterestBoardUrl("")).toBeNull();
  });

  it("rejects whitespace in a path segment", () => {
    expect(canonicalizePinterestBoardUrl("https://pinterest.com/user/board%20name")).toBeNull();
  });
});

describe("isPinItHost", () => {
  it("matches pin.it and www.pin.it exactly (case-insensitive)", () => {
    expect(isPinItHost("pin.it")).toBe(true);
    expect(isPinItHost("www.pin.it")).toBe(true);
    expect(isPinItHost("PIN.IT")).toBe(true);
  });

  it("rejects lookalikes (SSRF allowlist)", () => {
    expect(isPinItHost("pin.it.evil.com")).toBe(false);
    expect(isPinItHost("evilpin.it")).toBe(false);
    expect(isPinItHost("pinterest.com")).toBe(false);
  });
});

describe("resolvePinUrl", () => {
  it("returns a non-pin.it URL unchanged WITHOUT fetching (SSRF allowlist)", async () => {
    let called = false;
    const fetchImpl = (() => {
      called = true;
      return Promise.reject(new Error("should not fetch"));
    }) as unknown as typeof fetch;
    const url = "https://pinterest.com/user/board";
    expect(await resolvePinUrl(url, { fetchImpl })).toBe(url);
    expect(called).toBe(false);
  });

  it("returns an unparseable URL unchanged without fetching", async () => {
    const fetchImpl = (() =>
      Promise.reject(new Error("should not fetch"))) as unknown as typeof fetch;
    expect(await resolvePinUrl("not a url", { fetchImpl })).toBe("not a url");
  });

  it("follows a redirect from pin.it to a canonical board URL", async () => {
    const fetchImpl = ((input: string) => {
      if (input === "https://pin.it/abc123") {
        return Promise.resolve(
          new Response(null, {
            status: 301,
            headers: { location: "https://www.pinterest.com/user/board/?utm=share" },
          }),
        );
      }
      throw new Error(`unexpected fetch: ${input}`);
    }) as unknown as typeof fetch;
    expect(await resolvePinUrl("https://pin.it/abc123", { fetchImpl })).toBe(
      "https://www.pinterest.com/user/board/",
    );
  });

  it("keeps the original pin.it URL when the final location is a single pin", async () => {
    const fetchImpl = (() =>
      Promise.resolve(
        new Response(null, {
          status: 302,
          headers: { location: "https://www.pinterest.com/pin/12345/" },
        }),
      )) as unknown as typeof fetch;
    expect(await resolvePinUrl("https://pin.it/xyz", { fetchImpl })).toBe("https://pin.it/xyz");
  });

  it("keeps the original pin.it URL when a redirect leaves the allowlist, WITHOUT fetching it (SSRF)", async () => {
    const fetched: string[] = [];
    const fetchImpl = ((input: string) => {
      fetched.push(input);
      if (input === "https://pin.it/xyz") {
        return Promise.resolve(
          new Response(null, { status: 302, headers: { location: "https://evil.com/anything" } }),
        );
      }
      throw new Error(`SSRF: must not fetch off-allowlist host ${input}`);
    }) as unknown as typeof fetch;
    expect(await resolvePinUrl("https://pin.it/xyz", { fetchImpl })).toBe("https://pin.it/xyz");
    // Only the first-party pin.it short link is ever fetched; evil.com is not.
    expect(fetched).toEqual(["https://pin.it/xyz"]);
  });

  it("never fetches a private/metadata host a pin.it link tries to redirect to (SSRF)", async () => {
    for (const target of [
      "http://169.254.169.254/latest/meta-data/",
      "https://10.0.0.1/internal",
      "http://localhost:8787/admin",
    ]) {
      const fetched: string[] = [];
      const fetchImpl = ((input: string) => {
        fetched.push(input);
        if (input === "https://pin.it/ssrf") {
          return Promise.resolve(
            new Response(null, { status: 301, headers: { location: target } }),
          );
        }
        throw new Error(`SSRF: must not fetch ${input}`);
      }) as unknown as typeof fetch;
      expect(await resolvePinUrl("https://pin.it/ssrf", { fetchImpl })).toBe("https://pin.it/ssrf");
      expect(fetched).toEqual(["https://pin.it/ssrf"]);
    }
  });

  it("does not fetch a plain-http pin.it input (https-only allowlist)", async () => {
    const fetchImpl = (() =>
      Promise.reject(new Error("should not fetch http")) as unknown) as typeof fetch;
    expect(await resolvePinUrl("http://pin.it/abc", { fetchImpl })).toBe("http://pin.it/abc");
  });

  it("falls back to the original URL on a fetch error", async () => {
    const fetchImpl = (() => Promise.reject(new Error("network down"))) as unknown as typeof fetch;
    expect(await resolvePinUrl("https://pin.it/xyz", { fetchImpl })).toBe("https://pin.it/xyz");
  });

  it("caps redirect depth and falls back to original on a redirect loop", async () => {
    let hops = 0;
    const fetchImpl = (() => {
      hops++;
      return Promise.resolve(
        new Response(null, {
          status: 302,
          // Always redirects to another pin.it — never lands on a board.
          headers: { location: "https://pin.it/loop" },
        }),
      );
    }) as unknown as typeof fetch;
    expect(await resolvePinUrl("https://pin.it/start", { fetchImpl, maxRedirects: 3 })).toBe(
      "https://pin.it/start",
    );
    // maxRedirects=3 → at most 4 attempts (hop 0..3).
    expect(hops).toBeLessThanOrEqual(4);
  });

  it("canonicalises a terminal (non-redirect) board response", async () => {
    const fetchImpl = ((input: string) => {
      // pin.it returns the board directly with a 200 (no redirect).
      if (input === "https://pin.it/direct") {
        return Promise.resolve(new Response("ok", { status: 200 }));
      }
      throw new Error(`unexpected: ${input}`);
    }) as unknown as typeof fetch;
    // The terminal URL is still pin.it, which is not a board → keep original.
    expect(await resolvePinUrl("https://pin.it/direct", { fetchImpl })).toBe(
      "https://pin.it/direct",
    );
  });
});
