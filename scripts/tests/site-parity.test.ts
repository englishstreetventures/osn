// scripts/site-parity.ts asks a staged site's Worker (its spare host) and its
// Pages project (the production host) the same paths and reports where they
// differ. These drive it against built-site fixtures and an injected fetch.

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
  UNKNOWN_PATH,
} from "../site-parity";

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
  function fakeHosts(differ: (url: string) => Response | Error | undefined = () => undefined) {
    const calls: string[] = [];
    const fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      calls.push(url);
      expect(init?.redirect).toBe("manual");
      const special = differ(url);
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
    return { fetch: fetch as unknown as typeof globalThis.fetch, calls };
  }

  async function parity(args: string[], hosts: ReturnType<typeof fakeHosts>, root = build(SITES)) {
    const lines: string[] = [];
    const out = join(root, "report.json");
    const code = await runSiteParity({
      args: [...args, "--out", out],
      root,
      fetch: hosts.fetch,
      out: (text) => lines.push(text),
    });
    return { code, output: lines.join(""), out, root };
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
