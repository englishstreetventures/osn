/// <reference types="astro/client" />

interface ImportMetaEnv {
  /**
   * Where the primary "Find events" / "Get the app" CTA points — the Pulse app.
   * Dev default (the local Pulse app dev server, :3001) lives in `lib/site.ts`;
   * prod is the deployed Pulse app origin, set in deploy CI. Baked in at build
   * time by Vite.
   */
  readonly PUBLIC_APP_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
