import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

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
    expect(csp).toContain("connect-src 'self' https://api.cireweddings.com http://localhost:8787");
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
    expect(csp).toContain("img-src 'self' data: blob: https://api.cireweddings.com");
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
