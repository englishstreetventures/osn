import type { Db } from "@osn/db/service";
import {
  metricArcTokenVerification,
  resolvePublicKey,
  verifyArcToken,
  type ArcTokenPayload,
} from "@shared/crypto";
import type { ArcVerifyResult } from "@shared/observability/metrics";
import type { Effect } from "effect";

/**
 * Verified ARC caller claims attached to the request context after
 * successful middleware validation.
 */
export interface ArcCaller {
  /** Issuer service ID (e.g. "pulse-api") */
  readonly iss: string;
  /** Audience (this service, e.g. "osn-api") */
  readonly aud: string;
  /** Comma-separated scopes the token was issued with */
  readonly scope: string;
}

/**
 * Extracts the raw token from an `Authorization: ARC <token>` header.
 */
function extractArcToken(authorization: string | undefined): string | null {
  if (!authorization) return null;
  const match = authorization.match(/^ARC\s+(.+)$/i);
  return match ? match[1] : null;
}

/**
 * Decodes a base64url-encoded JWT segment to a plain object.
 * JWT segments use base64url (RFC 7515 §2) — `atob()` only handles standard
 * base64, so we convert `-` → `+` and `_` → `/` first (S-M100).
 */
function decodeJwtSegment(segment: string): unknown {
  const padded =
    segment.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (segment.length % 4)) % 4);
  return JSON.parse(atob(padded));
}

/**
 * Decodes the JWT header and payload without verification to read `kid`,
 * `iss`, and `scope`. Needed to look up the issuer's public key before
 * we can verify the signature. Returns null if the token is malformed.
 *
 * Header is decoded first so malformed/non-ARC tokens short-circuit before
 * the payload decode (P-W101).
 */
function peekClaims(token: string): { kid: string; iss: string; scopes: string[] } | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    // Decode header first — fast-path rejection when `kid` is absent (P-W101).
    const header = decodeJwtSegment(parts[0]) as { kid?: string };
    if (typeof header.kid !== "string") return null;
    const payload = decodeJwtSegment(parts[1]) as { iss?: string; scope?: string };
    if (typeof payload.iss !== "string") return null;
    const scopes =
      typeof payload.scope === "string"
        ? payload.scope
            .split(",")
            .map((s) => s.trim().toLowerCase())
            .filter(Boolean)
        : [];
    return { kid: header.kid, iss: payload.iss, scopes };
  } catch {
    return null;
  }
}

/**
 * ARC token verification guard for Elysia route handlers.
 *
 * Validates the `Authorization: ARC <token>` header against the
 * `service_accounts` table:
 * 1. Extracts the raw token
 * 2. Peeks the `iss` claim to resolve the public key
 * 3. Verifies signature, audience, expiry, and required scope
 *
 * On success, returns the verified {@link ArcCaller} claims.
 * On failure, sets `set.status = 401` and returns `null`.
 *
 * @param authorization - The raw Authorization header value
 * @param set - Elysia's response status setter
 * @param run - Effect runner bound to the request's Db layer
 * @param expectedAudience - The service ID this token must be addressed to (e.g. "osn-api")
 * @param requiredScope - The scope the token must include (e.g. "graph:read")
 */
/**
 * Classifies a `resolvePublicKey` failure into a bounded `ArcVerifyResult`
 * for the shared `arc.token.verification` counter (S-L1, mirrors the pulse
 * receiver's S-L6 instrumentation). `issuerConfirmed` says whether the DB
 * lookup matched the claimed (kid, iss) pair — only then is the peeked `iss`
 * safe to use as a metric label (S-C2: before that it is attacker-controlled
 * and must collapse to "unknown"; `safeIssuer` inside the recording helper is
 * the second line of defence). Returns `null` for infra failures (DB query
 * error) — those are not token verdicts and shouldn't skew the counter.
 *
 * The error arrives wrapped by the Effect runtime (FiberFailure), so we match
 * on the stringified form rather than `.message`.
 */
function classifyResolveFailure(
  err: unknown,
): { result: ArcVerifyResult; issuerConfirmed: boolean } | null {
  const text = `${String(err)} ${err instanceof Error ? err.message : ""}`.toLowerCase();
  if (text.includes("not authorised for scope")) {
    // Scope check runs only after the (kid, iss) row matched.
    return { result: "scope_denied", issuerConfirmed: true };
  }
  if (text.includes("unknown or invalid key")) {
    // Covers unknown kid AND revoked/expired rows (the WHERE clause folds
    // them — indistinguishable without a schema change).
    return { result: "unknown_issuer", issuerConfirmed: false };
  }
  if (text.includes("invalid public key")) {
    return { result: "unknown_issuer", issuerConfirmed: true };
  }
  if (text.includes("failed to query")) return null; // infra, not a verdict
  return { result: "unknown_issuer", issuerConfirmed: false };
}

export async function requireArc(
  authorization: string | undefined,
  set: { status?: number | string },
  run: <A>(eff: Effect.Effect<A, unknown, Db>) => Promise<A>,
  expectedAudience: string,
  requiredScope: string,
): Promise<ArcCaller | null> {
  // S-L1: the early-exit branches below reject before `verifyArcToken` runs
  // (which self-reports its own outcomes), so they record the shared
  // `arc.token.verification` counter themselves — otherwise malformed /
  // unknown-kid / registry-scope-denied failures are invisible on the ARC
  // dashboard. Same rule the pulse receiver follows (see [[arc-tokens]]).
  const raw = extractArcToken(authorization);
  if (!raw) {
    metricArcTokenVerification("unknown", "malformed");
    set.status = 401;
    return null;
  }

  const peeked = peekClaims(raw);
  if (!peeked) {
    metricArcTokenVerification("unknown", "malformed");
    set.status = 401;
    return null;
  }

  try {
    // S-M3: The peeked claims are unverified at this point. We pass them
    // to resolvePublicKey to (a) look up the issuer's key and (b) check
    // scope authorization against the DB. If an attacker tampers with the
    // base64 payload, verifyArcToken below will reject the signature —
    // so the DB scope check here is a fail-fast optimisation, not the
    // sole gate. The cryptographic verification below is authoritative.
    let publicKey: CryptoKey;
    try {
      publicKey = await run(resolvePublicKey(peeked.kid, peeked.iss, peeked.scopes));
    } catch (err) {
      const classified = classifyResolveFailure(err);
      if (classified) {
        metricArcTokenVerification(
          classified.issuerConfirmed ? peeked.iss : "unknown",
          classified.result,
        );
      }
      throw err; // outer catch turns it into the uniform 401
    }

    // Verify signature, audience, expiry, required scope, and issuer (X1).
    // We pass `peeked.iss` as the expected issuer: the key was resolved by the
    // (kid, iss) pair, so requiring the signed `iss` to equal it makes jose
    // cryptographically enforce the kid→issuer binding rather than relying on
    // the DB lookup alone. A token whose signed `iss` differs from the issuer
    // its kid is registered under is now rejected at verification time.
    const payload: ArcTokenPayload = await verifyArcToken(
      raw,
      publicKey,
      expectedAudience,
      requiredScope,
      peeked.iss,
    );

    return {
      iss: payload.iss,
      aud: payload.aud,
      scope: payload.scope,
    };
  } catch {
    set.status = 401;
    return null;
  }
}
