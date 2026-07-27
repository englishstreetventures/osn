/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Origin of osn-api. Prod: `https://id.musubi.social`. */
  readonly VITE_OSN_ISSUER_URL?: string;
  /**
   * Public Cloudflare Turnstile sitekey. Must be set whenever osn-api holds a
   * `TURNSTILE_SECRET_KEY`, or the gated register/login calls fail closed.
   */
  readonly VITE_TURNSTILE_SITEKEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
