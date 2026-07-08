import {
  importKeyFromJwk,
  metricArcTokenVerification,
  verifyArcToken,
  type ArcTokenPayload,
} from "@shared/crypto";

/**
 * Lightweight in-memory ARC verifier for zap-api.
 *
 * Zap only needs to accept ARC tokens from a small known set of issuers
 * (osn-api today) so a full `service_accounts` schema would be overkill.
 * Public keys are registered at runtime by the issuing service via
 * `POST /internal/register-service` (same shared-secret bootstrap as
 * `osn/api/src/routes/graph-internal.ts` and `pulse/api`).
 *
 * Single source of truth: every ARC route on zap-api calls `requireArc`,
 * which consults the in-memory registry below.
 */

interface RegisteredKey {
  readonly issuer: string;
  readonly publicKey: CryptoKey;
  readonly allowedScopes: ReadonlySet<string>;
  readonly expiresAt: number | null; // unix seconds
  revokedAt: number | null;
}

const keyRegistry = new Map<string, RegisteredKey>(); // kid -> key

export interface RegisterServiceKeyInput {
  readonly serviceId: string;
  readonly keyId: string;
  readonly publicKeyJwk: string;
  readonly allowedScopes: string;
  readonly expiresAt?: number;
}

export class ServiceKeyMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ServiceKeyMismatchError";
  }
}

export async function registerServiceKey(input: RegisterServiceKeyInput): Promise<void> {
  // S-L1: refuse to overwrite a kid registered to a different serviceId.
  // The single INTERNAL_SERVICE_SECRET is the trust root across services;
  // without this guard, a holder could pivot across services by reusing
  // another's kid.
  const existing = keyRegistry.get(input.keyId);
  if (existing && existing.issuer !== input.serviceId) {
    throw new ServiceKeyMismatchError(
      `kid ${input.keyId} is already bound to service ${existing.issuer}`,
    );
  }
  const publicKey = await importKeyFromJwk(input.publicKeyJwk);
  const scopes = new Set(
    input.allowedScopes
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
  keyRegistry.set(input.keyId, {
    issuer: input.serviceId,
    publicKey,
    allowedScopes: scopes,
    expiresAt: input.expiresAt ?? null,
    revokedAt: null,
  });
}

export function revokeServiceKey(keyId: string): void {
  const existing = keyRegistry.get(keyId);
  if (existing) existing.revokedAt = Math.floor(Date.now() / 1_000);
}

export function _resetServiceKeysForTests(): void {
  keyRegistry.clear();
}

export interface ArcCaller {
  readonly iss: string;
  readonly aud: string;
  readonly scope: string;
}

function extractToken(authorization: string | undefined): string | null {
  if (!authorization) return null;
  const m = authorization.match(/^ARC\s+(.+)$/i);
  return m ? m[1] : null;
}

function decodeSegment(segment: string): unknown {
  const padded =
    segment.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (segment.length % 4)) % 4);
  return JSON.parse(atob(padded));
}

function peekKid(token: string): string | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const header = decodeSegment(parts[0]) as { kid?: string };
    return typeof header.kid === "string" ? header.kid : null;
  } catch {
    return null;
  }
}

/**
 * ARC token verification guard for Zap Elysia routes. Mirrors the API
 * shape of osn-api's `requireArc` so route bodies look the same:
 *
 *   const caller = await requireArc(headers.authorization, set, AUDIENCE, SCOPE);
 *   if (!caller) return { error: "Unauthorized" };
 */
export async function requireArc(
  authorization: string | undefined,
  set: { status?: number | string },
  expectedAudience: string,
  requiredScope: string,
): Promise<ArcCaller | null> {
  // S-L6: the early-exit branches below reject before `verifyArcToken` runs
  // (which self-reports its own outcomes, incl. "ok"), so each one records
  // the shared `arc.token.verification` counter itself — otherwise
  // kid-unknown / kid-revoked / registry-scope-denied failures are invisible
  // on dashboards and every 401 looks the same. The issuer attribute is only
  // trustworthy once the kid resolves to a registered key; before that we
  // label "unknown" (the recording helper also bounds cardinality).
  const raw = extractToken(authorization);
  if (!raw) {
    metricArcTokenVerification("unknown", "malformed");
    set.status = 401;
    return null;
  }
  const kid = peekKid(raw);
  if (!kid) {
    metricArcTokenVerification("unknown", "malformed");
    set.status = 401;
    return null;
  }
  const registered = keyRegistry.get(kid);
  if (!registered) {
    metricArcTokenVerification("unknown", "unknown_issuer");
    set.status = 401;
    return null;
  }
  if (registered.revokedAt !== null) {
    metricArcTokenVerification(registered.issuer, "revoked_key");
    set.status = 401;
    return null;
  }
  const nowSec = Math.floor(Date.now() / 1_000);
  if (registered.expiresAt !== null && registered.expiresAt <= nowSec) {
    metricArcTokenVerification(registered.issuer, "revoked_key");
    set.status = 401;
    return null;
  }
  if (!registered.allowedScopes.has(requiredScope.toLowerCase())) {
    metricArcTokenVerification(registered.issuer, "scope_denied");
    set.status = 401;
    return null;
  }
  try {
    // X1: pass the registered issuer as expectedIssuer so jose cryptographically
    // binds the signed `iss` to the kid's registered service. The explicit
    // post-verify equality check below is kept as defence-in-depth (and can be
    // dropped one release after this adoption settles).
    const payload: ArcTokenPayload = await verifyArcToken(
      raw,
      registered.publicKey,
      expectedAudience,
      requiredScope,
      registered.issuer,
    );
    if (payload.iss !== registered.issuer) {
      set.status = 401;
      return null;
    }
    return { iss: payload.iss, aud: payload.aud, scope: payload.scope };
  } catch {
    set.status = 401;
    return null;
  }
}

/**
 * Allowlist of scopes zap-api will accept on registration. Permitted scopes
 * are those Zap will verify on inbound ARC tokens — keep tight.
 *
 * `account:export` powers the DSAR account-export fan-out (C-H1);
 * `account:erase` is reserved for the future account-deletion fan-out.
 */
export const PERMITTED_INBOUND_SCOPES = new Set(["account:export", "account:erase"]);
