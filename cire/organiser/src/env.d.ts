/// <reference types="astro/client" />

interface ImportMetaEnv {
  /** OSN identity API origin (dev default http://localhost:4000). */
  readonly PUBLIC_OSN_ISSUER_URL?: string;
  /** cire/api origin (dev default http://localhost:8787). */
  readonly PUBLIC_CIRE_API_URL?: string;
  /** Legacy name for the cire/api origin; still honoured as a fallback. */
  readonly PUBLIC_API_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
