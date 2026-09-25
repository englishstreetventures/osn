import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { PRODUCTION_API_ORIGIN, retargetHeaders } from "../../src/lib/tier-headers";

describe("_headers", () => {
  const path = fileURLToPath(new URL("../../public/_headers", import.meta.url));
  const contents = readFileSync(path, "utf8");
  // Split on rule blocks so we can test the wildcard rule independently.
  const wildcardBlock = contents.split(/\n\/claim\*/)[0]!;
  const csp = wildcardBlock.match(/Content-Security-Policy-Report-Only:\s*(.+)/)?.[1]?.trim() ?? "";

  it("/* block sets the platform security baseline headers", () => {
    expect(wildcardBlock).toMatch(/Referrer-Policy:\s*strict-origin-when-cross-origin/);
    expect(wildcardBlock).toMatch(/X-Content-Type-Options:\s*nosniff/);
    expect(wildcardBlock).toMatch(/Content-Security-Policy:\s*frame-ancestors 'none'/);
    expect(wildcardBlock).toMatch(/Permissions-Policy:\s*camera=\(\)/);
  });

  it("enforces only the directives that cannot break a working page", () => {
    const enforced = wildcardBlock.match(/\n\s*Content-Security-Policy:\s*(.+)/)?.[1]?.trim();
    expect(enforced).toBe("frame-ancestors 'none'; object-src 'none'; base-uri 'self'");
  });

  it("ships the full policy in report-only mode, pointed at the cire-api collector", () => {
    expect(wildcardBlock).toMatch(
      /Reporting-Endpoints:\s*csp-endpoint="https:\/\/api\.cireweddings\.com\/api\/csp-report"/,
    );
    expect(csp).toContain("report-uri https://api.cireweddings.com/api/csp-report");
    expect(csp).toContain("report-to csp-endpoint");
  });

  it("allowlists cire-api and nothing else for fetches", () => {
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("connect-src 'self' https://api.cireweddings.com;");
    // Sign-in redirects through cire/api's OIDC leg and account management
    // links out to musubi — both navigations, neither a `connect-src` subject.
    expect(csp).not.toContain("musubi.social");
  });

  it("allowlists no font or stylesheet origin — both faces are self-hosted", () => {
    // `astro.config.mjs` downloads Schibsted Grotesk and Cormorant Garamond at
    // build time via `fontProviders.google()`, so nothing links or fetches
    // Google's origins any more. Re-adding a `<link>` to a page shell without
    // re-adding the origin here would break the face under enforcement; this is
    // what makes that a failing test rather than a silent fallback to Georgia.
    expect(csp).toContain("style-src 'self' 'unsafe-inline'");
    expect(csp).toContain("font-src 'self'");
    expect(csp).not.toContain("fonts.googleapis.com");
    expect(csp).not.toContain("fonts.gstatic.com");
  });

  it("keeps the inline theme-boot script running", () => {
    // `THEME_BOOT_SCRIPT` is `is:inline` on all three shells so it resolves the
    // theme before first paint. An inline script cannot be an external hashed
    // file, so this source is load-bearing, not incidental.
    expect(csp).toContain("script-src 'self' 'unsafe-inline'");
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

  it("allows images from cire-api and inline data URIs only", () => {
    expect(csp).toContain("img-src 'self' data: https://api.cireweddings.com;");
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

  it("/claim* rule overrides Referrer-Policy to no-referrer", () => {
    // Find the /claim* section.
    const claimMatch = contents.match(/\/claim\*[\s\S]+?(?:\n\n|$)/);
    expect(claimMatch).not.toBeNull();
    expect(claimMatch![0]).toMatch(/Referrer-Policy:\s*no-referrer/);
  });
});
