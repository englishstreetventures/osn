import { describe, it, expect } from "bun:test";

import { createRateLimiter } from "@shared/rate-limit";

import { createApp } from "../../src/app";
import { createDb, seedDb } from "../../src/db/setup";
import { CIRE_METRICS } from "../../src/metrics";
import {
  createCspSiteResolver,
  normaliseCspReports,
  reduceBlockedUri,
  reduceDocumentOrigin,
  reduceDocumentPath,
} from "../../src/routes/csp-report";
import { counterValue } from "../test-helpers/metrics-harness";

// The collector is keyed per-IP and fail-closed on an unresolved IP, so every
// request needs a resolvable `cf-connecting-ip` (simulates the CF edge).
const TEST_CF_IP = "203.0.113.42";

// The production tier's site origins, read from the committed `WEB_ORIGIN`
// (guest invite, organiser portal, vendor portal — the order `src/index.ts`
// maps onto `webOrigin`, `organiserOrigin` and `vendorPortalOrigin`).
const committedToml = await Bun.file(new URL("../../wrangler.toml", import.meta.url)).text();
const productionOrigins = (
  Bun.TOML.parse(committedToml) as { env: { production: { vars: { WEB_ORIGIN: string } } } }
).env.production.vars.WEB_ORIGIN.split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

function productionOrigin(index: number): string {
  const origin = productionOrigins[index];
  if (!origin) throw new Error(`production WEB_ORIGIN has no entry ${index + 1}`);
  return origin;
}

const INVITES_ORIGIN = productionOrigin(0);
const HOST_ORIGIN = productionOrigin(1);
const VENDOR_ORIGIN = productionOrigin(2);

function buildApp() {
  const db = createDb(":memory:");
  seedDb(db);
  // Generous limiter so the multi-request tests don't trip it.
  const app = createApp(db, {
    webOrigin: INVITES_ORIGIN,
    organiserOrigin: HOST_ORIGIN,
    vendorPortalOrigin: VENDOR_ORIGIN,
    cspReportLimiter: createRateLimiter({ maxRequests: 10_000, windowMs: 60_000 }),
  });
  return app;
}

/** The counter's value for one whole attribute set (see the metrics harness). */
const cspReportCount = (attrs: { effectiveDirective: string; site: string; disposition: string }) =>
  counterValue(CIRE_METRICS.cspReport, attrs);

function post(
  app: ReturnType<typeof createApp>,
  opts: { contentType: string; body: string; ip?: string; contentLength?: string },
): Promise<Response> {
  const headers: Record<string, string> = {
    "Content-Type": opts.contentType,
    "cf-connecting-ip": opts.ip ?? TEST_CF_IP,
  };
  if (opts.contentLength !== undefined) headers["Content-Length"] = opts.contentLength;
  return Promise.resolve(
    app.fetch(
      new Request("http://localhost/api/csp-report", {
        method: "POST",
        headers,
        body: opts.body,
      }),
    ),
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

describe("reduceDocumentOrigin", () => {
  it("keeps only the origin, dropping the path, query and fragment", () => {
    expect(reduceDocumentOrigin("https://invite.cireweddings.com/smith-jones?code=AB#story")).toBe(
      "https://invite.cireweddings.com",
    );
  });

  it("keeps the port", () => {
    expect(reduceDocumentOrigin("http://localhost:4321/login")).toBe("http://localhost:4321");
  });

  it("drops userinfo", () => {
    expect(reduceDocumentOrigin("https://user:secret@host.cireweddings.com/login")).toBe(
      "https://host.cireweddings.com",
    );
  });

  it("returns empty string for a relative path or a document with an opaque origin", () => {
    expect(reduceDocumentOrigin("/the-wedding?code=X")).toBe("");
    expect(reduceDocumentOrigin("about:blank")).toBe("");
  });

  it("returns empty string for non-strings / empty", () => {
    expect(reduceDocumentOrigin(undefined)).toBe("");
    expect(reduceDocumentOrigin(123)).toBe("");
    expect(reduceDocumentOrigin("")).toBe("");
  });
});

describe("createCspSiteResolver", () => {
  const siteOf = createCspSiteResolver({
    invites: INVITES_ORIGIN,
    host: HOST_ORIGIN,
    vendor: VENDOR_ORIGIN,
  });

  it("labels each configured site origin", () => {
    expect(siteOf(INVITES_ORIGIN)).toBe("invites");
    expect(siteOf(HOST_ORIGIN)).toBe("host");
    expect(siteOf(VENDOR_ORIGIN)).toBe("vendor");
  });

  it("buckets any other origin, and a missing one, as other", () => {
    expect(siteOf("https://cireweddings.com")).toBe("other");
    expect(siteOf("https://evil.example")).toBe("other");
    expect(siteOf("")).toBe("other");
  });

  it("matches a configured value written with a trailing slash, and skips one that is not a URL", () => {
    const lenient = createCspSiteResolver({
      invites: `${INVITES_ORIGIN}/`,
      host: "not a url",
      vendor: VENDOR_ORIGIN,
    });
    expect(lenient(INVITES_ORIGIN)).toBe("invites");
    expect(lenient("not a url")).toBe("other");
    expect(lenient(VENDOR_ORIGIN)).toBe("vendor");
  });

  it("gives an origin configured for two sites to the first, in invites, host, vendor order", () => {
    const shared = createCspSiteResolver({
      invites: VENDOR_ORIGIN,
      host: HOST_ORIGIN,
      vendor: VENDOR_ORIGIN,
    });
    expect(shared(VENDOR_ORIGIN)).toBe("invites");
  });
});

describe("normaliseCspReports", () => {
  it("parses the legacy report-uri `{ csp-report }` shape", () => {
    const body = {
      "csp-report": {
        "document-uri": "https://invite.cireweddings.com/slug?code=SECRET",
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
      documentOrigin: "https://invite.cireweddings.com",
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
    expect(out[0]?.documentOrigin).toBe("https://cireweddings.com");
    expect(out[0]?.documentPath).toBe("/a");
    expect(out[0]?.disposition).toBe("report");
    expect(out[1]?.effectiveDirective).toBe("connect-src");
    expect(out[1]?.disposition).toBe("enforce");
  });

  it("reads a missing or unrecognised disposition as unknown, in both wire formats", () => {
    const legacyMissing = normaliseCspReports({
      "csp-report": { "effective-directive": "img-src" },
    });
    const legacyOdd = normaliseCspReports({
      "csp-report": { "effective-directive": "img-src", disposition: "block" },
    });
    const reportingApi = normaliseCspReports([
      { type: "csp-violation", body: { effectiveDirective: "img-src" } },
      { type: "csp-violation", body: { effectiveDirective: "img-src", disposition: 7 } },
    ]);
    expect(legacyMissing[0]?.disposition).toBe("unknown");
    expect(legacyOdd[0]?.disposition).toBe("unknown");
    expect(reportingApi.map((v) => v.disposition)).toEqual(["unknown", "unknown"]);
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
    const attrs = { effectiveDirective: "media-src", site: "vendor", disposition: "enforce" };
    const body = JSON.stringify({
      "csp-report": {
        "document-uri": `${VENDOR_ORIGIN}/listing`,
        "effective-directive": "media-src",
        disposition: "enforce",
      },
    });
    const before = await cspReportCount(attrs);
    const res = await post(app, {
      contentType: "application/csp-report",
      body,
      contentLength: String(64 * 1024),
    });
    expect(res.status).toBe(204);
    expect(await cspReportCount(attrs)).toBe(before);

    // Control: the same body under its true length is counted, so the
    // unchanged count above is the size cap's doing.
    await post(app, { contentType: "application/csp-report", body });
    expect(await cspReportCount(attrs)).toBe(before + 1);
  });

  it("returns 204 and drops an oversized body even if Content-Length lies", async () => {
    const app = buildApp();
    const attrs = { effectiveDirective: "worker-src", site: "vendor", disposition: "enforce" };
    const report = {
      "document-uri": `${VENDOR_ORIGIN}/listing`,
      "effective-directive": "worker-src",
      disposition: "enforce",
    };
    const before = await cspReportCount(attrs);
    const big = JSON.stringify({
      "csp-report": { ...report, "script-sample": "x".repeat(20 * 1024) },
    });
    const res = await post(app, { contentType: "application/csp-report", body: big });
    expect(res.status).toBe(204);
    expect(await cspReportCount(attrs)).toBe(before);

    // Control: the same report without the padding is counted.
    await post(app, {
      contentType: "application/csp-report",
      body: JSON.stringify({ "csp-report": report }),
    });
    expect(await cspReportCount(attrs)).toBe(before + 1);
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

// ---------------------------------------------------------------------------
// The `cire.csp.report` counter's bounded attributes.
// ---------------------------------------------------------------------------

describe("POST /api/csp-report counts by directive, site and disposition", () => {
  it("counts a legacy report from the organiser portal as host, enforce", async () => {
    const app = buildApp();
    const attrs = { effectiveDirective: "img-src", site: "host", disposition: "enforce" };
    const before = await cspReportCount(attrs);
    const res = await post(app, {
      contentType: "application/csp-report",
      body: JSON.stringify({
        "csp-report": {
          "document-uri": `${HOST_ORIGIN}/login?next=%2F`,
          "effective-directive": "img-src",
          "blocked-uri": "https://avatars.example/a.png",
          disposition: "enforce",
        },
      }),
    });
    expect(res.status).toBe(204);
    expect(await cspReportCount(attrs)).toBe(before + 1);
  });

  it("counts each Reporting-API entry by its own document's site", async () => {
    const app = buildApp();
    const invitesAttrs = {
      effectiveDirective: "script-src",
      site: "invites",
      disposition: "report",
    };
    const vendorAttrs = {
      effectiveDirective: "connect-src",
      site: "vendor",
      disposition: "enforce",
    };
    const invitesBefore = await cspReportCount(invitesAttrs);
    const vendorBefore = await cspReportCount(vendorAttrs);
    const res = await post(app, {
      contentType: "application/reports+json",
      body: JSON.stringify([
        {
          type: "csp-violation",
          body: {
            documentURL: `${INVITES_ORIGIN}/smith-jones?code=SECRET`,
            effectiveDirective: "script-src",
            blockedURL: "https://cdn.example/x.js",
            disposition: "report",
          },
        },
        {
          type: "csp-violation",
          body: {
            documentURL: `${VENDOR_ORIGIN}/enquiries`,
            effectiveDirective: "connect-src",
            blockedURL: "https://api.example/x",
            disposition: "enforce",
          },
        },
      ]),
    });
    expect(res.status).toBe(204);
    expect(await cspReportCount(invitesAttrs)).toBe(invitesBefore + 1);
    expect(await cspReportCount(vendorAttrs)).toBe(vendorBefore + 1);
  });

  it("counts a report from an unlisted origin with no disposition as other, unknown", async () => {
    const app = buildApp();
    const attrs = { effectiveDirective: "font-src", site: "other", disposition: "unknown" };
    const before = await cspReportCount(attrs);
    await post(app, {
      contentType: "application/csp-report",
      body: JSON.stringify({
        "csp-report": {
          "document-uri": "https://cireweddings.com/",
          "effective-directive": "font-src",
          "blocked-uri": "https://fonts.example/a.woff2",
        },
      }),
    });
    expect(await cspReportCount(attrs)).toBe(before + 1);
  });
});
