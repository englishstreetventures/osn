/**
 * Shared-secret bearer token guard for `/account-export/internal` and any
 * future osn/api → zap/api S2S endpoints.
 *
 * See pulse/api/src/lib/internal-auth.ts for the full rationale —
 * Zap mirrors the same pattern. Same `INTERNAL_SERVICE_SECRET` env var
 * authorises all osn/api → downstream service calls; future bidirectional
 * ARC will replace this with cryptographic verification.
 */

function isTimingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export type InternalAuthResult = { ok: true } | { ok: false; status: 401 | 501; error: string };

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
