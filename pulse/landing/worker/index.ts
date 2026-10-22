// The Worker that serves pulse landing: `GET /api/geo` from the module below,
// every other path from the site's static assets. The stack routes only
// `/api/*` to this module (`runWorkerFirst`); the assets answer the rest
// before it runs.

import { geoResponse } from "../src/lib/geo";

interface Env {
  readonly ASSETS: { fetch(request: Request): Promise<Response> };
}

export default {
  fetch(request: Request, env: Env): Response | Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname !== "/api/geo") return env.ASSETS.fetch(request);
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response(null, { status: 405, headers: { allow: "GET, HEAD" } });
    }
    return geoResponse((request as Request & { cf?: Parameters<typeof geoResponse>[0] }).cf);
  },
};
