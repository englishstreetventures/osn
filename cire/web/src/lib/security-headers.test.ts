import { describe, expect, it } from "vitest";

import {
  applySecurityHeaders,
  buildCsp,
  CSP_DIRECTIVES,
  CSP_REPORT_ENDPOINT,
  cspHeaderName,
  reportingEndpointsHeader,
  securityHeaders,
} from "./security-headers";

describe("buildCsp", () => {
  const csp = buildCsp();

  it("emits the locked-down framing + object directives", () => {
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("form-action 'self'");
  });

  it("allowlists the Pinterest moodboard widget origins", () => {
    // pinit_main.js script host
    expect(csp).toMatch(/script-src[^;]*https:\/\/assets\.pinterest\.com/);
    // pidgets data fetch
    expect(csp).toMatch(/connect-src[^;]*https:\/\/widgets\.pinterest\.com/);
    // pin thumbnails
    expect(csp).toMatch(/img-src[^;]*https:\/\/i\.pinimg\.com/);
    // rendered board widget iframe
    expect(csp).toMatch(/frame-src[^;]*https:\/\/assets\.pinterest\.com/);
  });

  it("allowlists the Google Maps embed iframe + tiles", () => {
    expect(csp).toMatch(/frame-src[^;]*https:\/\/www\.google\.com/);
    expect(csp).toMatch(/img-src[^;]*https:\/\/maps\.gstatic\.com/);
    expect(csp).toMatch(/img-src[^;]*https:\/\/maps\.googleapis\.com/);
  });

  it("allowlists Google Fonts (stylesheet + font files)", () => {
    expect(csp).toMatch(/style-src[^;]*https:\/\/fonts\.googleapis\.com/);
    expect(csp).toMatch(/font-src[^;]*https:\/\/fonts\.gstatic\.com/);
  });

  it("allowlists Cloudflare Turnstile (script + challenge frame)", () => {
    expect(csp).toMatch(/script-src[^;]*https:\/\/challenges\.cloudflare\.com/);
    expect(csp).toMatch(/frame-src[^;]*https:\/\/challenges\.cloudflare\.com/);
  });

  it("allowlists the first-party cire-api origin for JSON + image bytes", () => {
    expect(csp).toMatch(/img-src[^;]*https:\/\/api\.cireweddings\.com/);
    expect(csp).toMatch(/connect-src[^;]*https:\/\/api\.cireweddings\.com/);
  });

  it("keeps script-src host-restricted (no wildcard, no bare scheme source)", () => {
    const scriptSrc = csp.split(";").find((d) => d.trim().startsWith("script-src")) ?? "";
    const sources = scriptSrc.trim().split(/\s+/).slice(1); // drop the directive name
    expect(scriptSrc).not.toContain("*");
    // No bare-scheme source (e.g. `https:` / `http:`) that would allow ANY host.
    expect(sources).not.toContain("https:");
    expect(sources).not.toContain("http:");
    // Every source is either a keyword or a fully-qualified https host.
    for (const src of sources) {
      const isKeyword = src.startsWith("'") && src.endsWith("'");
      const isHttpsHost = src.startsWith("https://");
      expect(isKeyword || isHttpsHost).toBe(true);
    }
    // The documented, required relaxations for Astro island hydration + the
    // font-link onload handler. Hosts beyond these are explicit allowlist only.
    expect(sources).toContain("'self'");
    expect(sources).toContain("'unsafe-inline'");
  });

  it("allows inline element style attributes via style-src-attr", () => {
    expect(csp).toMatch(/style-src-attr 'unsafe-inline'/);
  });

  it("wires the first-party CSP report collector via report-uri + report-to", () => {
    // Legacy report-uri (a URL) targeting the first-party cire-api collector.
    expect(csp).toContain(`report-uri ${CSP_REPORT_ENDPOINT}`);
    expect(CSP_REPORT_ENDPOINT).toBe("https://api.cireweddings.com/api/csp-report");
    // Modern Reporting API report-to (a group name resolved by Reporting-Endpoints).
    expect(csp).toContain("report-to csp-endpoint");
  });

  it("serialises directives as `name a b; name c` joined by '; '", () => {
    const built = buildCsp({
      "default-src": ["'self'"],
      "frame-ancestors": ["'none'"],
    });
    expect(built).toBe("default-src 'self'; frame-ancestors 'none'");
  });

  it("emits a bare directive name when its source list is empty", () => {
    expect(buildCsp({ "upgrade-insecure-requests": [] })).toBe("upgrade-insecure-requests");
  });

  it("covers every CSP_DIRECTIVES entry in the serialised string", () => {
    for (const name of Object.keys(CSP_DIRECTIVES)) {
      expect(csp).toContain(name);
    }
  });
});

describe("securityHeaders", () => {
  const headers = securityHeaders();

  it("includes the CSP plus the four classic hardening headers", () => {
    expect(headers[cspHeaderName()]).toBe(buildCsp());
    expect(headers["X-Content-Type-Options"]).toBe("nosniff");
    expect(headers["Referrer-Policy"]).toBe("strict-origin-when-cross-origin");
    expect(headers["X-Frame-Options"]).toBe("DENY");
    expect(headers["Permissions-Policy"]).toBe("camera=(), microphone=(), geolocation=()");
  });

  it("emits Reporting-Endpoints resolving the report-to group to the collector", () => {
    expect(headers["Reporting-Endpoints"]).toBe(
      'csp-endpoint="https://api.cireweddings.com/api/csp-report"',
    );
    expect(headers["Reporting-Endpoints"]).toBe(reportingEndpointsHeader());
  });
});

describe("applySecurityHeaders", () => {
  it("attaches every security header to a Headers instance", () => {
    const h = new Headers();
    applySecurityHeaders(h);
    expect(h.get(cspHeaderName())).toContain("frame-ancestors 'none'");
    expect(h.get(cspHeaderName())).toContain("report-to csp-endpoint");
    expect(h.get("Reporting-Endpoints")).toBe(
      'csp-endpoint="https://api.cireweddings.com/api/csp-report"',
    );
    expect(h.get("X-Content-Type-Options")).toBe("nosniff");
    expect(h.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
    expect(h.get("X-Frame-Options")).toBe("DENY");
    expect(h.get("Permissions-Policy")).toBe("camera=(), microphone=(), geolocation=()");
  });

  it("does not clobber a header a route already set", () => {
    const h = new Headers({ "X-Frame-Options": "SAMEORIGIN" });
    applySecurityHeaders(h);
    expect(h.get("X-Frame-Options")).toBe("SAMEORIGIN");
    // ...but still fills in the ones that were absent.
    expect(h.get(cspHeaderName())).toBeTruthy();
  });
});
