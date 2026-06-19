import type { RateLimiterBackend } from "@shared/rate-limit";
import { Effect } from "effect";
import { Elysia } from "elysia";

import { getClientIp, isUnresolvedIp } from "../lib/client-ip";
import { bucketCspDirective, metricCspReport } from "../metrics";
import { runCire } from "../observability";

/**
 * Public, unauthenticated CSP violation-report collector.
 *
 * The guest site (`cire/web`) ships its Content-Security-Policy in Report-Only
 * mode and points `report-uri` / `report-to` here, so real guests' browsers
 * POST a JSON document describing anything the policy WOULD block. This route
 * normalises the two wire formats, logs a small bounded slice of each violation
 * to observability (Workers Logs / Grafana), bumps a bounded-cardinality metric,
 * and ALWAYS answers `204 No Content` — reflecting nothing back.
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
 *    origin** (or truncated), the document **path only** (query/hash stripped —
 *    a claim code could ride in the query), and the disposition. Never the full
 *    URL. The document path can contain a public wedding slug — that is not PII.
 */

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
  /** The document the violation occurred on — PATH ONLY (query/hash stripped). */
  documentPath: string;
  /** `"enforce"` or `"report"` (Report-Only). Free-ish but bounded by browsers. */
  disposition: string;
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
 * Reduce a document URL to its PATH only (query + hash stripped). A guest-site
 * document URL is `https://cireweddings.com/<slug>?code=…` — the slug is public
 * but the query can carry a claim code, so we keep only the path. Truncated to
 * {@link MAX_FIELD_CHARS}. A non-absolute value is treated as a path already.
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

/** Coerce a disposition into a short bounded string (defaults to `"report"`). */
function reduceDisposition(raw: unknown): string {
  return typeof raw === "string" && raw.length > 0 ? raw.slice(0, 32) : "report";
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
      if (!entry || typeof entry !== "object") continue;
      const rec = entry as Record<string, unknown>;
      // Only CSP-violation reports — a `report-to` group can be shared.
      if (rec.type !== undefined && rec.type !== "csp-violation") continue;
      const inner = (rec.body ?? {}) as Record<string, unknown>;
      out.push({
        effectiveDirective: pickDirective(inner.effectiveDirective, inner.violatedDirective),
        blockedUri: reduceBlockedUri(inner.blockedURL),
        documentPath: reduceDocumentPath(inner.documentURL),
        disposition: reduceDisposition(inner.disposition),
      });
    }
    return out;
  }

  // Legacy report-uri: a single `{ "csp-report": { … } }` object.
  if (body && typeof body === "object") {
    const inner = (body as Record<string, unknown>)["csp-report"];
    if (inner && typeof inner === "object") {
      const rec = inner as Record<string, unknown>;
      return [
        {
          effectiveDirective: pickDirective(rec["effective-directive"], rec["violated-directive"]),
          blockedUri: reduceBlockedUri(rec["blocked-uri"]),
          documentPath: reduceDocumentPath(rec["document-uri"]),
          disposition: reduceDisposition(rec.disposition),
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

/** Log + count one normalised violation. Bounded fields only; no PII. */
function recordViolation(v: NormalisedCspViolation): Promise<void> {
  metricCspReport(bucketCspDirective(v.effectiveDirective));
  return runCire(
    Effect.logWarning("csp violation report", {
      effectiveDirective: v.effectiveDirective,
      blockedUri: v.blockedUri,
      documentPath: v.documentPath,
      disposition: v.disposition,
    }),
  );
}

export interface CspReportRouteOptions {
  /** Per-IP rate limiter (generous bucket — just stops log-spam DoS). */
  limiter: RateLimiterBackend;
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
export const createCspReportRoutes = ({ limiter }: CspReportRouteOptions) =>
  new Elysia({ prefix: "/api/csp-report" }).post(
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
