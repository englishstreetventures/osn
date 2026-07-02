/// <reference types="astro/client" />

interface ImportMetaEnv {
  /**
   * Where the primary "Get started" CTA points — the OSN identity / social app
   * (`@osn/social`). Dev default (the local social dev server on port 1422)
   * lives in `lib/site.ts`; prod is set per-deploy. Baked in at build time by
   * Vite.
   */
  readonly PUBLIC_APP_URL?: string;
  /**
   * Optional: where the "Read the docs" / "Learn more" links point — the
   * project README or a docs site. Unset ⇒ the default placeholder in
   * `src/lib/site.ts` (or the link is omitted).
   */
  readonly PUBLIC_DOCS_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
