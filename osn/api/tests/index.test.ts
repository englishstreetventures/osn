import { describe, it, expect, beforeAll } from "vitest";

import { createApp, type App } from "../src/app";
import { buildAppDeps } from "../src/build-deps";
import { createInMemoryCoordination } from "../src/lib/coordination/memory";
import { osnLoggerLayer } from "../src/observability";
import { createTestLayer } from "./helpers/db";

/**
 * Builds the app through createApp with the wiring src/index.ts's buildAll
 * uses — includeObservabilityPlugin: false and the redacting osnLoggerLayer —
 * and checks that it still mounts GET /health and the OIDC discovery document.
 */
async function buildWorkersApp(): Promise<App> {
  const dbAndEmailLayer = createTestLayer();
  // OSN_ENV unset ⇒ local: no secret requirements, localhost issuer/CORS
  // defaults, no Secure cookies — exactly the local `wrangler dev` env.
  const built = await buildAppDeps(
    { OSN_ISSUER_URL: "http://localhost:4000" },
    {
      coordination: () => createInMemoryCoordination(),
      dbAndEmailLayer,
      observabilityLayer: osnLoggerLayer,
      includeObservabilityPlugin: false,
    },
  );
  // The Workers wiring omits the per-request observability plugin and uses the
  // redacting logger.
  expect(built.deps.includeObservabilityPlugin).toBe(false);
  expect(built.deps.observabilityLayer).toBe(osnLoggerLayer);
  return createApp(built.deps);
}

describe("OSN auth server (Workers-shaped factory wiring)", () => {
  let app: App;
  beforeAll(async () => {
    app = await buildWorkersApp();
  });

  describe("GET /health", () => {
    it("returns ok status from shared observability health route", async () => {
      // healthRoutes stay mounted with includeObservabilityPlugin: false.
      const res = await app.handle(new Request("http://localhost/health"));
      expect(res.status).toBe(200);
      const json = (await res.json()) as { status: string; service: string };
      expect(json.status).toBe("ok");
      expect(json.service).toBe("osn-api");
    });
  });

  describe("GET /.well-known/openid-configuration", () => {
    it("returns OIDC discovery document", async () => {
      const res = await app.handle(
        new Request("http://localhost/.well-known/openid-configuration"),
      );
      expect(res.status).toBe(200);
      const json = (await res.json()) as {
        issuer: string;
        token_endpoint: string;
        grant_types_supported: string[];
      };
      expect(json.issuer).toContain("localhost");
      expect(json.token_endpoint).toContain("/oidc/token");
      expect(json.grant_types_supported).toEqual(["authorization_code", "refresh_token"]);
    });
  });
});
