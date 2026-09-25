import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { PRODUCTION_API_ORIGIN, retargetHeaders } from "../../src/lib/tier-headers";

/**
 * `public/_headers` is served by Cloudflare Pages' asset layer, so nothing in
 * the app can assert these at runtime — this file is the only guard against a
 * directive being dropped or the report-only policy quietly drifting from the
 * origins the portal actually talks to. Mirrors `cire/vendor`'s equivalent.
 */
describe("_headers", () => {
  const path = fileURLToPath(new URL("../../public/_headers", import.meta.url));
  const contents = readFileSync(path, "utf8");
  const csp = contents.match(/Content-Security-Policy-Report-Only:\s*(.+)/)?.[1]?.trim() ?? "";

  it("sets the platform security baseline headers", () => {
    expect(contents).toMatch(/X-Frame-Options:\s*DENY/);
    expect(contents).toMatch(/X-Content-Type-Options:\s*nosniff/);
    expect(contents).toMatch(/Referrer-Policy:\s*strict-origin-when-cross-origin/);
    expect(contents).toMatch(/Permissions-Policy:\s*camera=\(\)/);
  });

  it("enforces only the directives that cannot break a working page", () => {
    const enforced = contents.match(/\n\s*Content-Security-Policy:\s*(.+)/)?.[1]?.trim();
    expect(enforced).toBe("frame-ancestors 'none'; object-src 'none'; base-uri 'self'");
  });

  it("ships the full policy in report-only mode, pointed at the cire-api collector", () => {
    expect(contents).toMatch(
      /Reporting-Endpoints:\s*csp-endpoint="https:\/\/api\.cireweddings\.com\/api\/csp-report"/,
    );
    expect(csp).toContain("report-uri https://api.cireweddings.com/api/csp-report");
    expect(csp).toContain("report-to csp-endpoint");
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

  it("allows the image sources the crop editor and CSV export need", () => {
    expect(csp).toContain("img-src 'self' data: blob: https://api.cireweddings.com;");
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
