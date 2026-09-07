/**
 * CORS allowlist derivation for zap-api (S-M2 zap).
 *
 * Centralised + side-effect-free so the fallback list and the non-local
 * fail-closed invariant can be unit-tested without booting the app. Mirrors
 * `osn/api/src/lib/cors-config.ts` — same env-driven model, same fail-closed
 * rule — so all services agree on what a configured origin allowlist means.
 */

import { isNonLocalEnv, type DeploymentEnv } from "./deployment-env";

export { isNonLocalEnv };

/**
 * Frontend dev origins allowed to call zap-api out-of-the-box in local dev.
 * Pulse consumes Zap for event chats, so its dev port is included alongside
 * the OSN social app. Used only when `ZAP_CORS_ORIGIN` is unset in a
 * non-secure (local) env.
 */
export const LOCAL_DEV_CORS_ORIGINS = [
  "http://localhost:1420", // @pulse/web (event chats)
  "http://localhost:1422", // @osn/social
] as const;

export type CorsEnv = DeploymentEnv;

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
 * The literal an operator writes in `ZAP_CORS_ORIGIN` to say "this deployment
 * serves no browser origin at all".
 *
 * zap-api's production surface today is service-to-service (cire-api reaches it
 * with ARC tokens) plus token-bearing user routes that no shipped client calls
 * yet — so the correct production CORS policy is an empty allowlist, which
 * `@elysiajs/cors` honours by sending no `Access-Control-Allow-Origin` for any
 * Origin. But an empty allowlist is also what a deploy that simply *forgot* the
 * variable produces, and those two must not look alike: the fail-closed rule
 * below exists to catch the second. The sentinel is how the first states itself.
 */
export const NO_BROWSER_ORIGINS = "none";

/** The resolved allowlist, plus whether the operator actually stated it. */
export interface CorsPolicy {
  readonly origins: string[];
  /**
   * True when `ZAP_CORS_ORIGIN` was set — to a list, or to
   * {@link NO_BROWSER_ORIGINS}. False means the value is a fallback, which is
   * only ever legitimate in a local env.
   */
  readonly declared: boolean;
}

/**
 * In a non-local env the local fallback is never used, so a deploy that forgets
 * `ZAP_CORS_ORIGIN` produces an undeclared, empty policy and fails closed at
 * {@link assertCorsPolicyConfigured}.
 *
 * Pass the WHOLE env, not a picked-out `ZAP_CORS_ORIGIN`: the fallback branch
 * reads the tier, and an env object narrowed to one key reads as local no
 * matter where it is running — which silently handed a production Worker the
 * localhost dev origins and left the assert with nothing to complain about.
 */
export function resolveCorsPolicy(env: CorsEnv): CorsPolicy {
  const raw = env.ZAP_CORS_ORIGIN;
  if (raw) {
    if (normaliseOrigin(raw) === NO_BROWSER_ORIGINS) return { origins: [], declared: true };
    const origins = raw
      .split(",")
      .map(normaliseOrigin)
      .filter((o) => o.length > 0);
    return { origins, declared: true };
  }
  return isNonLocalEnv(env)
    ? { origins: [], declared: false }
    : { origins: [...LOCAL_DEV_CORS_ORIGINS], declared: false };
}

/**
 * Refuse to boot a non-local deploy that never stated a CORS policy — a bare
 * `cors()` (the previous behaviour) reflects any Origin and defeats CSRF
 * protection on the cookie-less but token-bearing API surface.
 *
 * The test is `declared`, not emptiness: `ZAP_CORS_ORIGIN=none` is an empty
 * allowlist on purpose and boots, an unset variable is an empty allowlist by
 * accident and does not.
 */
export function assertCorsPolicyConfigured(policy: CorsPolicy, nonLocal: boolean): void {
  if (nonLocal && !policy.declared) {
    throw new Error(
      `ZAP_CORS_ORIGIN must be set in non-local environments — an open CORS policy is not permitted. ` +
        `Set it to a comma-separated origin list, or to "${NO_BROWSER_ORIGINS}" if this deployment serves no browser.`,
    );
  }
}
