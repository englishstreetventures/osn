/// <reference types="astro/client" />

interface ImportMetaEnv {
  readonly PUBLIC_API_URL: string;
  readonly PUBLIC_SITE_URL?: string;
  /**
   * Marketing-site origin the bare domain (`/`) redirects to, since a
   * multi-tenant guest site has no one wedding to show at its root. Unset ⇒ the
   * production apex (`https://cireweddings.com`).
   */
  readonly PUBLIC_MARKETING_URL?: string;
  /**
   * Cloudflare Turnstile sitekey (public — safe to embed in client HTML). When
   * set, the guest claim + RSVP forms render the Turnstile challenge and gate
   * submit on it; the cire-api Worker enforces siteverify. Unset/blank ⇒ no
   * widget, no gate (key-optional). Baked in at build time by Vite.
   */
  readonly PUBLIC_TURNSTILE_SITEKEY?: string;
  /**
   * The commit this build was made from (`github.sha`), set by the deploy
   * workflows. The footer prints its first seven characters as the build's
   * version; unset ⇒ "local". Baked in at build time, and in turbo's
   * `PUBLIC_*` env hash, so a new commit never replays an older build.
   */
  readonly PUBLIC_BUILD_SHA?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
