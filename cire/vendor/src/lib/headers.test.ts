import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

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
    expect(csp).toContain("connect-src 'self' https://api.cireweddings.com http://localhost:8787");
    // Sign-in redirects through cire/api's OIDC leg and account management
    // links out to musubi — both navigations, neither a `connect-src` subject.
    expect(csp).not.toContain("musubi.social");
  });

  it("allowlists Google Fonts, which the page shells still link", () => {
    expect(csp).toContain("style-src 'self' 'unsafe-inline' https://fonts.googleapis.com");
    expect(csp).toContain("font-src 'self' https://fonts.gstatic.com");
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

  it("/claim* rule overrides Referrer-Policy to no-referrer", () => {
    // Find the /claim* section.
    const claimMatch = contents.match(/\/claim\*[\s\S]+?(?:\n\n|$)/);
    expect(claimMatch).not.toBeNull();
    expect(claimMatch![0]).toMatch(/Referrer-Policy:\s*no-referrer/);
  });
});
