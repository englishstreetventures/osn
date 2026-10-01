import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { PRODUCTION_API_ORIGIN, retargetHeaders } from "../../src/lib/tier-headers";

/** Every value of `name` set in `contents`, one per header line. */
function headerValues(contents: string, name: string): string[] {
  return [...contents.matchAll(new RegExp(`^\\s+${name}:\\s*(.+)$`, "gm"))].map((m) =>
    m[1]!.trim(),
  );
}

/** Each directive of `policy`, in order, as its name followed by its sources. */
function directives(policy: string): string[][] {
  return policy.split(";").map((part) => part.trim().split(/\s+/));
}

/** The sources a policy lists for `directive`, or `undefined` if it has none. */
function sources(policy: string, directive: string): string[] | undefined {
  return directives(policy)
    .find(([name]) => name === directive)
    ?.slice(1);
}

/**
 * `public/_headers` is served by Cloudflare Pages' asset layer, so nothing in
 * the app can assert these at runtime — this file is the only guard against a
 * directive being dropped or the enforced policy quietly drifting from the
 * origins the portal actually talks to. Mirrors `cire/vendor`'s equivalent.
 */
describe("_headers", () => {
  const path = fileURLToPath(new URL("../../public/_headers", import.meta.url));
  const contents = readFileSync(path, "utf8");
  // The first rule, up to the blank line that ends it.
  const wildcardBlock = contents.split("\n\n")[0]!;
  const enforced = headerValues(contents, "Content-Security-Policy");
  const csp = enforced[0] ?? "";

  it("sets the platform security baseline headers", () => {
    expect(contents).toMatch(/X-Frame-Options:\s*DENY/);
    expect(contents).toMatch(/X-Content-Type-Options:\s*nosniff/);
    expect(contents).toMatch(/Referrer-Policy:\s*strict-origin-when-cross-origin/);
    expect(contents).toMatch(/Permissions-Policy:\s*camera=\(\)/);
  });

  it("enforces exactly this policy on every path", () => {
    // Pinned whole: a source added beside `'none'` (which the browser then
    // ignores), a new directive or a dropped one all loosen what the browser
    // blocks, and only a full comparison fails on every such edit.
    expect(wildcardBlock.split("\n")[0]).toBe("/*");
    expect(headerValues(wildcardBlock, "Content-Security-Policy")).toEqual(enforced);
    expect(directives(csp)).toEqual([
      ["default-src", "'self'"],
      ["script-src", "'self'", "'unsafe-inline'"],
      ["style-src", "'self'", "'unsafe-inline'"],
      ["style-src-attr", "'unsafe-inline'"],
      ["font-src", "'self'"],
      ["img-src", "'self'", "data:", "blob:", "https://api.cireweddings.com"],
      ["connect-src", "'self'", "https://api.cireweddings.com"],
      ["frame-src", "'none'"],
      ["worker-src", "'none'"],
      ["frame-ancestors", "'none'"],
      ["object-src", "'none'"],
      ["base-uri", "'self'"],
      ["form-action", "'self'"],
      ["report-uri", "https://api.cireweddings.com/api/csp-report"],
      ["report-to", "csp-endpoint"],
    ]);
  });

  it("enforces one full policy, reporting to the cire-api collector", () => {
    // One enforced header: a second `Content-Security-Policy` would be enforced
    // as well, and the stricter of the two would win for every directive.
    expect(enforced).toHaveLength(1);
    expect(contents).toMatch(
      /Reporting-Endpoints:\s*csp-endpoint="https:\/\/api\.cireweddings\.com\/api\/csp-report"/,
    );
    expect(csp).toContain("report-uri https://api.cireweddings.com/api/csp-report");
    expect(csp).toContain("report-to csp-endpoint");
  });

  it("keeps the inline theme-boot script and critical CSS running", () => {
    expect(csp).toContain("script-src 'self' 'unsafe-inline';");
    expect(csp).toContain("style-src 'self' 'unsafe-inline';");
    expect(csp).not.toContain("'unsafe-eval'");
  });

  it("allowlists cire-api and nothing else for fetches", () => {
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("connect-src 'self' https://api.cireweddings.com;");
    // Sign-in is a top-level redirect to musubi, not a fetch — the OSN origin
    // must stay out of the policy.
    expect(csp).not.toContain("musubi.social");
  });

  it("keeps the fonts self-hosted — no Google Fonts origins", () => {
    expect(csp).toContain("font-src 'self'");
    expect(csp).not.toContain("fonts.googleapis.com");
    expect(csp).not.toContain("fonts.gstatic.com");
  });

  it("admits no https image origin but cire-api's", () => {
    // The shop link picker's candidates come through cire-api, re-encoded, so
    // no image host a page or injected markup names can load. The cire-api
    // origin is spelled out beside 'self' so a local build, whose API is
    // `http://localhost:8787`, still loads its images.
    expect(sources(csp, "img-src")).toEqual([
      "'self'",
      "data:",
      "blob:",
      "https://api.cireweddings.com",
    ]);
    expect(sources(csp, "img-src")).not.toContain("https:");
  });

  it("sends no report-only policy", () => {
    // Every directive is enforced and reports already; a report-only twin
    // would file each violation twice.
    expect(contents).not.toMatch(/^\s+Content-Security-Policy-Report-Only:/m);
  });

  it("is the production policy: no other tier's API, no loopback", () => {
    // The build rewrites the production origin for each tier
    // (`src/lib/tier-headers.ts`), so a dev or local origin written here would
    // survive into production.
    expect(contents).not.toMatch(/localhost|api\.dev\./);
  });

  it("names cire-api only in forms the build can point at another tier", () => {
    // Retarget the file that ships, not a fixture: an origin spelled some way
    // the rewrite skips (a port, a trailing dot) would carry the production API
    // into the dev tier's policy.
    expect(retargetHeaders(contents, PRODUCTION_API_ORIGIN)).toBe(contents);
    const headerLines = retargetHeaders(contents, "https://api.dev.cireweddings.com")
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("#"));
    expect(headerLines.filter((line) => line.includes("api.cireweddings.com"))).toEqual([]);
    // The policy reports to the dev collector.
    const dev = retargetHeaders(contents, "https://api.dev.cireweddings.com");
    const policies = headerValues(dev, "Content-Security-Policy");
    expect(policies).toHaveLength(1);
    for (const policy of policies) {
      expect(policy).toContain("report-uri https://api.dev.cireweddings.com/api/csp-report;");
    }
  });

  it("is wired into the build", () => {
    // Without the integration every tier ships this production file unchanged.
    // A text pin: importing the config pulls Astro's build toolchain into the
    // test runner, which cannot load it.
    const config = readFileSync(
      fileURLToPath(new URL("../../astro.config.mjs", import.meta.url)),
      "utf8",
    );
    expect(config).toMatch(/^import tierHeaders from "\.\/src\/lib\/tier-headers";$/m);
    expect(config).toMatch(/^\s*integrations: \[[^\]]*\btierHeaders\(\)[^\]]*\],$/m);
  });

  it("names no private tracker issue or finding tag", () => {
    // This file ships to every visitor as well as sitting in a public repo.
    expect(contents).not.toMatch(/osn-tracker|\b[A-Z]{1,3}-[SPC]-[CHML]\d|\b[SPC]-[CHMLWI]\d/);
  });

  it("denies framing, embedding and workers", () => {
    for (const directive of [
      "frame-ancestors 'none'",
      "object-src 'none'",
      "frame-src 'none'",
      "worker-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ]) {
      expect(csp).toContain(directive);
    }
  });
  it("keeps the signed-in dashboard out of the browser's caches", () => {
    // Back after sign-out must not show the account's data again. The rule
    // names `/` alone: the long-lived `/_astro/*` cache stays as it is.
    const dashboard = contents.match(/^\/\n((?:[ \t]+.+\n?)+)/m);
    expect(dashboard).not.toBeNull();
    expect(dashboard![1]).toMatch(/^\s+Cache-Control:\s*no-store\s*$/m);
  });
});
