/**
 * Which cire-api the portal talks to, given the two env names that can set it.
 *
 * One function, called twice: by `lib/osn.ts` with `import.meta.env` for the
 * bundle, and by `lib/tier-headers.ts` with Vite's resolved env for the CSP in
 * `dist/_headers`. Both reading the same chain is what keeps the policy naming
 * the API the bundle calls. So this module reads no env itself and imports
 * nothing — the build loads it outside Vite's `import.meta.env` handling.
 */

/** The local cire-api: `bun run dev` in `cire/api` (src/local.ts, port 8787). */
export const LOCAL_API_URL = "http://localhost:8787";

/**
 * `PUBLIC_CIRE_API_URL`, else the legacy `PUBLIC_API_URL`, else the local API.
 * `??` on purpose: an empty value stays empty, and the header rewrite then fails
 * the build instead of quietly picking the next name.
 */
export function resolveApiUrl(canonical: string | undefined, legacy: string | undefined): string {
  return canonical ?? legacy ?? LOCAL_API_URL;
}
