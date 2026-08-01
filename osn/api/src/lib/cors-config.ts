/**
 * CORS / Origin-guard allowlist derivation.
 *
 * Centralised so the fallback list and the non-local fail-closed invariant
 * (S-L4) can be unit-tested in isolation from module-scope bootstrap in
 * `src/index.ts`.
 */

/**
 * The Origin a Tauri v2 webview serializes on iOS. wry registers the app's
 * assets under the `tauri://` custom scheme, so the document's origin is a real
 * tuple — `tauri://localhost` — not the opaque `null` an opaque-origin document
 * would send. Measured on an iOS 26 simulator and read off the wire, not
 * inferred: see `spikes/n1-glass-webview`.
 *
 * Two things follow. First, we allowlist the string rather than `null`, which
 * would have handed the same access to every sandboxed iframe on the web.
 * Second, the string is Tauri's platform default, so it identifies "a Tauri
 * app", not "our Tauri app" — but an attacker who can already run native code
 * on the device can forge any Origin header they like, so nothing is lost. The
 * guard defends against browsers, which cannot forge it.
 */
export const IOS_WEBVIEW_ORIGIN = "tauri://localhost";

/**
 * Frontend dev ports used by the monorepo's Tauri apps. Used as the CORS
 * fallback when `OSN_CORS_ORIGIN` is unset in a non-secure (local) env, so
 * handle checks and passkey ceremonies work out-of-the-box. Kept separate
 * from the WebAuthn `OSN_ORIGIN` — that defaults to 5173 for the SDK's
 * example app and is a distinct concern.
 */
export const LOCAL_DEV_CORS_ORIGINS = [
  "http://localhost:1420", // @pulse/app
  "http://localhost:1422", // @osn/social
  "http://localhost:4321", // @cire/web (guest "Link my Pulse account" island)
  "http://localhost:4322", // @cire/organiser (OSN passkey sign-in)
  IOS_WEBVIEW_ORIGIN, // @pulse/app running on iOS
] as const;

export type CorsEnv = Readonly<Record<string, string | undefined>>;

/**
 * Strip trailing slash + lowercase scheme/host so an operator typo
 * (`HTTPS://Foo.com/`) still matches the browser-supplied Origin header
 * (`https://foo.com`). Origins have no path component, so lowercasing the
 * whole string is safe. S-L2.
 */
function normaliseOrigin(raw: string): string {
  const trimmed = raw.trim();
  const withoutSlash = trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
  return withoutSlash.toLowerCase();
}

/**
 * S-L1: `secure` is the single non-local predicate — in a secure env the
 * fallback is never used, so a deploy that forgets both `OSN_ENV` and
 * `OSN_CORS_ORIGIN` still fails closed at `assertCorsOriginsConfigured`.
 */
export function resolveCorsOrigins(env: CorsEnv, secure: boolean): string[] {
  const raw = env.OSN_CORS_ORIGIN;
  if (raw) {
    return raw
      .split(",")
      .map(normaliseOrigin)
      .filter((o) => o.length > 0);
  }
  return secure ? [] : [...LOCAL_DEV_CORS_ORIGINS];
}

/**
 * S-L4: refuse to boot a non-local deploy with an empty CORS allowlist —
 * the Origin guard would silently allow every request through if it did.
 */
export function assertCorsOriginsConfigured(origins: readonly string[], secure: boolean): void {
  if (secure && origins.length === 0) {
    throw new Error(
      "OSN_CORS_ORIGIN must be set in non-local environments — Origin guard is mandatory for CSRF protection",
    );
  }
}
