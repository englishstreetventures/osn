import { createOsnAuthRuntime } from "@osn/client";

export const OSN_ISSUER_URL = import.meta.env.VITE_OSN_ISSUER_URL ?? "http://localhost:4000";

/**
 * The page's one auth runtime. Every `AuthProvider` on the page takes it, and
 * every authenticated client is built with its `authFetch`, so the session
 * cache and the single-flight `/token` grant are shared by all of them. It
 * builds nothing until its first call: importing it costs no request.
 */
export const osnAuth = createOsnAuthRuntime({ issuerUrl: OSN_ISSUER_URL });

/** The product name this app shows — in its own copy and in `@osn/auth-ui`'s. */
export const PRODUCT_NAME = "Musubi";

/**
 * Cloudflare Turnstile sitekey — the CLIENT half of the bot-protection gate on
 * `/register/begin` and the identifier-bound `/login/passkey/begin` (see
 * `wiki/shared/turnstile.md`).
 *
 * Public and baked in at build time. Key-optional in both directions: blank ⇒
 * no widget renders and no token is sent, which is correct only while osn-api's
 * `TURNSTILE_SECRET_KEY` is also unset. With the secret set on the Worker this
 * MUST be populated — osn-api fails closed (`400 turnstile_failed`) on a gated
 * request that carries no token.
 *
 * Normalised to `undefined` when blank so `turnstileEnabled()` in `@osn/auth-ui` sees
 * a single shape: an unset GitHub Actions variable expands to the empty string,
 * not to nothing.
 */
const rawTurnstileSitekey = import.meta.env.VITE_TURNSTILE_SITEKEY;
export const TURNSTILE_SITEKEY =
  rawTurnstileSitekey && rawTurnstileSitekey.trim() !== "" ? rawTurnstileSitekey : undefined;
