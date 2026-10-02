/**
 * Points the CSP in `dist/_headers` at the cire-api this build calls, through
 * the integration all three cire Astro apps share
 * (`@cire/build-tools/tier-headers`, which holds the rewrite and its checks).
 * This file holds only the portal's part: the env chain `lib/osn.ts` reads
 * (`PUBLIC_CIRE_API_URL`, else `PUBLIC_API_URL`, else the local API, through
 * `api-origin.ts`), and the client bundle as the output that must name the
 * origin, since the portal's client scripts call the API.
 *
 * Build-only: `astro.config.mjs` is the one importer. Never import it from app
 * code — the integration reads the filesystem.
 */
import { tierHeaders as sharedTierHeaders } from "@cire/build-tools/tier-headers";
import type { AstroIntegration } from "astro";

import { resolveApiUrl } from "./api-origin";

export default function tierHeaders(): AstroIntegration {
  return sharedTierHeaders({
    apiUrl: (env) => resolveApiUrl(env.PUBLIC_CIRE_API_URL, env.PUBLIC_API_URL),
    bundle: "client",
  });
}
