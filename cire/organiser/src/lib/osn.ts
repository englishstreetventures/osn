// The organiser's musubi account pages. Sign-in itself never goes through
// here — cire/api owns the OIDC redirect — but passkeys and recovery codes
// are bound to the `musubi.social` RP ID, so managing them has to happen on
// musubi's own origin. Dev default matches `bun run dev:osn` (@osn/social on
// :1422); production is the apex `https://musubi.social`.
export const OSN_ACCOUNT_URL = import.meta.env.PUBLIC_OSN_ACCOUNT_URL ?? "http://localhost:1422";

// cire/api origin. Dev default matches @cire/api's `bun run dev`
// (src/local.ts, port 8787). PUBLIC_API_URL is the legacy name, still
// honoured as a fallback.
export const CIRE_API_URL =
  import.meta.env.PUBLIC_CIRE_API_URL ?? import.meta.env.PUBLIC_API_URL ?? "http://localhost:8787";

// cire/web (guest invite) origin. Used by the "Preview invite" button to open
// the guest site with the host preview code pre-filled. Dev default matches
// `bun run --cwd cire/web dev` (port 4321).
export const CIRE_WEB_URL = import.meta.env.PUBLIC_CIRE_WEB_URL ?? "http://localhost:4321";
