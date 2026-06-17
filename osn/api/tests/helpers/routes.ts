import {
  createAuthRoutes as createAuthRoutesRaw,
  type AuthRateLimiters,
} from "../../src/routes/auth";
import { createProfileRoutes as createProfileRoutesRaw } from "../../src/routes/profile";

/**
 * Test wrappers around the auth / profile route factories for the S-M34
 * client-IP hardening.
 *
 * Two things differ from production wiring under `app.handle(...)`:
 *  1. There is no Bun server, so `server.requestIP` is unavailable. In the
 *     production default (direct mode) the keying IP would therefore resolve
 *     to the `UNRESOLVED_IP` sentinel and every rate-limited request would be
 *     denied with 429 before the handler runs.
 *  2. The route tests assert per-IP rate-limit buckets via an
 *     `x-forwarded-for` header.
 *
 * So these wrappers run the routes with `{ trustedProxyCount: 1 }` (honour
 * XFF, taking the right-most entry) unless the test supplies its own
 * `clientIpConfig`, and patch `.handle` to inject a stable default
 * `x-forwarded-for` on requests that don't set one — restoring the
 * pre-hardening behaviour where a header-less request still resolved to a
 * deterministic key. Tests that want to exercise the unresolved→deny path or a
 * specific bucket set the header (or proxy count) explicitly.
 */

const DEFAULT_TEST_XFF = "127.0.0.1";

function withDefaultXff<App extends { handle: (request: Request) => unknown }>(app: App): App {
  const originalHandle = app.handle.bind(app);
  app.handle = ((request: Request) => {
    if (!request.headers.has("x-forwarded-for")) {
      const patched = new Request(request, { headers: new Headers(request.headers) });
      patched.headers.set("x-forwarded-for", DEFAULT_TEST_XFF);
      return originalHandle(patched);
    }
    return originalHandle(request);
  }) as App["handle"];
  return app;
}

/** `createAuthRoutes` with XFF-trusting client-IP config + default-XFF patch. */
export function createAuthRoutes(...args: Parameters<typeof createAuthRoutesRaw>) {
  const [authConfig, dbLayer, loggerLayer, rateLimiters, cookieConfig, clientIpConfig, runtime] =
    args;
  return withDefaultXff(
    createAuthRoutesRaw(
      authConfig,
      dbLayer,
      loggerLayer,
      rateLimiters,
      cookieConfig,
      clientIpConfig ?? { trustedProxyCount: 1 },
      runtime,
    ),
  );
}

/** `createProfileRoutes` with XFF-trusting client-IP config + default-XFF patch. */
export function createProfileRoutes(...args: Parameters<typeof createProfileRoutesRaw>) {
  const [authConfig, dbLayer, loggerLayer, rateLimiters, clientIpConfig, runtime] = args;
  return withDefaultXff(
    createProfileRoutesRaw(
      authConfig,
      dbLayer,
      loggerLayer,
      rateLimiters,
      clientIpConfig ?? { trustedProxyCount: 1 },
      runtime,
    ),
  );
}

export type { AuthRateLimiters };
