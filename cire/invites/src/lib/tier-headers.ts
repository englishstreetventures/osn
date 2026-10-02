/**
 * Points the CSP in `dist/client/_headers` (the Worker's static assets) at the
 * cire-api this build calls, through the integration all three cire Astro apps
 * share (`@cire/build-tools/tier-headers`, which holds the rewrite and its
 * checks). This file holds only the guest site's part: the env chain
 * `lib/invite.ts` reads (`PUBLIC_API_URL`, else the local API, through
 * `api-origin.ts`), and the server bundle as the output that must name the
 * origin, since the pages read the API URL on the server and hand it to the
 * islands as a prop. The SSR middleware derives the same origin from the same
 * env (`security-headers.ts`).
 *
 * Build-only: `astro.config.mjs` is the one importer. Never import it from app
 * code — the integration reads the filesystem.
 */
import { tierHeaders as sharedTierHeaders } from "@cire/build-tools/tier-headers";
import type { AstroIntegration } from "astro";

import { resolveApiUrl } from "./api-origin";

export default function tierHeaders(): AstroIntegration {
  return sharedTierHeaders({
    apiUrl: (env) => resolveApiUrl(env.PUBLIC_API_URL),
    bundle: "server",
  });
}
