/**
 * ARC token metrics — S2S auth observability.
 *
 * Single source of truth for ARC metric names and typed counters.
 * All ARC token code MUST import these helpers; never construct OTel
 * instruments directly. See `CLAUDE.md` "Observability" section.
 */

import { createCounter } from "@shared/observability/metrics";
import type { ArcVerifyResult } from "@shared/observability/metrics";

/** Canonical metric names for ARC — grep-able, refactor-safe. */
export const ARC_METRICS = {
  tokenIssued: "arc.token.issued",
  tokenVerification: "arc.token.verification",
  tokenCacheHits: "arc.token.cache.hits",
  tokenCacheMisses: "arc.token.cache.misses",
  publicKeyCacheHits: "arc.token.public_key.cache.hits",
  publicKeyCacheMisses: "arc.token.public_key.cache.misses",
} as const;

/**
 * Attribute shapes. All values are bounded string-literal unions — high
 * cardinality values (user IDs, request IDs) are forbidden.
 *
 * `iss` and `aud` are typed as `string` because the set is determined
 * at runtime by the `service_accounts` table, not at compile time.
 * Cardinality is enforced by `safeIssuer()` below: any value that
 * doesn't match a strict service-ID regex is bucketed into `"unknown"`.
 * Callers must never pass unverified external input directly — see
 * S-C2 + the docstring on each recording helper.
 */
type ArcIssuedAttrs = {
  iss: string;
  aud: string;
};

type ArcVerificationAttrs = {
  iss: string;
  result: ArcVerifyResult;
};

type ArcCacheAttrs = {
  iss: string;
};

/**
 * Runtime cardinality guard.
 *
 * Valid OSN service IDs are short lowercase identifiers matching
 * /^[a-z][a-z0-9-]{1,30}$/ (e.g. `pulse-api`, `osn-core`, `zap-api`).
 * Any value outside that shape — including CRLF, unicode, excessive
 * length, or attacker-crafted randomness — collapses to `"unknown"`
 * so cardinality stays bounded even if a caller accidentally forwards
 * unverified input. This is defence-in-depth on top of the call-site
 * check in arc.ts (S-C2).
 */
const SERVICE_ID_RE = /^[a-z][a-z0-9-]{1,30}$/;
const safeIssuer = (iss: string): string => (SERVICE_ID_RE.test(iss) ? iss : "unknown");

/** Total ARC tokens minted by this service. Increment on successful sign. */
const tokenIssuedCounter = createCounter<ArcIssuedAttrs>({
  name: ARC_METRICS.tokenIssued,
  description: "ARC tokens minted (service-to-service auth)",
  unit: "{token}",
});

/** Total ARC token verifications, labelled by outcome. */
const tokenVerificationCounter = createCounter<ArcVerificationAttrs>({
  name: ARC_METRICS.tokenVerification,
  description: "ARC token verification outcomes",
  unit: "{verification}",
});

const tokenCacheHitsCounter = createCounter<ArcCacheAttrs>({
  name: ARC_METRICS.tokenCacheHits,
  description: "ARC token cache hits (avoided re-signing)",
  unit: "{hit}",
});

const tokenCacheMissesCounter = createCounter<ArcCacheAttrs>({
  name: ARC_METRICS.tokenCacheMisses,
  description: "ARC token cache misses (new sign required)",
  unit: "{miss}",
});

const publicKeyCacheHitsCounter = createCounter<ArcCacheAttrs>({
  name: ARC_METRICS.publicKeyCacheHits,
  description: "ARC public key cache hits (avoided DB lookup)",
  unit: "{hit}",
});

const publicKeyCacheMissesCounter = createCounter<ArcCacheAttrs>({
  name: ARC_METRICS.publicKeyCacheMisses,
  description: "ARC public key cache misses (DB lookup required)",
  unit: "{miss}",
});

// ---------------------------------------------------------------------------
// Public recording helpers — the ONLY way ARC code should emit metrics.
// ---------------------------------------------------------------------------

export const metricArcTokenIssued = (iss: string, aud: string): void =>
  tokenIssuedCounter.inc({ iss: safeIssuer(iss), aud: safeIssuer(aud) });

export const metricArcTokenVerification = (iss: string, result: ArcVerifyResult): void =>
  tokenVerificationCounter.inc({ iss: safeIssuer(iss), result });

export const metricArcTokenCacheHit = (iss: string): void =>
  tokenCacheHitsCounter.inc({ iss: safeIssuer(iss) });

export const metricArcTokenCacheMiss = (iss: string): void =>
  tokenCacheMissesCounter.inc({ iss: safeIssuer(iss) });

export const metricArcPublicKeyCacheHit = (iss: string): void =>
  publicKeyCacheHitsCounter.inc({ iss: safeIssuer(iss) });

export const metricArcPublicKeyCacheMiss = (iss: string): void =>
  publicKeyCacheMissesCounter.inc({ iss: safeIssuer(iss) });

/**
 * Classify an `ArcTokenError` (or any caught exception) into a bounded
 * `ArcVerifyResult` for the verification counter. Unknown errors collapse
 * to `"bad_signature"` to avoid expanding the attribute cardinality.
 */
export const classifyArcVerifyError = (err: unknown): ArcVerifyResult => {
  if (err instanceof Error) {
    const m = err.message.toLowerCase();
    if (m.includes("expired")) return "expired";
    if (m.includes("audience")) return "audience_mismatch";
    // NOTE: the more-specific "missing scope claim" branch MUST come
    // before the generic "scope" branch — the generic one would
    // otherwise swallow it and mis-classify as scope_denied.
    if (m.includes("missing scope claim")) return "malformed";
    if (m.includes("scope")) return "scope_denied";
    if (m.includes("unknown service")) return "unknown_issuer";
    if (m.includes("invalid public key")) return "unknown_issuer";
  }
  return "bad_signature";
};
