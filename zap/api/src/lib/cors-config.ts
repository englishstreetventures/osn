/**
 * CORS allowlist derivation for zap-api (S-M2 zap).
 *
 * Centralised + side-effect-free so the fallback list and the non-local
 * fail-closed invariant can be unit-tested without booting the app. Mirrors
 * `osn/api/src/lib/cors-config.ts` — same env-driven model, same fail-closed
 * rule — so all services agree on what a configured origin allowlist means.
 */

/**
 * Frontend dev origins allowed to call zap-api out-of-the-box in local dev.
 * Pulse consumes Zap for event chats, so its dev port is included alongside
 * the OSN social app. Used only when `ZAP_CORS_ORIGIN` is unset in a
 * non-secure (local) env.
 */
export const LOCAL_DEV_CORS_ORIGINS = [
  "http://localhost:1420", // @pulse/app (event chats)
  "http://localhost:1422", // @osn/social
] as const;

export type CorsEnv = Readonly<Record<string, string | undefined>>;

/**
 * True when the process is NOT running in a local developer environment
 * (`ZAP_ENV` / `OSN_ENV` set and != "local"). The single non-local predicate
 * that drives the fail-closed invariant below.
 */
export function isNonLocalEnv(env: CorsEnv): boolean {
  const zapEnv = env.ZAP_ENV ?? env.OSN_ENV;
  return !!zapEnv && zapEnv !== "local";
}

/**
 * Strip trailing slash + lowercase so an operator typo (`HTTPS://Foo.com/`)
 * still matches the browser-supplied Origin header. Origins have no path
 * component, so lowercasing the whole string is safe.
 */
function normaliseOrigin(raw: string): string {
  const trimmed = raw.trim();
  const withoutSlash = trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
  return withoutSlash.toLowerCase();
}

/**
 * In a non-local env the fallback is never used, so a deploy that forgets
 * both the env marker and `ZAP_CORS_ORIGIN` produces an empty list and fails
 * closed at `assertCorsOriginsConfigured`.
 */
export function resolveCorsOrigins(env: CorsEnv): string[] {
  const raw = env.ZAP_CORS_ORIGIN;
  if (raw) {
    return raw
      .split(",")
      .map(normaliseOrigin)
      .filter((o) => o.length > 0);
  }
  return isNonLocalEnv(env) ? [] : [...LOCAL_DEV_CORS_ORIGINS];
}

/**
 * Refuse to boot a non-local deploy with an empty CORS allowlist — a bare
 * `cors()` (the previous behaviour) reflects any Origin and defeats CSRF
 * protection on the cookie-less but token-bearing API surface.
 */
export function assertCorsOriginsConfigured(origins: readonly string[], nonLocal: boolean): void {
  if (nonLocal && origins.length === 0) {
    throw new Error(
      "ZAP_CORS_ORIGIN must be set in non-local environments — an open CORS policy is not permitted",
    );
  }
}
