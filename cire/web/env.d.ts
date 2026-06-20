/// <reference types="astro/client" />

interface ImportMetaEnv {
  readonly PUBLIC_API_URL: string;
  readonly PUBLIC_SITE_URL?: string;
  /**
   * OSN identity API origin for the optional "Link my Pulse account" flow
   * (dev default http://localhost:4000; prod id.cireweddings.com). The guest
   * obtains an OSN access token here via `@osn/client`'s silent-refresh, then
   * cire-api's POST /api/account/link verifies it.
   */
  readonly PUBLIC_OSN_ISSUER_URL?: string;
  /**
   * Cloudflare Turnstile sitekey (public — safe to embed in client HTML). When
   * set, the guest claim + RSVP forms render the Turnstile challenge and gate
   * submit on it; the cire-api Worker enforces siteverify. Unset/blank ⇒ no
   * widget, no gate (key-optional). Baked in at build time by Vite.
   */
  readonly PUBLIC_TURNSTILE_SITEKEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
