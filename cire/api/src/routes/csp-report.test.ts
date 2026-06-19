import { describe, it, expect } from "bun:test";

import { createRateLimiter } from "@shared/rate-limit";

import { createApp } from "../app";
import { createDb, seedDb } from "../db/setup";
import { normaliseCspReports, reduceBlockedUri, reduceDocumentPath } from "./csp-report";

// The collector is keyed per-IP and fail-closed on an unresolved IP, so every
// request needs a resolvable `cf-connecting-ip` (simulates the CF edge).
const TEST_CF_IP = "203.0.113.42";

function buildApp() {
  const db = createDb(":memory:");
  seedDb(db);
  // Generous limiter so the multi-request tests don't trip it.
  const app = createApp(db, {
    cspReportLimiter: createRateLimiter({ maxRequests: 10_000, windowMs: 60_000 }),
  });
  return app;
}

function post(
  app: ReturnType<typeof createApp>,
  opts: { contentType: string; body: string; ip?: string; contentLength?: string },
): Promise<Response> {
  const headers: Record<string, string> = {
    "Content-Type": opts.contentType,
    "cf-connecting-ip": opts.ip ?? TEST_CF_IP,
  };
  if (opts.contentLength !== undefined) headers["Content-Length"] = opts.contentLength;
  return app.fetch(
    new Request("http://localhost/api/csp-report", {
      method: "POST",
      headers,
      body: opts.body,
    }),
  );
}

// ---------------------------------------------------------------------------
// Pure normalisation helpers.
// ---------------------------------------------------------------------------

describe("reduceBlockedUri", () => {
  it("reduces a full URL with a query string to its origin (no PII leak)", () => {
    expect(reduceBlockedUri("https://evil.example.com/path?code=SECRET-1234#frag")).toBe(
      "https://evil.example.com",
    );
  });

  it("keeps the port in the origin", () => {
    expect(reduceBlockedUri("http://localhost:8787/api/invite/x?y=1")).toBe(
      "http://localhost:8787",
    );
  });

  it("passes through CSP keyword tokens verbatim (inline/eval/self)", () => {
    expect(reduceBlockedUri("inline")).toBe("inline");
    expect(reduceBlockedUri("eval")).toBe("eval");
    expect(reduceBlockedUri("self")).toBe("self");
  });

  it("truncates an unparseable long token to 128 chars", () => {
    const long = "x".repeat(500);
    expect(reduceBlockedUri(long).length).toBe(128);
  });

  it("returns empty string for non-strings / empty", () => {
    expect(reduceBlockedUri(undefined)).toBe("");
    expect(reduceBlockedUri(123)).toBe("");
    expect(reduceBlockedUri("")).toBe("");
  });
});

describe("reduceDocumentPath", () => {
  it("strips the query string (a claim code could ride there) keeping the path", () => {
    expect(reduceDocumentPath("https://cireweddings.com/smith-jones?code=NGUYEN-ABCD")).toBe(
      "/smith-jones",
    );
  });

  it("strips a fragment too", () => {
    expect(reduceDocumentPath("https://cireweddings.com/smith-jones#story")).toBe("/smith-jones");
  });

  it("keeps a bare path (non-absolute) but drops its query", () => {
    expect(reduceDocumentPath("/the-wedding?code=X")).toBe("/the-wedding");
  });
});

describe("normaliseCspReports", () => {
  it("parses the legacy report-uri `{ csp-report }` shape", () => {
    const body = {
      "csp-report": {
        "document-uri": "https://cireweddings.com/slug?code=SECRET",
        "violated-directive": "script-src https://evil.example",
        "effective-directive": "script-src",
        "blocked-uri": "https://evil.example/x.js?t=1",
        disposition: "report",
      },
    };
    const out = normaliseCspReports(body);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({
      effectiveDirective: "script-src",
      blockedUri: "https://evil.example",
      documentPath: "/slug",
      disposition: "report",
    });
  });

  it("parses a Reporting-API array, one normalised entry per report", () => {
    const body = [
      {
        type: "csp-violation",
        body: {
          documentURL: "https://cireweddings.com/a?code=Z",
          effectiveDirective: "img-src",
          blockedURL: "https://i.evil.example/p.png?q=1",
          disposition: "report",
        },
      },
      {
        type: "csp-violation",
        body: {
          documentURL: "https://cireweddings.com/b",
          effectiveDirective: "connect-src",
          blockedURL: "https://api.evil.example/x",
          disposition: "enforce",
        },
      },
    ];
    const out = normaliseCspReports(body);
    expect(out).toHaveLength(2);
    expect(out[0]?.effectiveDirective).toBe("img-src");
    expect(out[0]?.blockedUri).toBe("https://i.evil.example");
    expect(out[0]?.documentPath).toBe("/a");
    expect(out[1]?.effectiveDirective).toBe("connect-src");
    expect(out[1]?.disposition).toBe("enforce");
  });

  it("skips non-csp-violation entries in a Reporting-API array", () => {
    const body = [
      { type: "deprecation", body: { id: "x" } },
      {
        type: "csp-violation",
        body: { effectiveDirective: "font-src", blockedURL: "https://f.example/a.woff2" },
      },
    ];
    const out = normaliseCspReports(body);
    expect(out).toHaveLength(1);
    expect(out[0]?.effectiveDirective).toBe("font-src");
  });

  it("falls back to violatedDirective when effectiveDirective is absent", () => {
    const out = normaliseCspReports({
      "csp-report": { "violated-directive": "style-src 'self'", "blocked-uri": "inline" },
    });
    expect(out[0]?.effectiveDirective).toBe("style-src 'self'");
    expect(out[0]?.blockedUri).toBe("inline");
  });

  it("tolerates malformed shapes by returning []", () => {
    expect(normaliseCspReports(null)).toEqual([]);
    expect(normaliseCspReports("not an object")).toEqual([]);
    expect(normaliseCspReports(42)).toEqual([]);
    expect(normaliseCspReports({})).toEqual([]);
    expect(normaliseCspReports({ "csp-report": "nope" })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Route integration — always 204, abuse-hardened.
// ---------------------------------------------------------------------------

describe("POST /api/csp-report", () => {
  it("accepts a legacy application/csp-report body → 204, empty", async () => {
    const app = buildApp();
    const res = await post(app, {
      contentType: "application/csp-report",
      body: JSON.stringify({
        "csp-report": {
          "document-uri": "https://cireweddings.com/slug?code=SECRET",
          "effective-directive": "script-src",
          "blocked-uri": "https://evil.example/x.js",
          disposition: "report",
        },
      }),
    });
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
  });

  it("accepts a Reporting-API application/reports+json array → 204", async () => {
    const app = buildApp();
    const res = await post(app, {
      contentType: "application/reports+json",
      body: JSON.stringify([
        {
          type: "csp-violation",
          body: {
            documentURL: "https://cireweddings.com/a",
            effectiveDirective: "img-src",
            blockedURL: "https://i.evil.example/p.png",
            disposition: "report",
          },
        },
        {
          type: "csp-violation",
          body: {
            documentURL: "https://cireweddings.com/b",
            effectiveDirective: "frame-src",
            blockedURL: "https://x.evil.example/",
            disposition: "report",
          },
        },
      ]),
    });
    expect(res.status).toBe(204);
  });

  it("returns 204 on a malformed (non-JSON) body without crashing", async () => {
    const app = buildApp();
    const res = await post(app, {
      contentType: "application/csp-report",
      body: "}{ this is not json",
    });
    expect(res.status).toBe(204);
  });

  it("returns 204 and drops an oversized body declared via Content-Length", async () => {
    const app = buildApp();
    const res = await post(app, {
      contentType: "application/csp-report",
      body: "{}",
      contentLength: String(64 * 1024),
    });
    expect(res.status).toBe(204);
  });

  it("returns 204 and drops an oversized body even if Content-Length lies", async () => {
    const app = buildApp();
    const big = JSON.stringify({ "csp-report": { "blocked-uri": "x".repeat(20 * 1024) } });
    const res = await post(app, { contentType: "application/csp-report", body: big });
    expect(res.status).toBe(204);
  });

  it("is reachable cross-origin / Origin-less (the CSRF guard does not gate it)", async () => {
    const app = buildApp();
    // A real browser CSP report carries no claim cookie and a cross-origin (or
    // absent) Origin — assert the origin guard never 403s this route.
    const res = await app.fetch(
      new Request("http://localhost/api/csp-report", {
        method: "POST",
        headers: {
          "Content-Type": "application/csp-report",
          "cf-connecting-ip": TEST_CF_IP,
          Origin: "https://cireweddings.com",
        },
        body: JSON.stringify({ "csp-report": { "effective-directive": "img-src" } }),
      }),
    );
    expect(res.status).toBe(204);
  });

  it("rate-limits to 204 (never 429/500) and keeps draining reports", async () => {
    const db = createDb(":memory:");
    seedDb(db);
    const app = createApp(db, {
      cspReportLimiter: createRateLimiter({ maxRequests: 1, windowMs: 60_000 }),
    });
    const first = await post(app, {
      contentType: "application/csp-report",
      body: JSON.stringify({ "csp-report": { "effective-directive": "img-src" } }),
    });
    const second = await post(app, {
      contentType: "application/csp-report",
      body: JSON.stringify({ "csp-report": { "effective-directive": "img-src" } }),
    });
    // Both 204 — the limiter drop is silent (fail-open), never a 429.
    expect(first.status).toBe(204);
    expect(second.status).toBe(204);
  });
});
