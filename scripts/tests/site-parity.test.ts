// scripts/site-parity.ts asks a staged site's Worker (its spare host) and its
// Pages project (the production host) the same paths and reports where they
// differ. These drive it against built-site fixtures and an injected fetch.
// Cloudflare answering in a site's place is refused, not compared, and so is
// a `/` that does not answer both hosts as the site's own page.

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  differences,
  fillPattern,
  headerRules,
  redirectSources,
  runSiteParity,
  siteProbes,
  RETRY_MS,
  UNKNOWN_PATH,
} from "../site-parity";
import { CI_USER_AGENT } from "../smoke-check";

function build(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "site-parity-"));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

const HEADERS = `# security
/*
  X-Frame-Options: DENY
  Content-Security-Policy: default-src 'self'
/_astro/*
  Cache-Control: public, max-age=31536000, immutable
/fonts/:name.woff2
  ! Access-Control-Allow-Origin
https://cire-host.pages.dev/*
  X-Robots-Tag: noindex
`;

describe("what a site is asked", () => {
  test("SP1: header rules and redirect sources are read as the platform reads them", () => {
    expect(headerRules(HEADERS)).toEqual([
      { path: "/*", names: ["x-frame-options", "content-security-policy"] },
      { path: "/_astro/*", names: ["cache-control"] },
      { path: "/fonts/:name.woff2", names: ["access-control-allow-origin"] },
      { path: "https://cire-host.pages.dev/*", names: ["x-robots-tag"] },
    ]);
    expect(
      redirectSources("# old\n/old /new 301\n\n/blog/* /posts/:splat 302\n/* /index.html 200\n"),
    ).toEqual(["/old", "/blog/*", "/*"]);
  });

  test("SP1: a wildcard is filled from a file the build holds, and an index file asked as its directory", () => {
    const files = [
      "/_astro/app.abc.js",
      "/fonts/inter.woff2",
      "/index.html",
      "/privacy/index.html",
    ];
    expect(fillPattern("/_astro/*", files)).toBe("/_astro/app.abc.js");
    expect(fillPattern("/fonts/:name.woff2", files)).toBe("/fonts/inter.woff2");
    expect(fillPattern("/privacy/*", files)).toBe("/privacy/");
    expect(fillPattern("/about", files)).toBe("/about");
    expect(fillPattern("/missing/*", files)).toBeUndefined();
    expect(fillPattern("https://cire-host.pages.dev/*", files)).toBeUndefined();
  });

  test("SP1: `/`, an unknown path, musubi social's deep link, every rule and source; the fixed headers and every named one", () => {
    const root = build({
      "musubi/social/dist/_headers": HEADERS,
      "musubi/social/dist/_redirects": "/* /index.html 200\n",
      "musubi/social/dist/index.html": "<!doctype html>",
      "musubi/social/dist/_astro/app.abc.js": "",
    });
    const probes = siteProbes("osn_social", join(root, "musubi/social/dist"));
    // `/*` fills from the first file the build serves; `_headers` and
    // `_redirects` are config, never served.
    expect(probes.paths).toEqual(
      ["/", "/_astro/app.abc.js", "/site-parity-deep-link", UNKNOWN_PATH].toSorted(),
    );
    expect(probes.headers).toEqual([
      "access-control-allow-origin",
      "cache-control",
      "content-security-policy",
      "content-type",
      "referrer-policy",
      "x-content-type-options",
      "x-frame-options",
      "x-robots-tag",
    ]);
    expect(probes.unmatched).toEqual(["/fonts/:name.woff2", "https://cire-host.pages.dev/*"]);
  });
});

describe("comparing two answers", () => {
  const seen = (
    status: number,
    location: string | null,
    headers: Record<string, string | null>,
  ) => ({
    status,
    location,
    headers,
  });

  test("SP2: status, Location and each compared header", () => {
    const a = seen(200, null, { "cache-control": "public", "x-frame-options": "DENY" });
    expect(differences(a, a)).toEqual([]);
    expect(differences(a, seen(404, null, a.headers))).toEqual(["status"]);
    expect(differences(seen(301, "/new", {}), seen(301, "/other", {}))).toEqual(["location"]);
    expect(differences(a, seen(200, null, { ...a.headers, "x-frame-options": null }))).toEqual([
      "x-frame-options",
    ]);
  });

  test("SP3: a host that did not answer differs", () => {
    expect(differences({ error: "no answer" }, seen(200, null, {}))).toEqual(["answer"]);
    expect(differences({ error: "no answer" }, { error: "no answer" })).toEqual(["answer"]);
  });
});

describe("runSiteParity", () => {
  const SITES = {
    "cire/host/dist/_headers": "/*\n  X-Frame-Options: DENY\n",
    "cire/host/dist/index.html": "<!doctype html>",
    "cire/vendor/dist/index.html": "<!doctype html>",
    "cire/landing/dist/_redirects": "/start https://host.cireweddings.com/ 302\n",
    "cire/landing/dist/index.html": "<!doctype html>",
  };

  /** Each host answers alike, except where `differ` says. */
  function fakeHosts(
    differ: (url: string, asked: number) => Response | Error | undefined = () => undefined,
  ) {
    const calls: string[] = [];
    /** The user agent each call sent, in call order. */
    const agents: (string | null)[] = [];
    /** The Accept header each call sent, in call order. */
    const accepts: (string | null)[] = [];
    const fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      const asked = calls.filter((call) => call === url).length;
      calls.push(url);
      agents.push(new Headers(init?.headers).get("user-agent"));
      accepts.push(new Headers(init?.headers).get("accept"));
      expect(init?.redirect).toBe("manual");
      const special = differ(url, asked);
      if (special instanceof Error) throw special;
      if (special !== undefined) return special;
      const { origin, pathname } = new URL(url);
      if (pathname === "/start") {
        return new Response(null, {
          status: 302,
          headers: { location: "https://host.cireweddings.com/" },
        });
      }
      return new Response("<!doctype html>", {
        status: pathname === UNKNOWN_PATH ? 404 : 200,
        headers: {
          "content-type": "text/html; charset=utf-8",
          "x-frame-options": "DENY",
          "x-served-by": origin,
        },
      });
    };
    return { fetch: fetch as unknown as typeof globalThis.fetch, calls, agents, accepts };
  }

  async function parity(args: string[], hosts: ReturnType<typeof fakeHosts>, root = build(SITES)) {
    const lines: string[] = [];
    const slept: number[] = [];
    const out = join(root, "report.json");
    const code = await runSiteParity({
      args: [...args, "--out", out],
      root,
      fetch: hosts.fetch,
      out: (text) => lines.push(text),
      sleep: async (ms) => {
        slept.push(ms);
      },
    });
    return { code, output: lines.join(""), out, root, slept };
  }

  test("SP2: every staged cire site, each asked on its spare host and its production host; alike answers pass, and the report repeats byte for byte", async () => {
    const hosts = fakeHosts();
    const first = await parity(["--stack", "cire"], hosts);
    expect(first.code).toBe(0);
    const origins = [...new Set(hosts.calls.map((url) => new URL(url).origin))].toSorted();
    expect(origins).toEqual(
      [
        "https://next-host.cireweddings.com",
        "https://host.cireweddings.com",
        "https://next-vendor.cireweddings.com",
        "https://vendor.cireweddings.com",
        "https://next.cireweddings.com",
        "https://cireweddings.com",
      ].toSorted(),
    );
    expect(hosts.calls).toContain("https://next.cireweddings.com/start");
    const report = readFileSync(first.out, "utf8");
    const again = await parity(["--stack", "cire"], fakeHosts(), first.root);
    expect(readFileSync(again.out, "utf8")).toBe(report);
    expect(JSON.parse(report)).toMatchObject({ stack: "cire", differing: 0 });
  });

  test("SP3: a header that differs, or a host that does not answer, fails and is named", async () => {
    const hosts = fakeHosts((url) =>
      url === "https://host.cireweddings.com/"
        ? new Response("<!doctype html>", {
            status: 200,
            headers: {
              "content-type": "text/html",
              "x-frame-options": "DENY",
              "access-control-allow-origin": "*",
            },
          })
        : url === `https://next-vendor.cireweddings.com${UNKNOWN_PATH}`
          ? new TypeError("fetch failed")
          : undefined,
    );
    const result = await parity(["--stack", "cire"], hosts);
    expect(result.code).toBe(1);
    expect(result.output).toContain(
      "cire_host /: access-control-allow-origin, content-type differ",
    );
    expect(result.output).toContain(`cire_vendor ${UNKNOWN_PATH}: answer differ`);
    expect(JSON.parse(readFileSync(result.out, "utf8")).differing).toBe(2);
  });

  test("SP2: a redirect to the host's own origin compares by its path, so the same path matches and another differs", async () => {
    const sites = { ...SITES, "cire/landing/dist/_redirects": "/old /new 301\n" };
    const toOwn = (pagesPath: string) =>
      fakeHosts((url) => {
        const { origin, pathname } = new URL(url);
        if (pathname !== "/old") return undefined;
        const path = origin === "https://cireweddings.com" ? pagesPath : "/new";
        return new Response(null, { status: 301, headers: { location: `${origin}${path}` } });
      });
    const alike = await parity(["--stack", "cire"], toOwn("/new"), build(sites));
    expect(alike.code).toBe(0);
    expect(JSON.parse(readFileSync(alike.out, "utf8"))).toMatchObject({ differing: 0 });
    const elsewhere = await parity(["--stack", "cire"], toOwn("/other"), build(sites));
    expect(elsewhere.code).toBe(1);
    expect(elsewhere.output).toContain("cire_landing /old: location differ");
  });

  test("SP5: every probe, on the Worker side and the Pages side, sends the CI user agent and accepts any type", async () => {
    const hosts = fakeHosts();
    const result = await parity(["--stack", "cire"], hosts);
    expect(result.code).toBe(0);
    expect(hosts.calls.some((url) => url.startsWith("https://next-host.cireweddings.com/"))).toBe(
      true,
    );
    expect(hosts.calls.some((url) => url.startsWith("https://host.cireweddings.com/"))).toBe(true);
    expect(new Set(hosts.agents)).toEqual(new Set([CI_USER_AGENT]));
    // Cloudflare answers `*/*` with its HTML error page, the one SP8 recognises.
    expect(new Set(hosts.accepts)).toEqual(new Set(["*/*"]));
  });

  const challenge = () =>
    new Response("<!doctype html><title>Just a moment...</title>", {
      status: 403,
      headers: { "content-type": "text/html; charset=UTF-8", "cf-mitigated": "challenge" },
    });
  const accessRedirect = () =>
    new Response(null, {
      status: 302,
      headers: { location: "https://team.cloudflareaccess.com/cdn-cgi/access/login" },
    });
  const tooMany = (retryAfter?: string) =>
    new Response("rate limited", {
      status: 429,
      headers: retryAfter === undefined ? {} : { "retry-after": retryAfter },
    });

  test.each([
    [
      "a challenge on the Worker side",
      "https://next-host.cireweddings.com/",
      challenge,
      "worker",
      "Cloudflare answered 403 in the site's place (cf-mitigated: challenge)",
      RETRY_MS,
    ],
    [
      "a challenge on the Pages side",
      "https://host.cireweddings.com/",
      challenge,
      "pages",
      "Cloudflare answered 403 in the site's place (cf-mitigated: challenge)",
      RETRY_MS,
    ],
    [
      "an Access redirect",
      "https://host.cireweddings.com/",
      accessRedirect,
      "pages",
      "Cloudflare Access answered (302 to https://team.cloudflareaccess.com), not the site",
      RETRY_MS,
    ],
    [
      "a 429 that names no wait",
      "https://next-host.cireweddings.com/",
      tooMany,
      "worker",
      "answered 429: a rate limit or the account's daily request cap, not the site's code",
      15_000,
    ],
  ] as const)(
    "SP6: %s that holds when asked again refuses the run: listed in `refused`, named in an error, exit 3",
    async (_, blockedUrl, answer, side, reason, wait) => {
      const hosts = fakeHosts((url) => (url === blockedUrl ? answer() : undefined));
      const result = await parity(["--stack", "cire"], hosts);
      expect(result.code).toBe(3);
      expect(hosts.calls.filter((url) => url === blockedUrl)).toHaveLength(2);
      expect(result.slept).toEqual([wait]);
      const report = JSON.parse(readFileSync(result.out, "utf8"));
      expect(report.refused).toEqual([{ site: "cire_host", side, path: "/", reason }]);
      expect(report.differing).toBe(0);
      // The refused side's own host, so the owner reads that zone's Security Events.
      expect(result.output).toContain(
        side === "worker"
          ? "::error::site-parity: Cloudflare answered in the site's place for cire_host / on the Worker side (https://next-host.cireweddings.com)"
          : "::error::site-parity: Cloudflare answered in the site's place for cire_host / on the Pages side (https://host.cireweddings.com)",
      );
      // The second answer is the one the refusal rests on.
      expect(result.output).toContain(`) when asked again ${wait / 1000} s later: ${reason}.`);
      expect(result.output).toContain("zone's configuration, such as Bot Fight Mode, not the site");
      expect(result.output).not.toContain("answer differently");
      expect(result.output).not.toContain("cire_host /: answer differ");
    },
  );

  test("SP6: a refused path exits 3 whatever else differs, and another site's difference on the same path is still counted and named", async () => {
    const blockedUrl = "https://next-host.cireweddings.com/";
    const hosts = fakeHosts((url) =>
      url === blockedUrl
        ? challenge()
        : url === "https://next-vendor.cireweddings.com/"
          ? new Response("<!doctype html>", {
              status: 200,
              headers: {
                "content-type": "text/html; charset=utf-8",
                "access-control-allow-origin": "*",
              },
            })
          : undefined,
    );
    const result = await parity(["--stack", "cire"], hosts);
    expect(result.code).toBe(3);
    const report = JSON.parse(readFileSync(result.out, "utf8"));
    expect(report.refused).toEqual([
      {
        site: "cire_host",
        side: "worker",
        path: "/",
        reason: "Cloudflare answered 403 in the site's place (cf-mitigated: challenge)",
      },
    ]);
    expect(report.differing).toBe(1);
    expect(result.output).toContain("cire_vendor /: access-control-allow-origin differ\n");
    expect(result.output).toContain(
      "::warning::site-parity: 1 path answer differently on the staged Worker and on Pages",
    );
    expect(result.output).not.toContain("cire_host /:");
  });

  test("SP6: a site's own 403 on a path other than `/`, with no cf-mitigated, is compared as any answer, never refused", async () => {
    const forbidden = () =>
      new Response("forbidden", { status: 403, headers: { "content-type": "text/html" } });
    const hosts = fakeHosts((url) =>
      url === `https://next-host.cireweddings.com${UNKNOWN_PATH}` ||
      url === `https://host.cireweddings.com${UNKNOWN_PATH}`
        ? forbidden()
        : undefined,
    );
    const result = await parity(["--stack", "cire"], hosts);
    expect(result.code).toBe(0);
    expect(result.slept).toEqual([]);
    expect(JSON.parse(readFileSync(result.out, "utf8"))).toMatchObject({
      differing: 0,
      refused: [],
    });
    expect(result.output).not.toContain("::error::");
  });

  // Cloudflare's own error pages, trimmed from pages Cloudflare served and
  // kept as their markup reads; hosts, codes and Ray IDs are made up. The
  // Block action of a WAF custom rule or bot protection answers the first;
  // a 1xxx error (an IP Access rule, Zone Lockdown, a firewall rule's 1020)
  // the second, in the newer template; a Worker that throws (1101) the third.
  // None carries `cf-mitigated`.
  const BLOCK_PAGE = `<!DOCTYPE html>
<!--[if gt IE 8]><!--> <html class="no-js" lang="en-US"> <!--<![endif]-->
<head>
<title>Attention Required! | Cloudflare</title>
<meta charset="UTF-8" />
<meta name="robots" content="noindex, nofollow" />
<link rel="stylesheet" id="cf_styles-css" href="/cdn-cgi/styles/cf.errors.css" />
</head>
<body>
  <div id="cf-wrapper">
    <div class="cf-alert cf-alert-error cf-cookie-error" id="cookie-alert" data-translate="enable_cookies">Please enable cookies.</div>
    <div id="cf-error-details" class="cf-error-details-wrapper">
      <div class="cf-wrapper cf-header cf-error-overview">
        <h1 data-translate="block_headline">Sorry, you have been blocked</h1>
        <h2 class="cf-subheadline"><span data-translate="unable_to_access">You are unable to access</span> cireweddings.com</h2>
      </div><!-- /.header -->
      <div class="cf-error-footer cf-wrapper w-240 lg:w-full py-10 sm:py-4 sm:px-8 mx-auto text-center sm:text-left border-solid border-0 border-t border-gray-300">
        <p class="text-13">
          <span class="cf-footer-item sm:block sm:mb-1">Cloudflare Ray ID: <strong class="font-semibold">8d1f2e3a4b5c6d7e</strong></span>
        </p>
      </div><!-- /.error-footer -->
    </div><!-- /#cf-error-details -->
  </div><!-- /#cf-wrapper -->
</body>
</html>
`;
  const ERROR_1020_PAGE = `<!DOCTYPE html>
<html class="no-js" lang="en-US">
<head>
<title>Access denied | next-host.cireweddings.com used Cloudflare to restrict access</title>
<link rel="stylesheet" id="cf_styles-css" href="/cdn-cgi/styles/main.css" />
</head>
<body>
<div id="cf-wrapper">
    <div id="cf-error-details" class="p-0">
        <header class="mx-auto pt-10 lg:pt-6 lg:px-8 w-240 lg:w-full mb-8">
            <h1 class="inline-block sm:block sm:mb-2 font-light text-60 lg:text-4xl text-black-dark leading-tight mr-2">
              <span class="inline-block">Access denied</span>
              <span class="code-label">Error code 1020</span>
            </h1>
        </header>
        <div class="cf-error-footer cf-wrapper w-240 lg:w-full py-10 sm:py-4 sm:px-8 mx-auto text-center sm:text-left border-solid border-0 border-t border-gray-300">
          <p class="text-13">
            <span class="cf-footer-item sm:block sm:mb-1">Cloudflare Ray ID: <strong class="font-semibold">8d1f2e3a4b5c6d7f</strong></span>
          </p>
        </div>
    </div>
</div>
</body>
</html>
`;
  const WORKER_THREW_PAGE = `<!DOCTYPE html>
<html class="no-js" lang="en-US">
<head><title>Worker threw exception | next-host.cireweddings.com | Cloudflare</title></head>
<body>
  <div id="cf-wrapper">
    <div id="cf-error-details" class="cf-error-details-wrapper">
      <div class="cf-wrapper cf-header cf-error-overview">
        <h1>
          <span class="cf-error-type" data-translate="error">Error</span>
          <span class="cf-error-code">1101</span>
        </h1>
        <h2 class="cf-subheadline" data-translate="error_desc">Worker threw exception</h2>
      </div>
    </div>
  </div>
</body>
</html>
`;
  const PAGE_REASON =
    "Cloudflare answered 403 with its own error page in the site's place (a block rule, or a fault in the host's DNS or custom domain)";

  test.each([
    ["the block page of a WAF custom rule or bot protection", BLOCK_PAGE],
    ["the 1020 page of a firewall rule, an IP Access rule or Zone Lockdown", ERROR_1020_PAGE],
  ] as const)(
    "SP8: Cloudflare's own 403 page with no cf-mitigated, %s, on both hosts refuses the run, never two matching answers",
    async (_, page) => {
      const blocked = () =>
        new Response(page, {
          status: 403,
          headers: {
            "content-type": "text/html; charset=UTF-8",
            "cache-control": "private, max-age=0, no-store, no-cache, must-revalidate",
            server: "cloudflare",
          },
        });
      const hosts = fakeHosts((url) =>
        url === "https://next-host.cireweddings.com/" || url === "https://host.cireweddings.com/"
          ? blocked()
          : undefined,
      );
      const result = await parity(["--stack", "cire"], hosts);
      expect(result.code).toBe(3);
      expect(result.slept).toEqual([RETRY_MS]);
      const report = JSON.parse(readFileSync(result.out, "utf8"));
      expect(report.refused).toEqual([
        { site: "cire_host", side: "worker", path: "/", reason: PAGE_REASON },
        { site: "cire_host", side: "pages", path: "/", reason: PAGE_REASON },
      ]);
      expect(report.differing).toBe(0);
      expect(result.output).toContain(
        "::error::site-parity: Cloudflare answered in the site's place for cire_host / on the Worker side (https://next-host.cireweddings.com)",
      );
      expect(result.output).not.toContain("answers as Pages does");
    },
  );

  test("SP8: Cloudflare's page on a status other than 403, a Worker that threw (1101, 500) on a path other than `/`, is the site's own failure: a difference, never a refusal", async () => {
    const hosts = fakeHosts((url) =>
      url === `https://next-host.cireweddings.com${UNKNOWN_PATH}`
        ? new Response(WORKER_THREW_PAGE, {
            status: 500,
            headers: { "content-type": "text/html; charset=UTF-8" },
          })
        : undefined,
    );
    const result = await parity(["--stack", "cire"], hosts);
    expect(result.code).toBe(1);
    expect(result.slept).toEqual([]);
    expect(JSON.parse(readFileSync(result.out, "utf8"))).toMatchObject({
      differing: 1,
      refused: [],
    });
    expect(result.output).toContain(`cire_host ${UNKNOWN_PATH}: status, `);
    expect(result.output).not.toContain("::error::");
  });

  test.each([
    ["names 7 s", "7", 7_000],
    ["names 120 s, past the 30 s cap", "120", 30_000],
    ["names 0 s", "0", 0],
    ["names no wait", undefined, 15_000],
    ["names a negative wait", "-5", 15_000],
    ["names a date, not seconds", "Thu, 29 Oct 2026 07:28:00 GMT", 15_000],
  ] as const)(
    "SP9: a 429 that %s is asked again after its Retry-After, at most 30 s, else after 15 s",
    async (_, retryAfter, wait) => {
      const blockedUrl = "https://next-host.cireweddings.com/";
      const hosts = fakeHosts((url) => (url === blockedUrl ? tooMany(retryAfter) : undefined));
      const result = await parity(["--stack", "cire"], hosts);
      expect(result.code).toBe(3);
      expect(result.slept).toEqual([wait]);
      expect(hosts.calls.filter((url) => url === blockedUrl)).toHaveLength(2);
      expect(result.output).toContain(
        `cire_host / on the Worker side (https://next-host.cireweddings.com) when asked again ${wait / 1000} s later: answered 429`,
      );
      // The wait is the run's, never the report's.
      expect(readFileSync(result.out, "utf8")).not.toContain("retryAfter");
    },
  );

  test("SP9: 429s are asked again one path at a time after the longest wait, beside a challenge's 2 s re-ask", async () => {
    const holds = "https://next-host.cireweddings.com/";
    const clears = "https://vendor.cireweddings.com/";
    const challenged = "https://next.cireweddings.com/";
    /** Both hosts of the two paths a 429 answered. */
    const limited = new Set([
      holds,
      "https://host.cireweddings.com/",
      "https://next-vendor.cireweddings.com/",
      clears,
    ]);
    const base = fakeHosts((url, asked) =>
      url === holds
        ? tooMany("20")
        : url === clears && asked === 0
          ? tooMany()
          : url === challenged && asked === 0
            ? challenge()
            : undefined,
    );
    // Counts the requests to the 429 paths in flight once each was asked already.
    const asked = new Map<string, number>();
    let inFlight = 0;
    let most = 0;
    const fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const before = asked.get(url) ?? 0;
      asked.set(url, before + 1);
      const counted = limited.has(url) && before > 0;
      if (counted) most = Math.max(most, ++inFlight);
      try {
        await Bun.sleep(1);
        return await base.fetch(input, init);
      } finally {
        if (counted) inFlight -= 1;
      }
    };
    const result = await parity(["--stack", "cire"], {
      ...base,
      fetch: fetch as unknown as typeof globalThis.fetch,
    });
    expect(result.code).toBe(3);
    expect(result.slept.toSorted((a, b) => a - b)).toEqual([RETRY_MS, 20_000]);
    expect(most).toBe(2);
    for (const url of [holds, clears, challenged]) {
      expect({ url, asked: asked.get(url) }).toEqual({ url, asked: 2 });
    }
    const report = JSON.parse(readFileSync(result.out, "utf8"));
    expect(report.refused).toEqual([
      {
        site: "cire_host",
        side: "worker",
        path: "/",
        reason:
          "answered 429: a rate limit or the account's daily request cap, not the site's code",
      },
    ]);
    expect(report.differing).toBe(0);
    // Sites in map order and each site's paths sorted, whenever each was asked again.
    expect(report.sites.map((site: { site: string }) => site.site)).toEqual([
      "cire_host",
      "cire_vendor",
      "cire_landing",
    ]);
    for (const site of report.sites as { probes: { path: string }[] }[]) {
      const paths = site.probes.map((probe) => probe.path);
      expect(paths).toEqual(paths.toSorted());
    }
  });

  // `/` must answer both hosts as the site's own page, a 2xx with an HTML
  // content type: a zone's custom error page or custom block response
  // carries no marker, so two of them would otherwise compare as alike.
  const HOME_WORKER = "https://next-host.cireweddings.com/";
  const HOME_PAGES = "https://host.cireweddings.com/";
  const notAPage = (what: string) => `answered ${what}, expected a 2xx HTML page`;
  const notAPageLine = (side: "Worker" | "Pages", host: string, reason: string) =>
    `::error::site-parity: cire_host / did not answer as the site's own page on the ${side} side (${host}) when asked again 2 s later: ${reason}. A run passes only when \`/\` answers both hosts with a 2xx HTML page;`;
  const html = (status: number, init: { body?: string; location?: string } = {}) =>
    new Response(init.body ?? "<!doctype html><title>Restricted</title>", {
      status,
      headers: {
        "content-type": "text/html; charset=utf-8",
        ...(init.location === undefined ? {} : { location: init.location }),
      },
    });
  const onHome = (answer: () => Response | Error) =>
    fakeHosts((url) => (url === HOME_WORKER || url === HOME_PAGES ? answer() : undefined));

  test("SP11: a zone's own 403 page on `/` of both hosts, no marker and no cf-mitigated, refuses the run, never two matching answers", async () => {
    const hosts = onHome(() => html(403));
    const result = await parity(["--stack", "cire"], hosts);
    expect(result.code).toBe(3);
    expect(result.slept).toEqual([RETRY_MS]);
    expect(hosts.calls.filter((url) => url === HOME_WORKER)).toHaveLength(2);
    expect(hosts.calls.filter((url) => url === HOME_PAGES)).toHaveLength(2);
    const reason = notAPage("403 text/html; charset=utf-8");
    const report = JSON.parse(readFileSync(result.out, "utf8"));
    expect(report.refused).toEqual([
      { site: "cire_host", side: "worker", path: "/", reason },
      { site: "cire_host", side: "pages", path: "/", reason },
    ]);
    expect(report.differing).toBe(0);
    expect(result.output).toContain(
      notAPageLine("Worker", "https://next-host.cireweddings.com", reason),
    );
    expect(result.output).toContain(notAPageLine("Pages", "https://host.cireweddings.com", reason));
    expect(result.output).not.toContain("Cloudflare answered in the site's place");
    expect(result.output).not.toContain("answers as Pages does");
  });

  test.each([
    ["200 text/html, with no parameter", 200, "text/html"],
    ["200 Text/HTML in other letter case", 200, "Text/HTML; charset=UTF-8"],
    ["200 text/html with a space before its parameter", 200, "text/html ; charset=utf-8"],
    ["203, a 2xx other than 200", 203, "text/html; charset=utf-8"],
  ] as const)("SP11: `/` answering %s on both hosts is a page", async (_, status, type) => {
    const hosts = onHome(
      () => new Response("<!doctype html>", { status, headers: { "content-type": type } }),
    );
    const result = await parity(["--stack", "cire"], hosts);
    expect(result.code).toBe(0);
    expect(result.slept).toEqual([]);
    expect(JSON.parse(readFileSync(result.out, "utf8"))).toMatchObject({
      differing: 0,
      refused: [],
    });
  });

  test.each([
    [
      "text/plain",
      () =>
        new Response("Restricted", { headers: { "content-type": "text/plain; charset=utf-8" } }),
      "200 text/plain; charset=utf-8",
    ],
    [
      "JSON",
      () => new Response("{}", { headers: { "content-type": "application/json" } }),
      "200 application/json",
    ],
    ["no content type", () => new Response(null, { status: 200 }), "200 with no content type"],
  ] as const)(
    "SP11: `/` answering 200 with %s on both hosts is not a page, and refuses the run",
    async (_, answer, what) => {
      const result = await parity(["--stack", "cire"], onHome(answer));
      expect(result.code).toBe(3);
      const reason = notAPage(what);
      expect(JSON.parse(readFileSync(result.out, "utf8")).refused).toEqual([
        { site: "cire_host", side: "worker", path: "/", reason },
        { site: "cire_host", side: "pages", path: "/", reason },
      ]);
    },
  );

  test.each([
    ["Pages answers 404", HOME_PAGES, () => html(404), "pages", "404 text/html; charset=utf-8"],
    [
      "the Worker answers 503",
      HOME_WORKER,
      () => html(503),
      "worker",
      "503 text/html; charset=utf-8",
    ],
  ] as const)(
    "SP11: `/` a page on one host and not the other refuses that side only: %s",
    async (_, url, answer, side, what) => {
      const result = await parity(
        ["--stack", "cire"],
        fakeHosts((requested) => (requested === url ? answer() : undefined)),
      );
      expect(result.code).toBe(3);
      const report = JSON.parse(readFileSync(result.out, "utf8"));
      expect(report.refused).toEqual([
        { site: "cire_host", side, path: "/", reason: notAPage(what) },
      ]);
      // A refused path compared nothing, so it is never a difference too.
      expect(report.differing).toBe(0);
      expect(result.output).not.toContain("cire_host /:");
    },
  );

  test.each([
    ["the same path", "/welcome", "/welcome"],
    ["a long path, cut to 80 characters", `/${"a".repeat(300)}`, `/${"a".repeat(79)}`],
  ] as const)(
    "SP11: `/` redirecting on both hosts to %s is not a page, whatever its content type: redirects are not followed",
    async (_, location, shown) => {
      const result = await parity(
        ["--stack", "cire"],
        onHome(() => html(302, { location })),
      );
      expect(result.code).toBe(3);
      const reason = notAPage(`302 to ${shown} text/html; charset=utf-8`);
      expect(JSON.parse(readFileSync(result.out, "utf8")).refused).toEqual([
        { site: "cire_host", side: "worker", path: "/", reason },
        { site: "cire_host", side: "pages", path: "/", reason },
      ]);
    },
  );

  test("SP11: no answer on `/` refuses the run, as a host or custom domain that is not ready gives", async () => {
    const hosts = fakeHosts((url) =>
      url === HOME_WORKER ? new TypeError("fetch failed") : undefined,
    );
    const result = await parity(["--stack", "cire"], hosts);
    expect(result.code).toBe(3);
    expect(result.slept).toEqual([RETRY_MS]);
    expect(hosts.calls.filter((url) => url === HOME_WORKER)).toHaveLength(2);
    const report = JSON.parse(readFileSync(result.out, "utf8"));
    expect(report.refused).toEqual([
      { site: "cire_host", side: "worker", path: "/", reason: "no answer" },
    ]);
    expect(report.differing).toBe(0);
    expect(result.output).toContain(
      notAPageLine("Worker", "https://next-host.cireweddings.com", "no answer"),
    );
  });

  test("SP11: a `/` that is not a page once and a page when asked again 2 s later is compared as any answer", async () => {
    const hosts = fakeHosts((url, asked) =>
      url === HOME_WORKER && asked === 0 ? html(503) : undefined,
    );
    const result = await parity(["--stack", "cire"], hosts);
    expect(result.code).toBe(0);
    expect(result.slept).toEqual([RETRY_MS]);
    expect(hosts.calls.filter((url) => url === HOME_WORKER)).toHaveLength(2);
    expect(JSON.parse(readFileSync(result.out, "utf8"))).toMatchObject({
      differing: 0,
      refused: [],
    });
  });

  test("SP11: a `/` with a 429 on one host and no page on the other is asked again once, after the 429's wait, never with the 2 s re-ask too", async () => {
    const hosts = fakeHosts((url) =>
      url === HOME_WORKER ? tooMany("5") : url === HOME_PAGES ? html(404) : undefined,
    );
    const result = await parity(["--stack", "cire"], hosts);
    expect(result.code).toBe(3);
    expect(result.slept).toEqual([5_000]);
    expect(hosts.calls.filter((url) => url === HOME_WORKER)).toHaveLength(2);
    expect(hosts.calls.filter((url) => url === HOME_PAGES)).toHaveLength(2);
    expect(JSON.parse(readFileSync(result.out, "utf8")).refused).toEqual([
      {
        site: "cire_host",
        side: "worker",
        path: "/",
        reason:
          "answered 429: a rate limit or the account's daily request cap, not the site's code",
      },
      {
        site: "cire_host",
        side: "pages",
        path: "/",
        reason: notAPage("404 text/html; charset=utf-8"),
      },
    ]);
  });

  test("SP11: refusals of both kinds keep one order: sites in map order, paths sorted, the Worker side first", async () => {
    const hosts = fakeHosts((url) =>
      url === HOME_PAGES
        ? html(404)
        : url === "https://next-vendor.cireweddings.com/"
          ? challenge()
          : undefined,
    );
    const result = await parity(["--stack", "cire"], hosts);
    expect(result.code).toBe(3);
    expect(result.slept).toEqual([RETRY_MS]);
    expect(JSON.parse(readFileSync(result.out, "utf8")).refused).toEqual([
      {
        site: "cire_host",
        side: "pages",
        path: "/",
        reason: notAPage("404 text/html; charset=utf-8"),
      },
      {
        site: "cire_vendor",
        side: "worker",
        path: "/",
        reason: "Cloudflare answered 403 in the site's place (cf-mitigated: challenge)",
      },
    ]);
  });

  test("SP7: a challenge that clears when asked again 2 s later is compared as any answer", async () => {
    const blockedUrl = "https://next-vendor.cireweddings.com/";
    const hosts = fakeHosts((url, asked) =>
      url === blockedUrl && asked === 0 ? challenge() : undefined,
    );
    const result = await parity(["--stack", "cire"], hosts);
    expect(result.code).toBe(0);
    expect(RETRY_MS).toBe(2_000);
    expect(result.slept).toEqual([RETRY_MS]);
    expect(hosts.calls.filter((url) => url === blockedUrl)).toHaveLength(2);
    expect(JSON.parse(readFileSync(result.out, "utf8"))).toMatchObject({
      differing: 0,
      refused: [],
    });
  });

  test("SP4: no stack, a stack with no production job, or no --out exits 2 before any request", async () => {
    for (const args of [[], ["--stack", "zap"], ["--stack", "pulse"], ["--stack"]]) {
      const hosts = fakeHosts();
      const lines: string[] = [];
      const code = await runSiteParity({
        args,
        root: build(SITES),
        fetch: hosts.fetch,
        out: (text) => lines.push(text),
      });
      expect({ args, code, calls: hosts.calls.length }).toEqual({ args, code: 2, calls: 0 });
    }
  });

  test("a staged site with no build output is still asked `/`, an unknown path and its deep link", async () => {
    const hosts = fakeHosts();
    const result = await parity(["--stack", "musubi"], hosts, build({}));
    expect(
      hosts.calls.filter((url) => url.startsWith("https://next.musubi.social/")).toSorted(),
    ).toEqual(
      [
        "https://next.musubi.social/",
        `https://next.musubi.social${UNKNOWN_PATH}`,
        "https://next.musubi.social/site-parity-deep-link",
      ].toSorted(),
    );
    // musubi landing serves from its Worker: nothing to compare it with.
    expect(hosts.calls.some((url) => url.includes("www.musubi.social"))).toBe(false);
    expect(result.code).toBe(0);
  });
});
