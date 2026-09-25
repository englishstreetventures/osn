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
  const reportOnly = headerValues(contents, "Content-Security-Policy-Report-Only");
  const csp = enforced[0] ?? "";
  const imageReport = reportOnly[0] ?? "";

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
      ["img-src", "'self'", "data:", "blob:", "https://api.cireweddings.com", "https:"],
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

  it("admits any https image, for the shop link picker's candidates", () => {
    // The candidates load straight from each shop's own host. The cire-api
    // origin stays listed beside `https:` so a local build, whose API is
    // `http://localhost:8787`, still loads its images.
    expect(sources(csp, "img-src")).toEqual([
      "'self'",
      "data:",
      "blob:",
      "https://api.cireweddings.com",
      "https:",
    ]);
  });

  it("reports every image the tight list would block, and nothing else", () => {
    // The enforced `img-src` is the tight list plus `https:`, so this header
    // files a report for exactly the images `https:` alone lets through.
    expect(reportOnly).toHaveLength(1);
    expect(headerValues(wildcardBlock, "Content-Security-Policy-Report-Only")).toEqual(reportOnly);
    expect(sources(imageReport, "img-src")).toEqual(
      sources(csp, "img-src")!.filter((source) => source !== "https:"),
    );
    // Every other directive is enforced and reports already; repeating one
    // here would file each of its violations twice.
    expect(imageReport.split(";").map((part) => part.trim().split(/\s+/)[0])).toEqual([
      "img-src",
      "report-uri",
      "report-to",
    ]);
    expect(imageReport).toContain("report-uri https://api.cireweddings.com/api/csp-report;");
    expect(imageReport).toContain("report-to csp-endpoint");
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
    // Both policies, enforced and report-only, report to the dev collector.
    const dev = retargetHeaders(contents, "https://api.dev.cireweddings.com");
    for (const policy of [
      ...headerValues(dev, "Content-Security-Policy"),
      ...headerValues(dev, "Content-Security-Policy-Report-Only"),
    ]) {
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
});
