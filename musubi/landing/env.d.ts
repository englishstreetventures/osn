/// <reference types="astro/client" />

interface ImportMetaEnv {
  /**
   * Where the primary "Get started" CTA points — the Musubi app
   * (`@musubi/social`). Dev default (the local social dev server on port 1422)
   * lives in `lib/site.ts`; prod is set per-deploy. Baked in at build time by
   * Vite.
   */
  readonly PUBLIC_APP_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
