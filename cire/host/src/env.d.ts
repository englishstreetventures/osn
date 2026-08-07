/// <reference types="astro/client" />

interface ImportMetaEnv {
  /**
   * The musubi account app origin (dev default http://localhost:1422; prod
   * https://musubi.social). Only used to link out to account settings —
   * sign-in itself goes through cire/api's OIDC redirect.
   */
  readonly PUBLIC_OSN_ACCOUNT_URL?: string;
  /** cire/api origin (dev default http://localhost:8787). */
  readonly PUBLIC_CIRE_API_URL?: string;
  /** Legacy name for the cire/api origin; still honoured as a fallback. */
  readonly PUBLIC_API_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
