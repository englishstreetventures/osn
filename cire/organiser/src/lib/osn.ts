// Issuer origin for the OSN identity API. Dev default matches `bun run
// dev:cire` which starts @osn/api on :4000.
export const OSN_ISSUER_URL = import.meta.env.PUBLIC_OSN_ISSUER_URL ?? "http://localhost:4000";

// cire/api origin. Dev default matches @cire/api's `bun run dev`
// (src/local.ts, port 8787). PUBLIC_API_URL is the legacy name, still
// honoured as a fallback.
export const CIRE_API_URL =
  import.meta.env.PUBLIC_CIRE_API_URL ?? import.meta.env.PUBLIC_API_URL ?? "http://localhost:8787";

// cire/web (guest invite) origin. Used by the "Preview invite" button to open
// the guest site with the host preview code pre-filled. Dev default matches
// `bun run --cwd cire/web dev` (port 4321).
export const CIRE_WEB_URL = import.meta.env.PUBLIC_CIRE_WEB_URL ?? "http://localhost:4321";
