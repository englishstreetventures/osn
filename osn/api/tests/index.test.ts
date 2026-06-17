import { createMemoryClient } from "@shared/redis";
import { describe, it, expect, beforeAll } from "vitest";

import { createApp, type App } from "../src/app";
import { buildAppDeps } from "../src/build-deps";
import { osnLoggerLayer } from "../src/observability";
import { createTestLayer } from "./helpers/db";

/**
 * Mirrors the route tests (and the production composition): build the app via
 * the `createApp` factory rather than importing the runnable Bun/Workers entry.
 * After the `export default { fetch }` rewrite of `src/index.ts`, the entry is
 * no longer importable as `{ app }` — it constructs its app from the Workers
 * `env` binding.
 *
 * T-L1: build with the WORKERS-SHAPED wiring — `includeObservabilityPlugin:
 * false` + the redacting `osnLoggerLayer` (no full OTel SDK) — and assert that
 * path still mounts `healthRoutes` (`GET /health`), the root route, and the
 * OIDC discovery doc, and that the redacting logger is the one installed. This
 * is exactly what `src/index.ts`'s `buildAll` hands to `createApp`.
 */
async function buildWorkersApp(): Promise<App> {
  // In-memory redis (the local `wrangler dev` / test posture — Upstash absent).
  const redisClient = createMemoryClient();
  const dbAndEmailLayer = createTestLayer();
  // OSN_ENV unset ⇒ local: no secret requirements, localhost issuer/CORS
  // defaults, no Secure cookies — exactly the local `wrangler dev` env.
  const built = await buildAppDeps(
    { OSN_ISSUER_URL: "http://localhost:4000" },
    {
      redisClient,
      dbAndEmailLayer,
      observabilityLayer: osnLoggerLayer,
      includeObservabilityPlugin: false,
    },
  );
  // T-L1: the Workers wiring must omit the per-request observability plugin and
  // adopt the redacting logger.
  expect(built.deps.includeObservabilityPlugin).toBe(false);
  expect(built.deps.observabilityLayer).toBe(osnLoggerLayer);
  return createApp(built.deps);
}

describe("OSN auth server (Workers-shaped factory wiring)", () => {
  let app: App;
  beforeAll(async () => {
    app = await buildWorkersApp();
  });

  describe("GET /", () => {
    it("returns status ok", async () => {
      const res = await app.handle(new Request("http://localhost/"));
      expect(res.status).toBe(200);
      const json = (await res.json()) as { status: string; service: string };
      expect(json.status).toBe("ok");
      expect(json.service).toBe("osn-auth");
    });
  });

  describe("GET /health", () => {
    it("returns ok status from shared observability health route", async () => {
      // T-L1: healthRoutes stay mounted even with includeObservabilityPlugin:false.
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
      expect(json.token_endpoint).toContain("/token");
      expect(json.grant_types_supported).toEqual(["refresh_token"]);
    });
  });
});
