/**
 * Shared-secret bearer token guard for `/account-export/internal` and any
 * future osn/api → pulse/api S2S endpoints.
 *
 * Background: pulse/api → osn/api S2S already uses ARC tokens (Pulse owns
 * its own keys, osn/api stores the public key in `service_accounts`).
 * The reverse direction (osn/api → pulse/api) does not yet have a
 * symmetric ARC infrastructure — Pulse would need its own service-account
 * registry, or a JWKS-style key fetch from osn/api, to verify ARC.
 *
 * For C-H1 (DSAR account export) and C-H2 (account deletion fan-out) we
 * use the existing `INTERNAL_SERVICE_SECRET` shared secret as a bearer
 * token. Same secret already gates the `register-service` endpoint on
 * osn/api — both directions of the trust pair use it. When bidirectional
 * ARC lands (future work), this guard becomes a thin wrapper around an
 * ARC verifier and call sites stay unchanged.
 *
 * Constant-time comparison guards against timing-based secret discovery.
 * The endpoint returns 501 (not 401) when the secret is unset, so a
 * misconfiguration is loud rather than silently rejecting all callers.
 */

/**
 * Constant-time string equality check for shared-secret comparison.
 * Length inequality is checked first; a mismatch returns false immediately
 * since length is not secret in a `Bearer <secret>` scheme.
 */
function isTimingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export type InternalAuthResult = { ok: true } | { ok: false; status: 401 | 501; error: string };

/**
 * Verifies a `Authorization: Bearer <INTERNAL_SERVICE_SECRET>` header.
 *
 * Returns `{ ok: true }` on success; on failure returns `{ ok: false }`
 * with the status the route should send. The route never sees the secret
 * itself — only this helper compares it.
 */
export function verifyInternalBearer(authorization: string | undefined): InternalAuthResult {
  const secret = process.env.INTERNAL_SERVICE_SECRET;
  if (!secret) {
    return {
      ok: false,
      status: 501,
      error: "Internal endpoint disabled: INTERNAL_SERVICE_SECRET not set",
    };
  }
  if (!authorization || !isTimingSafeEqual(authorization, `Bearer ${secret}`)) {
    return { ok: false, status: 401, error: "Unauthorized" };
  }
  return { ok: true };
}
