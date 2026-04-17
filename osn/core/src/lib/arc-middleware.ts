import { verifyArcToken, resolvePublicKey, type ArcTokenPayload } from "@osn/crypto";
import type { Db } from "@osn/db/service";
import { Effect, type Layer } from "effect";

/**
 * Verified ARC caller claims attached to the request context after
 * successful middleware validation.
 */
export interface ArcCaller {
  /** Issuer service ID (e.g. "pulse-api") */
  readonly iss: string;
  /** Audience (this service, e.g. "osn-core") */
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
 * @param dbLayer - The Effect Layer providing the Db service
 * @param expectedAudience - The service ID this token must be addressed to (e.g. "osn-core")
 * @param requiredScope - The scope the token must include (e.g. "graph:read")
 */
export async function requireArc(
  authorization: string | undefined,
  set: { status?: number | string },
  dbLayer: Layer.Layer<Db>,
  expectedAudience: string,
  requiredScope: string,
): Promise<ArcCaller | null> {
  const raw = extractArcToken(authorization);
  if (!raw) {
    set.status = 401;
    return null;
  }

  const peeked = peekClaims(raw);
  if (!peeked) {
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
    const publicKey = await Effect.runPromise(
      resolvePublicKey(peeked.kid, peeked.iss, peeked.scopes).pipe(Effect.provide(dbLayer)),
    );

    // Verify signature, audience, expiry, and required scope (authoritative).
    const payload: ArcTokenPayload = await verifyArcToken(
      raw,
      publicKey,
      expectedAudience,
      requiredScope,
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
