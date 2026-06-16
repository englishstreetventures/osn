/**
 * CORS allowlist derivation for pulse-api.
 *
 * Centralised (mirrors `osn/api/src/lib/cors-config.ts`) so the dev fallback
 * and the non-local fail-closed invariant can be unit-tested without booting
 * the whole app.
 *
 * Pulse is a bearer-token API — every mutating route verifies an access JWT,
 * so there is no cookie-CSRF surface and no Origin guard. CORS still matters:
 * a permissive `Access-Control-Allow-Origin: *` lets any site read responses
 * from a victim's browser session, so we pin the allowlist to the known app
 * origin(s) instead of the open wildcard the bare `cors()` plugin emits.
 */

/**
 * Frontend dev port for the Pulse Tauri app (`@pulse/app`). Used as the CORS
 * fallback when `PULSE_CORS_ORIGIN` is unset in a non-secure (local) env so
 * `bun run dev:pulse` works out of the box.
 */
export const LOCAL_DEV_CORS_ORIGINS = [
  "http://localhost:1420", // @pulse/app
] as const;

export type CorsEnv = Readonly<Record<string, string | undefined>>;

/**
 * Strip a trailing slash + lowercase so an operator typo (`HTTPS://Foo.com/`)
 * still matches the browser-supplied Origin header (`https://foo.com`).
 * Origins have no path component, so lowercasing the whole string is safe.
 */
function normaliseOrigin(raw: string): string {
  const trimmed = raw.trim();
  const withoutSlash = trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
  return withoutSlash.toLowerCase();
}

/**
 * `secure` is the single non-local predicate — in a secure env the dev
 * fallback is never used, so a deploy that forgets both the secure flag and
 * `PULSE_CORS_ORIGIN` still fails closed at `assertCorsOriginsConfigured`.
 */
export function resolveCorsOrigins(env: CorsEnv, secure: boolean): string[] {
  const raw = env.PULSE_CORS_ORIGIN;
  if (raw) {
    return raw
      .split(",")
      .map(normaliseOrigin)
      .filter((o) => o.length > 0);
  }
  return secure ? [] : [...LOCAL_DEV_CORS_ORIGINS];
}

/**
 * Refuse to boot a non-local deploy with an empty CORS allowlist — a bare
 * `cors()` (wildcard) is exactly the posture we are removing, so an empty
 * list in a secure env is a misconfiguration, not "allow nothing".
 */
export function assertCorsOriginsConfigured(origins: readonly string[], secure: boolean): void {
  if (secure && origins.length === 0) {
    throw new Error(
      "PULSE_CORS_ORIGIN must be set in non-local environments — an explicit CORS allowlist is mandatory",
    );
  }
}
