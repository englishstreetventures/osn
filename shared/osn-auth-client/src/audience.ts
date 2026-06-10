import { decodeJwt } from "jose";

/**
 * Checks the (already signature-verified) token's `aud` claim against the
 * expected audience. Kept separate from extractClaims so the core verifier
 * stays reusable for audience-agnostic callers; both middleware adapters
 * call this so the check can never drift between frameworks.
 */
export function tokenMatchesAudience(token: string, audience: string): boolean {
  try {
    const payload = decodeJwt(token);
    const aud = payload.aud;
    return typeof aud === "string"
      ? aud === audience
      : Array.isArray(aud) && aud.includes(audience);
  } catch {
    return false;
  }
}
