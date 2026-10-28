// scripts/site-parity.ts asks a staged site's Worker (its spare host) and its
// Pages project (the production host) the same paths and reports where they
// differ. These drive it against built-site fixtures and an injected fetch.
// Cloudflare answering in a site's place is refused, not compared.

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
    const fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      const asked = calls.filter((call) => call === url).length;
      calls.push(url);
      agents.push(new Headers(init?.headers).get("user-agent"));
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
    return { fetch: fetch as unknown as typeof globalThis.fetch, calls, agents };
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

  test("SP5: every probe, on the Worker side and the Pages side, sends the CI user agent", async () => {
    const hosts = fakeHosts();
    const result = await parity(["--stack", "cire"], hosts);
    expect(result.code).toBe(0);
    expect(hosts.calls.some((url) => url.startsWith("https://next-host.cireweddings.com/"))).toBe(
      true,
    );
    expect(hosts.calls.some((url) => url.startsWith("https://host.cireweddings.com/"))).toBe(true);
    expect(new Set(hosts.agents)).toEqual(new Set([CI_USER_AGENT]));
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
  const tooMany = () => new Response("rate limited", { status: 429 });

  test.each([
    [
      "a challenge on the Worker side",
      "https://next-host.cireweddings.com/",
      challenge,
      "worker",
      "Cloudflare answered 403 in the site's place (cf-mitigated: challenge)",
    ],
    [
      "a challenge on the Pages side",
      "https://host.cireweddings.com/",
      challenge,
      "pages",
      "Cloudflare answered 403 in the site's place (cf-mitigated: challenge)",
    ],
    [
      "an Access redirect",
      "https://host.cireweddings.com/",
      accessRedirect,
      "pages",
      "Cloudflare Access answered (302 to https://team.cloudflareaccess.com), not the site",
    ],
    [
      "a 429",
      "https://next-host.cireweddings.com/",
      tooMany,
      "worker",
      "answered 429: a rate limit or the account's daily request cap, not the site's code",
    ],
  ] as const)(
    "SP6: %s that holds when asked again refuses the run: listed in `refused`, named in an error, exit 3",
    async (_, blockedUrl, answer, side, reason) => {
      const hosts = fakeHosts((url) => (url === blockedUrl ? answer() : undefined));
      const result = await parity(["--stack", "cire"], hosts);
      expect(result.code).toBe(3);
      expect(hosts.calls.filter((url) => url === blockedUrl)).toHaveLength(2);
      expect(result.slept).toEqual([RETRY_MS]);
      const report = JSON.parse(readFileSync(result.out, "utf8"));
      expect(report.refused).toEqual([{ site: "cire_host", side, path: "/", reason }]);
      expect(report.differing).toBe(0);
      // The refused side's own host, so the owner reads that zone's Security Events.
      expect(result.output).toContain(
        side === "worker"
          ? "::error::site-parity: Cloudflare answered in the site's place for cire_host / on the Worker side (https://next-host.cireweddings.com)"
          : "::error::site-parity: Cloudflare answered in the site's place for cire_host / on the Pages side (https://host.cireweddings.com)",
      );
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

  test("SP6: a site's own 403, with no cf-mitigated, is compared as any answer, never refused", async () => {
    const forbidden = () =>
      new Response("forbidden", { status: 403, headers: { "content-type": "text/html" } });
    const hosts = fakeHosts((url) =>
      url === "https://next-host.cireweddings.com/" || url === "https://host.cireweddings.com/"
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
