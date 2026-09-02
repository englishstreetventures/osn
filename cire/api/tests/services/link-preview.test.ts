import { describe, it, expect } from "bun:test";

import { Cause, Effect, Exit, Option } from "effect";

import {
  isBlockedAddress,
  isIpLiteral,
  linkPreviewService,
  parseIpv4,
  parseIpv6,
  scanHtml,
} from "../../src/services/link-preview";
import type { HostResolver, LinkPreviewOptions } from "../../src/services/link-preview";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/** A resolver that answers every name with the same public address. */
const publicResolver: HostResolver = () => Promise.resolve(["93.184.216.34"]);

/** A resolver that must never be called — asserts a DoH round trip was skipped. */
function forbiddenResolver(): HostResolver {
  return () => {
    throw new Error("DoH resolver must not be called");
  };
}

function htmlResponse(body: string, init: ResponseInit = {}): Response {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
    ...init,
  });
}

/** Records every URL fetched, so a test can prove the guard never dialled one. */
function recordingFetch(handler: (url: string) => Response): {
  fetchImpl: typeof fetch;
  fetched: string[];
} {
  const fetched: string[] = [];
  const fetchImpl = ((input: string) => {
    fetched.push(input);
    return Promise.resolve(handler(input));
  }) as unknown as typeof fetch;
  return { fetchImpl, fetched };
}

/** Run the service and hand back the Exit, so failures stay values. */
const run = (url: string, options: LinkPreviewOptions) =>
  Effect.runPromiseExit(linkPreviewService.preview(url, options));

/**
 * The tag of a failed preview, or `null` if it succeeded.
 *
 * Reads the failure out of the Cause rather than catching, so a DEFECT (a thrown
 * exception escaping the service) shows up as a distinct string and fails the
 * assertion loudly instead of masquerading as the expected tag.
 */
function failureTag(exit: Exit.Exit<unknown, { readonly _tag: string }>): string | null {
  if (Exit.isSuccess(exit)) return null;
  const failure = Cause.failureOption(exit.cause);
  return Option.isSome(failure) ? failure.value._tag : `defect:${Cause.pretty(exit.cause)}`;
}

// ---------------------------------------------------------------------------
// Address parsing + range checks
// ---------------------------------------------------------------------------

describe("parseIpv4", () => {
  it("accepts a strict dotted quad", () => {
    expect(parseIpv4("127.0.0.1")).toEqual([127, 0, 0, 1]);
    expect(parseIpv4("255.255.255.255")).toEqual([255, 255, 255, 255]);
  });

  it("rejects leading zeros, shorthand and out-of-range octets", () => {
    // `0177.0.0.1` is octal loopback to some resolvers — a parser differential.
    expect(parseIpv4("0177.0.0.1")).toBeNull();
    expect(parseIpv4("010.0.0.1")).toBeNull();
    expect(parseIpv4("127.1")).toBeNull();
    expect(parseIpv4("256.0.0.1")).toBeNull();
    expect(parseIpv4(" 127.0.0.1")).toBeNull();
  });
});

describe("parseIpv6", () => {
  it("expands `::` and reads a dotted tail", () => {
    expect(parseIpv6("::1")?.slice(14)).toEqual([0, 1]);
    expect(parseIpv6("::ffff:127.0.0.1")?.slice(10)).toEqual([255, 255, 127, 0, 0, 1]);
    expect(parseIpv6("64:ff9b::10.0.0.1")?.slice(0, 4)).toEqual([0, 0x64, 0xff, 0x9b]);
  });

  it("rejects junk", () => {
    expect(parseIpv6("not-an-address")).toBeNull();
    expect(parseIpv6("1::2::3")).toBeNull();
    expect(parseIpv6("")).toBeNull();
  });
});

describe("isBlockedAddress", () => {
  it("blocks every non-public IPv4 range", () => {
    for (const address of [
      "0.0.0.0",
      "10.1.2.3",
      "127.0.0.1",
      "100.64.0.1",
      "169.254.169.254", // cloud metadata
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "224.0.0.1",
      "255.255.255.255",
    ]) {
      expect(isBlockedAddress(address)).toBe(true);
    }
  });

  it("allows public IPv4", () => {
    for (const address of ["93.184.216.34", "1.1.1.1", "8.8.8.8", "172.32.0.1", "172.15.0.1"]) {
      expect(isBlockedAddress(address)).toBe(false);
    }
  });

  it("blocks IPv6 loopback, ULA, link-local and multicast", () => {
    for (const address of ["::1", "::", "fc00::1", "fd12:3456::1", "fe80::1", "ff02::1"]) {
      expect(isBlockedAddress(address)).toBe(true);
    }
    expect(isBlockedAddress("2606:4700:4700::1111")).toBe(false);
  });

  it("unwraps IPv4-mapped IPv6 and applies the v4 rules", () => {
    expect(isBlockedAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isBlockedAddress("::ffff:169.254.169.254")).toBe(true);
    expect(isBlockedAddress("[::ffff:10.0.0.1]")).toBe(true);
    expect(isBlockedAddress("::ffff:93.184.216.34")).toBe(false);
  });

  it("unwraps NAT64 (64:ff9b::/96) and applies the v4 rules", () => {
    expect(isBlockedAddress("64:ff9b::127.0.0.1")).toBe(true);
    expect(isBlockedAddress("64:ff9b::169.254.169.254")).toBe(true);
    expect(isBlockedAddress("64:ff9b::93.184.216.34")).toBe(false);
  });

  it("blocks anything it cannot parse (fail closed)", () => {
    expect(isBlockedAddress("nonsense")).toBe(true);
    expect(isBlockedAddress("")).toBe(true);
  });
});

describe("isIpLiteral", () => {
  it("recognises v4 and bracketed v6 literals but not names", () => {
    expect(isIpLiteral("10.0.0.1")).toBe(true);
    expect(isIpLiteral("[::1]")).toBe(true);
    expect(isIpLiteral("shop.example")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Scheme rejection — layer 1
// ---------------------------------------------------------------------------

describe("preview — scheme guard", () => {
  it("rejects every non-https scheme without fetching or resolving", async () => {
    for (const url of [
      "http://shop.example/item",
      "data:text/html,<img src=x>",
      "javascript:alert(1)",
      "file:///etc/passwd",
      "ftp://shop.example/item",
      "gopher://shop.example/",
    ]) {
      const { fetchImpl, fetched } = recordingFetch(() => htmlResponse(""));
      const exit = await run(url, { fetchImpl, resolveHost: forbiddenResolver() });
      expect(failureTag(exit)).toBe("LinkPreviewBlocked");
      expect(fetched).toEqual([]);
    }
  });

  it("rejects an unparseable url", async () => {
    const { fetchImpl, fetched } = recordingFetch(() => htmlResponse(""));
    const exit = await run("not a url", { fetchImpl, resolveHost: forbiddenResolver() });
    expect(failureTag(exit)).toBe("LinkPreviewBlocked");
    expect(fetched).toEqual([]);
  });

  it("rejects embedded credentials", async () => {
    const { fetchImpl, fetched } = recordingFetch(() => htmlResponse(""));
    const exit = await run("https://shop.example@evil.example/x", {
      fetchImpl,
      resolveHost: forbiddenResolver(),
    });
    expect(failureTag(exit)).toBe("LinkPreviewBlocked");
    expect(fetched).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Address rejection — layer 2
// ---------------------------------------------------------------------------

describe("preview — address guard", () => {
  it("rejects a literal private-IP host with NO DoH round trip", async () => {
    for (const host of [
      "127.0.0.1",
      "169.254.169.254",
      "10.0.0.1",
      "[::1]",
      "[::ffff:127.0.0.1]",
    ]) {
      const { fetchImpl, fetched } = recordingFetch(() => htmlResponse(""));
      const exit = await run(`https://${host}/meta`, {
        fetchImpl,
        // Throws if touched: a literal address must be decided arithmetically.
        resolveHost: forbiddenResolver(),
      });
      expect(failureTag(exit)).toBe("LinkPreviewBlocked");
      expect(fetched).toEqual([]);
    }
  });

  it("fetches a literal PUBLIC-IP host without a DoH round trip", async () => {
    const { fetchImpl, fetched } = recordingFetch(() =>
      htmlResponse('<meta property="og:image" content="https://93.184.216.34/a.jpg">'),
    );
    const exit = await run("https://93.184.216.34/item", {
      fetchImpl,
      resolveHost: forbiddenResolver(),
    });
    expect(Exit.isSuccess(exit)).toBe(true);
    expect(fetched).toEqual(["https://93.184.216.34/item"]);
  });

  it("rejects a public hostname whose DNS answer is private", async () => {
    const { fetchImpl, fetched } = recordingFetch(() => htmlResponse(""));
    const exit = await run("https://rebind.example/item", {
      fetchImpl,
      resolveHost: () => Promise.resolve(["169.254.169.254"]),
    });
    expect(failureTag(exit)).toBe("LinkPreviewBlocked");
    expect(fetched).toEqual([]);
  });

  it("rejects when ANY answer in a mixed record set is private", async () => {
    const { fetchImpl, fetched } = recordingFetch(() => htmlResponse(""));
    const exit = await run("https://mixed.example/item", {
      fetchImpl,
      resolveHost: () => Promise.resolve(["93.184.216.34", "127.0.0.1"]),
    });
    expect(failureTag(exit)).toBe("LinkPreviewBlocked");
    expect(fetched).toEqual([]);
  });

  it("rejects an IPv4-mapped IPv6 answer", async () => {
    const { fetchImpl, fetched } = recordingFetch(() => htmlResponse(""));
    const exit = await run("https://mapped.example/item", {
      fetchImpl,
      resolveHost: () => Promise.resolve(["::ffff:169.254.169.254"]),
    });
    expect(failureTag(exit)).toBe("LinkPreviewBlocked");
    expect(fetched).toEqual([]);
  });

  it("rejects a NAT64 answer wrapping a private v4 address", async () => {
    const { fetchImpl, fetched } = recordingFetch(() => htmlResponse(""));
    const exit = await run("https://nat64.example/item", {
      fetchImpl,
      resolveHost: () => Promise.resolve(["64:ff9b::10.0.0.1"]),
    });
    expect(failureTag(exit)).toBe("LinkPreviewBlocked");
    expect(fetched).toEqual([]);
  });

  it("rejects a name that resolves to nothing (fail closed)", async () => {
    const { fetchImpl, fetched } = recordingFetch(() => htmlResponse(""));
    const exit = await run("https://nxdomain.example/item", {
      fetchImpl,
      resolveHost: () => Promise.resolve([]),
    });
    expect(failureTag(exit)).toBe("LinkPreviewBlocked");
    expect(fetched).toEqual([]);
  });

  it("rejects when the resolver itself throws", async () => {
    const { fetchImpl, fetched } = recordingFetch(() => htmlResponse(""));
    const exit = await run("https://broken.example/item", {
      fetchImpl,
      resolveHost: () => Promise.reject(new Error("dns down")),
    });
    expect(failureTag(exit)).toBe("LinkPreviewBlocked");
    expect(fetched).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Redirects — layer 3
// ---------------------------------------------------------------------------

describe("preview — redirects", () => {
  it("re-checks every hop: a benign host redirecting to the metadata service is refused", async () => {
    const { fetchImpl, fetched } = recordingFetch((url) => {
      if (url === "https://shop.example/item") {
        return new Response(null, {
          status: 302,
          headers: { location: "http://169.254.169.254/latest/meta-data/" },
        });
      }
      throw new Error(`SSRF: must not fetch ${url}`);
    });
    const exit = await run("https://shop.example/item", {
      fetchImpl,
      resolveHost: publicResolver,
    });
    expect(failureTag(exit)).toBe("LinkPreviewBlocked");
    // The first hop was fetched; the metadata address never was.
    expect(fetched).toEqual(["https://shop.example/item"]);
  });

  it("refuses an https hop whose NAME resolves privately", async () => {
    const { fetchImpl, fetched } = recordingFetch((url) => {
      if (url === "https://shop.example/item") {
        return new Response(null, {
          status: 301,
          headers: { location: "https://internal.example/admin" },
        });
      }
      throw new Error(`SSRF: must not fetch ${url}`);
    });
    const exit = await run("https://shop.example/item", {
      fetchImpl,
      resolveHost: (host) =>
        Promise.resolve(host === "internal.example" ? ["10.0.0.5"] : ["93.184.216.34"]),
    });
    expect(failureTag(exit)).toBe("LinkPreviewBlocked");
    expect(fetched).toEqual(["https://shop.example/item"]);
  });

  it("follows a relative Location against the current hop", async () => {
    const { fetchImpl, fetched } = recordingFetch((url) => {
      if (url === "https://shop.example/item") {
        return new Response(null, { status: 302, headers: { location: "/final" } });
      }
      return htmlResponse('<meta property="og:image" content="/hero.jpg">');
    });
    const exit = await run("https://shop.example/item", { fetchImpl, resolveHost: publicResolver });
    expect(Exit.isSuccess(exit)).toBe(true);
    expect(fetched).toEqual(["https://shop.example/item", "https://shop.example/final"]);
  });

  it("stops at the redirect cap rather than looping", async () => {
    const { fetchImpl, fetched } = recordingFetch(
      () => new Response(null, { status: 302, headers: { location: "https://shop.example/loop" } }),
    );
    const exit = await run("https://shop.example/start", {
      fetchImpl,
      resolveHost: publicResolver,
      maxRedirects: 3,
    });
    expect(failureTag(exit)).toBe("LinkPreviewFetchFailed");
    // maxRedirects = 3 → at most 4 attempts (hop 0..3).
    expect(fetched.length).toBeLessThanOrEqual(4);
  });

  it("treats a 3xx with no Location as a fetch failure", async () => {
    const { fetchImpl } = recordingFetch(() => new Response(null, { status: 302 }));
    const exit = await run("https://shop.example/item", { fetchImpl, resolveHost: publicResolver });
    expect(failureTag(exit)).toBe("LinkPreviewFetchFailed");
  });

  it("treats a non-2xx as a fetch failure", async () => {
    const { fetchImpl } = recordingFetch(() => new Response("nope", { status: 404 }));
    const exit = await run("https://shop.example/item", { fetchImpl, resolveHost: publicResolver });
    expect(failureTag(exit)).toBe("LinkPreviewFetchFailed");
  });

  it("treats a network error as a fetch failure, not a defect", async () => {
    const fetchImpl = (() =>
      Promise.reject(new Error("connection reset"))) as unknown as typeof fetch;
    const exit = await run("https://shop.example/item", { fetchImpl, resolveHost: publicResolver });
    expect(failureTag(exit)).toBe("LinkPreviewFetchFailed");
  });
});

// ---------------------------------------------------------------------------
// Caps — layer 4
// ---------------------------------------------------------------------------

describe("preview — caps", () => {
  it("rejects a non-html content type", async () => {
    for (const contentType of ["application/pdf", "image/png", "application/json"]) {
      const { fetchImpl } = recordingFetch(
        () => new Response("...", { status: 200, headers: { "content-type": contentType } }),
      );
      const exit = await run("https://shop.example/item", {
        fetchImpl,
        resolveHost: publicResolver,
      });
      expect(failureTag(exit)).toBe("LinkPreviewUnusableContent");
    }
  });

  it("accepts `text/html` with parameters", async () => {
    const { fetchImpl } = recordingFetch(
      () =>
        new Response('<meta property="og:image" content="https://cdn.example/a.jpg">', {
          status: 200,
          headers: { "content-type": "TEXT/HTML; charset=UTF-8" },
        }),
    );
    const exit = await run("https://shop.example/item", { fetchImpl, resolveHost: publicResolver });
    expect(Exit.isSuccess(exit)).toBe(true);
  });

  it("stops reading at the byte cap and cancels the stream", async () => {
    let pulls = 0;
    let cancelled = false;
    // A body that would stream forever — the cap must end it.
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        if (pulls > 10_000) {
          controller.close();
          return;
        }
        controller.enqueue(new TextEncoder().encode("x".repeat(1024)));
      },
      cancel() {
        cancelled = true;
      },
    });
    const fetchImpl = (() =>
      Promise.resolve(
        new Response(body, { status: 200, headers: { "content-type": "text/html" } }),
      )) as unknown as typeof fetch;

    const exit = await run("https://shop.example/item", {
      fetchImpl,
      resolveHost: publicResolver,
      maxBytes: 4096,
    });
    // Capped junk has no images — the point is that it TERMINATED.
    expect(failureTag(exit)).toBe("LinkPreviewNoImages");
    expect(cancelled).toBe(true);
    expect(pulls).toBeLessThan(20);
  });

  it("still parses the head of an oversized document", async () => {
    const head =
      '<title>Big Shop</title><meta property="og:image" content="https://cdn.example/a.jpg">';
    const { fetchImpl } = recordingFetch(() => htmlResponse(head + "y".repeat(200_000)));
    const exit = await run("https://shop.example/item", {
      fetchImpl,
      resolveHost: publicResolver,
      maxBytes: 8192,
    });
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) {
      expect(exit.value.title).toBe("Big Shop");
      expect(exit.value.imageUrls).toEqual(["https://cdn.example/a.jpg"]);
    }
  });
});

// ---------------------------------------------------------------------------
// Parsing + ranking
// ---------------------------------------------------------------------------

describe("scanHtml", () => {
  it("ranks social-card images ahead of link rel=image_src and body <img>", () => {
    const scanned = scanHtml(`
      <html><head>
        <title>Fallback title</title>
        <meta property="og:title" content="Copper Pan">
        <meta property="og:site_name" content="Kitchen Co">
        <link rel="image_src" href="https://cdn.example/legacy.jpg">
        <meta name="twitter:image" content="https://cdn.example/twitter.jpg">
        <meta property="og:image" content="https://cdn.example/og.jpg">
      </head><body>
        <img src="https://cdn.example/body-1.jpg">
        <img src="https://cdn.example/body-2.jpg">
      </body></html>
    `);
    expect(scanned.title).toBe("Copper Pan");
    expect(scanned.siteName).toBe("Kitchen Co");
    expect(scanned.candidates.map((c) => c.rank)).toEqual([0, 0, 1, 2, 2]);
    // Within the top band, document order is preserved (twitter before og here).
    expect(scanned.candidates[0]?.url).toBe("https://cdn.example/twitter.jpg");
    expect(scanned.candidates[2]?.url).toBe("https://cdn.example/legacy.jpg");
  });

  it("falls back through og:title → twitter:title → <title>", () => {
    expect(scanHtml("<title>Plain</title>").title).toBe("Plain");
    expect(
      scanHtml('<title>Plain</title><meta name="twitter:title" content="Twitter">').title,
    ).toBe("Twitter");
  });

  it("decodes entities and collapses whitespace in the title", () => {
    expect(scanHtml("<title>  Bob &amp;\n  Jane&#39;s   list </title>").title).toBe(
      "Bob & Jane's list",
    );
  });

  it("drops <img> that declare themselves tiny", () => {
    const scanned = scanHtml(
      '<img src="https://cdn.example/pixel.gif" width="1" height="1">' +
        '<img src="https://cdn.example/hero.jpg" width="800" height="600">',
    );
    expect(scanned.candidates.map((c) => c.url)).toEqual(["https://cdn.example/hero.jpg"]);
  });

  it("reads single-quoted and unquoted attributes", () => {
    const scanned = scanHtml(`<meta property='og:image' content=https://cdn.example/a.jpg>`);
    expect(scanned.candidates[0]?.url).toBe("https://cdn.example/a.jpg");
  });

  it("returns nothing for a document with no tags of interest", () => {
    const scanned = scanHtml("<p>hello</p>");
    expect(scanned.title).toBeNull();
    expect(scanned.siteName).toBeNull();
    expect(scanned.candidates).toEqual([]);
  });

  it("scans a flood of unterminated tags in linear time", () => {
    // P-C1. The URL is attacker-chosen, so the document is too, and the old
    // patterns backtracked quadratically on an opening tag that never closes:
    // half a megabyte of `<img ` measured ~25s of CPU against a 10ms budget on
    // Cloudflare's free tier. Each shape is padded near the byte cap the fetch
    // allows, so this is the worst input the service can actually be handed.
    const flood = (open: string) => open.repeat(Math.floor(500_000 / open.length));
    for (const open of ["<title", "<meta ", "<img "]) {
      const started = Date.now();
      const scanned = scanHtml(flood(open));
      expect(Date.now() - started).toBeLessThan(500);
      expect(scanned.candidates).toEqual([]);
    }
  });

  it("still reads a title out of a very large page", () => {
    // The linear patterns must not have bought their speed by giving up on real
    // documents — a long page with a title at the top still yields it.
    const scanned = scanHtml(`<title>Nice Vase</title>${"<p>filler</p>".repeat(30_000)}`);
    expect(scanned.title).toBe("Nice Vase");
  });

  it("stops collecting <img> candidates well before a page can list a thousand", () => {
    // P-W1: only six URLs are ever emitted, and social-card candidates outrank
    // every `<img>`, so a cap on rank-2 collection cannot change the output —
    // it only stops the scan from scaling with a page's tag count.
    const imgs = Array.from(
      { length: 400 },
      (_, i) => `<img src="https://cdn.example/${i}.jpg" width="600">`,
    ).join("");
    const scanned = scanHtml(imgs);
    expect(scanned.candidates.length).toBeLessThanOrEqual(32);
    expect(scanned.candidates.slice(0, 3).map((c) => c.url)).toEqual([
      "https://cdn.example/0.jpg",
      "https://cdn.example/1.jpg",
      "https://cdn.example/2.jpg",
    ]);
  });

  it("keeps a social-card image no matter how many <img> precede it", () => {
    const imgs = Array.from(
      { length: 400 },
      (_, i) => `<img src="https://cdn.example/${i}.jpg" width="600">`,
    ).join("");
    const scanned = scanHtml(
      `${imgs}<meta property="og:image" content="https://cdn.example/card.jpg">`,
    );
    const ranked = [...scanned.candidates].sort((a, b) => a.rank - b.rank);
    expect(ranked[0]?.url).toBe("https://cdn.example/card.jpg");
  });
});

// ---------------------------------------------------------------------------
// Candidate URLs — layer 5
// ---------------------------------------------------------------------------

describe("preview — image candidates", () => {
  it("absolute-ises a relative src against the FINAL url, not the input url", async () => {
    const { fetchImpl } = recordingFetch((url) => {
      if (url === "https://short.example/p/1") {
        return new Response(null, {
          status: 301,
          headers: { location: "https://shop.example/catalog/pan" },
        });
      }
      return htmlResponse('<img src="../images/pan.jpg" width="600">');
    });
    const exit = await run("https://short.example/p/1", { fetchImpl, resolveHost: publicResolver });
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) {
      // Resolved against https://shop.example/catalog/pan, NOT short.example.
      expect(exit.value.imageUrls).toEqual(["https://shop.example/images/pan.jpg"]);
    }
  });

  it("drops javascript:, data: and http: candidates", async () => {
    const { fetchImpl } = recordingFetch(() =>
      htmlResponse(
        '<meta property="og:image" content="javascript:alert(1)">' +
          '<meta name="twitter:image" content="data:image/png;base64,iVBORw0KGgo=">' +
          '<img src="http://cdn.example/insecure.jpg" width="600">' +
          '<img src="https://cdn.example/good.jpg" width="600">',
      ),
    );
    const exit = await run("https://shop.example/item", { fetchImpl, resolveHost: publicResolver });
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) {
      expect(exit.value.imageUrls).toEqual(["https://cdn.example/good.jpg"]);
    }
  });

  it("drops a candidate whose host resolves privately", async () => {
    const { fetchImpl } = recordingFetch(() =>
      htmlResponse(
        '<meta property="og:image" content="https://internal.example/secret.png">' +
          '<img src="https://cdn.example/good.jpg" width="600">',
      ),
    );
    const exit = await run("https://shop.example/item", {
      fetchImpl,
      resolveHost: (host) =>
        Promise.resolve(host === "internal.example" ? ["192.168.1.5"] : ["93.184.216.34"]),
    });
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) {
      expect(exit.value.imageUrls).toEqual(["https://cdn.example/good.jpg"]);
    }
  });

  it("drops a candidate pointing at a private IP literal", async () => {
    const { fetchImpl } = recordingFetch(() =>
      htmlResponse(
        '<img src="https://169.254.169.254/latest.png" width="600">' +
          '<img src="https://cdn.example/good.jpg" width="600">',
      ),
    );
    const exit = await run("https://shop.example/item", { fetchImpl, resolveHost: publicResolver });
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) {
      expect(exit.value.imageUrls).toEqual(["https://cdn.example/good.jpg"]);
    }
  });

  it("dedupes and caps the list at six", async () => {
    const imgs = Array.from(
      { length: 12 },
      (_, i) => `<img src="https://cdn.example/${i}.jpg" width="600">`,
    ).join("");
    const { fetchImpl } = recordingFetch(() =>
      htmlResponse(`<img src="https://cdn.example/0.jpg" width="600">${imgs}`),
    );
    const exit = await run("https://shop.example/item", { fetchImpl, resolveHost: publicResolver });
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) {
      expect(exit.value.imageUrls).toEqual([
        "https://cdn.example/0.jpg",
        "https://cdn.example/1.jpg",
        "https://cdn.example/2.jpg",
        "https://cdn.example/3.jpg",
        "https://cdn.example/4.jpg",
        "https://cdn.example/5.jpg",
      ]);
    }
  });

  it("emits the same six urls from a page listing hundreds of images", async () => {
    // P-W1: the rank-2 cap changes what the scanner COLLECTS, never what the
    // preview emits.
    const imgs = Array.from(
      { length: 300 },
      (_, i) => `<img src="https://cdn.example/${i}.jpg" width="600">`,
    ).join("");
    const { fetchImpl } = recordingFetch(() => htmlResponse(imgs));
    const exit = await run("https://shop.example/item", { fetchImpl, resolveHost: publicResolver });
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) {
      expect(exit.value.imageUrls).toEqual([
        "https://cdn.example/0.jpg",
        "https://cdn.example/1.jpg",
        "https://cdn.example/2.jpg",
        "https://cdn.example/3.jpg",
        "https://cdn.example/4.jpg",
        "https://cdn.example/5.jpg",
      ]);
    }
  });

  it("resolves each image host at most once", async () => {
    const hosts: string[] = [];
    const imgs = Array.from(
      { length: 5 },
      (_, i) => `<img src="https://cdn.example/${i}.jpg" width="600">`,
    ).join("");
    const { fetchImpl } = recordingFetch(() => htmlResponse(imgs));
    await run("https://shop.example/item", {
      fetchImpl,
      resolveHost: (host) => {
        hosts.push(host);
        return Promise.resolve(["93.184.216.34"]);
      },
    });
    expect(hosts).toEqual(["shop.example", "cdn.example"]);
  });

  it("resolves distinct image hosts at the same time, not one after another", async () => {
    // P-W3: the checks used to run in series inside the emit loop, so six hosts
    // cost six round trips end to end. Ordering is unchanged — only the waiting is.
    let inFlight = 0;
    let peak = 0;
    const imgs = ["a", "b", "c"]
      .map((h) => `<img src="https://${h}.example/x.jpg" width="600">`)
      .join("");
    const { fetchImpl } = recordingFetch(() => htmlResponse(imgs));
    const exit = await run("https://shop.example/item", {
      fetchImpl,
      resolveHost: () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        return new Promise((resolve) => {
          setTimeout(() => {
            inFlight -= 1;
            resolve(["93.184.216.34"]);
          }, 10);
        });
      },
    });
    expect(peak).toBeGreaterThanOrEqual(3);
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) {
      expect(exit.value.imageUrls).toEqual([
        "https://a.example/x.jpg",
        "https://b.example/x.jpg",
        "https://c.example/x.jpg",
      ]);
    }
  });

  it("aborts an in-flight DNS lookup when the operation's budget expires", async () => {
    // P-W3: the lookups now share the preview's one time budget instead of
    // running beside it with only their own per-query timeout.
    let aborted = false;
    const { fetchImpl } = recordingFetch(() =>
      htmlResponse('<img src="https://cdn.example/a.jpg" width="600">'),
    );
    const exit = await run("https://shop.example/item", {
      fetchImpl,
      timeoutMs: 50,
      resolveHost: (host, signal) => {
        if (host === "shop.example") return Promise.resolve(["93.184.216.34"]);
        return new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => {
            aborted = true;
            reject(new Error("aborted"));
          });
        });
      },
    });
    expect(aborted).toBe(true);
    expect(failureTag(exit)).toBe("LinkPreviewNoImages");
  });

  it("fails with NoImages when a real page offers none we can use", async () => {
    const { fetchImpl } = recordingFetch(() =>
      htmlResponse("<title>Bare</title><p>no pictures</p>"),
    );
    const exit = await run("https://shop.example/item", { fetchImpl, resolveHost: publicResolver });
    expect(failureTag(exit)).toBe("LinkPreviewNoImages");
  });

  it("falls back to the final host when the page names no site", async () => {
    const { fetchImpl } = recordingFetch((url) => {
      if (url === "https://short.example/p") {
        return new Response(null, { status: 302, headers: { location: "https://shop.example/x" } });
      }
      return htmlResponse('<title>Pan</title><img src="https://cdn.example/a.jpg" width="600">');
    });
    const exit = await run("https://short.example/p", { fetchImpl, resolveHost: publicResolver });
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) {
      expect(exit.value.siteName).toBe("shop.example");
      expect(exit.value.title).toBe("Pan");
    }
  });
});
