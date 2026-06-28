/// <reference types="astro/client" />

interface ImportMetaEnv {
  /**
   * Where the primary "Create your invitation" CTA points — the organiser
   * portal. Dev default (the local organiser dev server) lives in `lib/site.ts`;
   * prod is `https://host.cireweddings.com` once the organiser portal moves off
   * `app.cireweddings.com` (see the migration plan in [[wiki/apps/cire-landing]]).
   * Baked in at build time by Vite.
   */
  readonly PUBLIC_ORGANISER_URL?: string;
  /**
   * Where the "See a live invite" CTA points — a real seeded demo invitation, or
   * left unset to fall back to the in-page interactive demo (no external link).
   */
  readonly PUBLIC_DEMO_INVITE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
