import { describe, expect, it } from "vitest";

import { createApp } from "../src/app";
import { buildAppDeps } from "../src/build-deps";
import { createInMemoryCoordination } from "../src/lib/coordination/memory";
import { osnLoggerLayer } from "../src/observability";
import { createTestLayerWithSqlite } from "./helpers/db";

/**
 * A sign-up tab polls one URL every few seconds, so the browser must cache the
 * preflight: the answer carries `Access-Control-Max-Age: 600`.
 */

const ALLOWED_ORIGIN = "http://localhost:1422";

async function build() {
  const { layer } = createTestLayerWithSqlite();
  const built = await buildAppDeps(
    { OSN_ENV: "local" },
    {
      coordination: () => createInMemoryCoordination(),
      dbAndEmailLayer: layer,
      observabilityLayer: osnLoggerLayer,
      includeObservabilityPlugin: false,
    },
  );
  return createApp(built.deps);
}

describe("CORS preflight", () => {
  it("answers an allowed origin with a ten-minute cache lifetime", async () => {
    const app = await build();
    const res = await app.handle(
      new Request("http://localhost/register/status", {
        method: "OPTIONS",
        headers: {
          origin: ALLOWED_ORIGIN,
          "access-control-request-method": "POST",
          "access-control-request-headers": "content-type",
        },
      }),
    );
    expect(res.headers.get("access-control-allow-origin")).toBe(ALLOWED_ORIGIN);
    expect(res.headers.get("access-control-allow-credentials")).toBe("true");
    expect(res.headers.get("access-control-max-age")).toBe("600");
  });
});
