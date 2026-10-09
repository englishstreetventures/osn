/**
 * Public, unauthenticated CSP violation-report collector.
 *
 * Three sites point `report-uri` / `report-to` here: the guest site
 * (`cire/invites`, Report-Only — the browser reports what the policy WOULD
 * block), and the organiser portal (`cire/host`) and vendor portal
 * (`cire/vendor`), which enforce theirs and report each block. Browsers POST a
 * JSON document per violation. This route normalises the two wire formats, logs
 * a small bounded slice of each violation to observability (Workers Logs /
 * Grafana) labelled with the site it came from and its disposition, bumps a
 * bounded-cardinality metric, and ALWAYS answers `204 No Content` — reflecting
 * nothing back.
 *
 * WHY THIS IS DELIBERATELY MINIMAL + ABUSE-HARDENED (it is PUBLIC + creds-less —
 * any browser, or a script pretending to be one, can POST here):
 *  - **204 always.** Even on a malformed/oversized body or a limiter hiccup. A
 *    dropped report is fine; this is a fire-and-forget telemetry sink, never an
 *    API a caller depends on. We never 500 (no error surface to probe) and never
 *    echo input (no reflected-XSS / oracle).
 *  - **Body size cap (16 KB).** Reports are tiny. We reject early on a declared
 *    `Content-Length` and again guard the read, so a giant body can't drive log
 *    bloat or parse cost.
 *  - **Per-IP rate limit.** A generous bucket (≈60/min) purely to stop a
 *    log-spam DoS — fail-OPEN here (a 429-equivalent just drops the report; we
 *    still 204) because spamming the limiter is itself the only thing it guards.
 *  - **No D1 write.** Avoids a write-amplification DoS — log + metric only.
 *  - **No Turnstile, no Origin/auth requirement.** Browsers send CSP reports as
 *    an automated POST with no creds and (for `report-to`) cross-origin without
 *    a CORS preflight, so any such gate would simply discard every real report.
 *  - **PII discipline.** We log the directive, the blocked URI **reduced to its
 *    origin** (or truncated), the document's **origin** and **path** as two
 *    separate fields (query/hash stripped — a claim code could ride in the
 *    query), the site label and the disposition. Never the full URL. The
 *    document path can contain a public wedding slug — that is not PII.
 *  - **Bounded labels.** The site is one of the configured guest, organiser
 *    and vendor origins or `other`; the disposition is `enforce`, `report` or
 *    `unknown`. Neither ever carries a browser-supplied string.
 */
import type { RateLimiterBackend } from "@shared/rate-limit";
import { Effect } from "effect";
import { Elysia } from "elysia";

import { getClientIp, isUnresolvedIp } from "../lib/client-ip";
import {
  bucketCspDirective,
  bucketCspDisposition,
  metricCspReport,
  type CspDisposition,
  type CspSite,
} from "../metrics";
import { runCire } from "../observability";

/** Reports above this many bytes are dropped unparsed (a real report is ~1 KB). */
const MAX_REPORT_BYTES = 16 * 1024;

/** Cap on every logged URI/path field, as a coarse log-bloat backstop. */
const MAX_FIELD_CHARS = 128;

/** The normalised, bounded slice of a single CSP violation we log + count. */
export interface NormalisedCspViolation {
  /** The (effective) directive that was violated, raw-ish for the log line. */
  effectiveDirective: string;
  /** The blocked resource reduced to its origin, or truncated to 128 chars. */
  blockedUri: string;
  /** The document's `scheme://host[:port]` origin, or `""` when it has none. */
  documentOrigin: string;
  /** The document the violation occurred on — PATH ONLY (query/hash stripped). */
  documentPath: string;
  /** Whether the browser blocked the load or only reported it; bounded. */
  disposition: CspDisposition;
}

/*
 * THE TWO WIRE SHAPES, NAMED.
 *
 * Both are documented formats with a fixed field list, so the normaliser reads
 * declared keys rather than indexing an open dictionary. Every field stays
 * `unknown`: this is an untrusted browser payload, and a real browser is only
 * one of the things that can POST here. The `reduce*` / `pick*` helpers below
 * (whose parameters take `unknown` on purpose) do all the type checking — the
 * types here say which keys we read, not what a caller may assume about them.
 */

/** Reporting API (`report-to`, `application/reports+json`) — one array entry. */
interface ReportingApiEntry {
  /** Report type; a `report-to` group can be shared with other report kinds. */
  type?: unknown;
  /** The report payload — a {@link CspViolationBody} for a CSP violation. */
  body?: unknown;
}

/** Reporting API — the `body` of a `csp-violation` entry (camelCase fields). */
interface CspViolationBody {
  documentURL?: unknown;
  effectiveDirective?: unknown;
  violatedDirective?: unknown;
  blockedURL?: unknown;
  disposition?: unknown;
}

/** Legacy `report-uri` (`application/csp-report`) — the wrapper document. */
interface LegacyCspReportDocument {
  "csp-report"?: unknown;
}

/** Legacy `report-uri` — the inner report (hyphenated fields). */
interface LegacyCspReport {
  "document-uri"?: unknown;
  "violated-directive"?: unknown;
  "effective-directive"?: unknown;
  "blocked-uri"?: unknown;
  disposition?: unknown;
}

/*
 * One guard per shape. Each only asserts "this is a non-null object" — which is
 * all the wire tells us — and hands the field-level checking to the reducers.
 */

const isJsonObject = (value: unknown): boolean => typeof value === "object" && value !== null;

function isReportingApiEntry(value: unknown): value is ReportingApiEntry {
  return isJsonObject(value);
}

function isCspViolationBody(value: unknown): value is CspViolationBody {
  return isJsonObject(value);
}

function isLegacyCspReportDocument(value: unknown): value is LegacyCspReportDocument {
  return isJsonObject(value);
}

function isLegacyCspReport(value: unknown): value is LegacyCspReport {
  return isJsonObject(value);
}

/**
 * Reduce a blocked-URI to a safe-to-log value: its `scheme://host[:port]` origin
 * when it parses as an absolute URL, otherwise the raw token TRUNCATED to
 * {@link MAX_FIELD_CHARS}. Keyword values the spec emits (`inline`, `eval`,
 * `self`, `data`, `blob`, …) are passed through (already tiny + non-sensitive).
 * Never returns the full URL with its query string (which could carry PII).
 */
export function reduceBlockedUri(raw: unknown): string {
  if (typeof raw !== "string" || raw.length === 0) return "";
  const value = raw.trim();
  // CSP keyword tokens (not URLs) — short + safe, keep verbatim.
  if (!value.includes("://")) return value.slice(0, MAX_FIELD_CHARS);
  try {
    const url = new URL(value);
    // `origin` is `scheme://host[:port]` — drops path, query, and fragment.
    if (url.origin && url.origin !== "null") return url.origin.slice(0, MAX_FIELD_CHARS);
  } catch {
    // fall through to truncation
  }
  return value.slice(0, MAX_FIELD_CHARS);
}

/**
 * Reduce a document URL to its `scheme://host[:port]` origin — never its path,
 * query, fragment or userinfo — truncated to {@link MAX_FIELD_CHARS}. A value
 * that is not an absolute URL, or a document with an opaque origin
 * (`about:blank`, `data:`), gives `""`.
 */
export function reduceDocumentOrigin(raw: unknown): string {
  if (typeof raw !== "string" || raw.length === 0) return "";
  try {
    const { origin } = new URL(raw.trim());
    return origin === "null" ? "" : origin.slice(0, MAX_FIELD_CHARS);
  } catch {
    return "";
  }
}

/**
 * Reduce a document URL to its PATH only (query + hash stripped). A guest-site
 * document URL is `https://invite.cireweddings.com/<slug>?code=…` — the slug is
 * public but the query can carry a claim code, so we keep only the path.
 * Truncated to {@link MAX_FIELD_CHARS}. A non-absolute value is treated as a
 * path already.
 */
export function reduceDocumentPath(raw: unknown): string {
  if (typeof raw !== "string" || raw.length === 0) return "";
  const value = raw.trim();
  try {
    const url = new URL(value);
    return url.pathname.slice(0, MAX_FIELD_CHARS);
  } catch {
    // Not an absolute URL — strip any query/hash by hand, keep the path part.
    const path = value.split(/[?#]/)[0] ?? value;
    return path.slice(0, MAX_FIELD_CHARS);
  }
}

/** Bucket a disposition: `enforce`, `report`, or `unknown` for anything else. */
function reduceDisposition(raw: unknown): CspDisposition {
  return bucketCspDisposition(typeof raw === "string" ? raw : undefined);
}

/**
 * Normalise whatever CSP-report shape arrived into a flat list of bounded
 * violations. Handles BOTH wire formats and tolerates any malformed input by
 * returning `[]` (the caller still answers 204):
 *
 *  - Legacy `report-uri` (`application/csp-report`): a single object
 *    `{ "csp-report": { "document-uri", "violated-directive",
 *    "effective-directive", "blocked-uri", "disposition" } }`.
 *  - Reporting API `report-to` (`application/reports+json`): an ARRAY of
 *    `{ "type": "csp-violation", "body": { "documentURL", "effectiveDirective",
 *    "blockedURL", "disposition" } }` (non-csp-violation entries are skipped).
 */
export function normaliseCspReports(body: unknown): NormalisedCspViolation[] {
  // Reporting-API: an array of report objects.
  if (Array.isArray(body)) {
    const out: NormalisedCspViolation[] = [];
    for (const entry of body) {
      if (!entry || !isReportingApiEntry(entry)) continue;
      // Only CSP-violation reports — a `report-to` group can be shared.
      if (entry.type !== undefined && entry.type !== "csp-violation") continue;
      const inner: CspViolationBody = isCspViolationBody(entry.body) ? entry.body : {};
      out.push({
        effectiveDirective: pickDirective(inner.effectiveDirective, inner.violatedDirective),
        blockedUri: reduceBlockedUri(inner.blockedURL),
        documentOrigin: reduceDocumentOrigin(inner.documentURL),
        documentPath: reduceDocumentPath(inner.documentURL),
        disposition: reduceDisposition(inner.disposition),
      });
    }
    return out;
  }

  // Legacy report-uri: a single `{ "csp-report": { … } }` object.
  if (body && isLegacyCspReportDocument(body)) {
    const inner = body["csp-report"];
    if (inner && isLegacyCspReport(inner)) {
      return [
        {
          effectiveDirective: pickDirective(
            inner["effective-directive"],
            inner["violated-directive"],
          ),
          blockedUri: reduceBlockedUri(inner["blocked-uri"]),
          documentOrigin: reduceDocumentOrigin(inner["document-uri"]),
          documentPath: reduceDocumentPath(inner["document-uri"]),
          disposition: reduceDisposition(inner.disposition),
        },
      ];
    }
  }

  return [];
}

/** Prefer the effective-directive; fall back to the violated-directive; cap it. */
function pickDirective(effective: unknown, violated: unknown): string {
  const value =
    typeof effective === "string" && effective.length > 0
      ? effective
      : typeof violated === "string"
        ? violated
        : "";
  return value.slice(0, MAX_FIELD_CHARS);
}

/** The origin each reporting site is served from on this tier. */
export interface CspSiteOrigins {
  /** The guest site (`cire/invites`) — `WEB_ORIGIN` entry 1. */
  invites: string;
  /** The organiser portal (`cire/host`) — `WEB_ORIGIN` entry 2. */
  host: string;
  /** The vendor portal (`cire/vendor`) — `WEB_ORIGIN` entry 3. */
  vendor: string;
}

/**
 * Build the lookup from a reduced document origin to its {@link CspSite}
 * label. Each configured value is compared by its parsed `URL.origin`, so a
 * trailing slash still matches; a value that does not parse is skipped. When two
 * sites share an origin the first, in invites, host, vendor order, keeps it.
 * Anything not configured — including `""` — is `other`.
 */
export function createCspSiteResolver(
  origins: CspSiteOrigins,
): (documentOrigin: string) => CspSite {
  const byOrigin = new Map<string, CspSite>();
  const sites: readonly Exclude<CspSite, "other">[] = ["invites", "host", "vendor"];
  for (const site of sites) {
    let origin: string;
    try {
      origin = new URL(origins[site]).origin;
    } catch {
      continue;
    }
    if (origin !== "null" && !byOrigin.has(origin)) byOrigin.set(origin, site);
  }
  return (documentOrigin) => byOrigin.get(documentOrigin) ?? "other";
}

export interface CspReportRouteOptions {
  /** Per-IP rate limiter (generous bucket — just stops log-spam DoS). */
  limiter: RateLimiterBackend;
  /** The origins that label a report's site; any other origin is `other`. */
  siteOrigins: CspSiteOrigins;
}

/**
 * `POST /api/csp-report` — the public CSP report collector. Mounted as its own
 * sibling Elysia instance (no auth, no Origin gate) so the app's organiser/guest
 * gates never touch it. Always 204.
 *
 * Unlike the other route factories this one takes NO `Db` — it deliberately does
 * no D1 access (log + metric only, to avoid a write-amplification DoS on a
 * public endpoint).
 */
export const createCspReportRoutes = ({ limiter, siteOrigins }: CspReportRouteOptions) => {
  const siteOf = createCspSiteResolver(siteOrigins);

  /** Log + count one normalised violation. Bounded fields only; no PII. */
  const recordViolation = (v: NormalisedCspViolation): Promise<void> => {
    const site = siteOf(v.documentOrigin);
    metricCspReport({
      effectiveDirective: bucketCspDirective(v.effectiveDirective),
      site,
      disposition: v.disposition,
    });
    return runCire(
      Effect.logWarning("csp violation report", {
        effectiveDirective: v.effectiveDirective,
        blockedUri: v.blockedUri,
        documentOrigin: v.documentOrigin,
        documentPath: v.documentPath,
        site,
        disposition: v.disposition,
      }),
    );
  };

  return new Elysia({ prefix: "/api/csp-report" }).post(
    "/",
    async ({ request, set }) => {
      // Always answer 204, reflect nothing. Set it up front so every early
      // return below is a clean no-content response.
      set.status = 204;

      // 1) Size cap via declared Content-Length (cheap early reject).
      const declared = request.headers.get("content-length");
      if (declared) {
        const n = Number.parseInt(declared, 10);
        if (Number.isFinite(n) && n > MAX_REPORT_BYTES) return null;
      }

      // 2) Per-IP rate limit — FAIL-OPEN: a limiter miss/hiccup or an
      //    unresolved IP just drops the report (we still 204). We never 500 a
      //    fire-and-forget endpoint, and a dropped report is acceptable.
      try {
        const ip = getClientIp(request.headers);
        if (isUnresolvedIp(ip) || !(await limiter.check(ip))) return null;
      } catch {
        return null;
      }

      // 3) Read + size-guard the body, then parse + normalise. Any failure ⇒
      //    drop silently (still 204).
      let raw: string;
      try {
        raw = await request.text();
      } catch {
        return null;
      }
      if (raw.length > MAX_REPORT_BYTES) return null;

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return null;
      }

      const violations = normaliseCspReports(parsed);
      // Best-effort log/metric — never let an observability hiccup throw.
      try {
        await Promise.all(violations.map(recordViolation));
      } catch {
        // swallow — the report is fire-and-forget
      }
      return null;
    },
    // Sentinel parse hook: stop Elysia consuming the body so the handler reads
    // it by hand (and so an `application/reports+json` / `application/csp-report`
    // content-type the framework doesn't model can't trip a parser error).
    { parse: () => ({}) },
  );
};
