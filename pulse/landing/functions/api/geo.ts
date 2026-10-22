// Cloudflare Pages Function — GET /api/geo. Bundled automatically by
// `wrangler pages deploy` from this `functions/` directory; the handler lives
// in `src/lib/geo.ts`, which the site's Worker entry serves as well.

import { geoResponse } from "../../src/lib/geo";

export const onRequestGet = (context: {
  request: Request & { cf?: Parameters<typeof geoResponse>[0] };
}): Response => geoResponse(context.request.cf);
