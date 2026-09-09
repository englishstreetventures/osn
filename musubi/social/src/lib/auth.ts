export const OSN_ISSUER_URL = import.meta.env.VITE_OSN_ISSUER_URL ?? "http://localhost:4000";

/**
 * Cloudflare Turnstile sitekey — the CLIENT half of the bot-protection gate on
 * `/register/begin` and the identifier-bound `/login/passkey/begin` (see
 * `wiki/systems/turnstile.md`).
 *
 * Public and baked in at build time. Key-optional in both directions: blank ⇒
 * no widget renders and no token is sent, which is correct only while osn-api's
 * `TURNSTILE_SECRET_KEY` is also unset. With the secret set on the Worker this
 * MUST be populated — osn-api fails closed (`400 turnstile_failed`) on a gated
 * request that carries no token.
 *
 * Normalised to `undefined` when blank so `turnstileEnabled()` in `@osn/ui` sees
 * a single shape: an unset GitHub Actions variable expands to the empty string,
 * not to nothing.
 */
const rawTurnstileSitekey = import.meta.env.VITE_TURNSTILE_SITEKEY;
export const TURNSTILE_SITEKEY =
  rawTurnstileSitekey && rawTurnstileSitekey.trim() !== "" ? rawTurnstileSitekey : undefined;
