import { describe, expect, it } from "vitest";

import { createApp } from "../src/app";

/**
 * Top-level app smoke tests. The route-level tests in
 * tests/routes/events.test.ts build a fresh `createEventsRoutes` per
 * test and bypass the plugin wiring, so they don't cover the
 * entry-point wiring. These tests exist to catch plugin-mount
 * regressions (e.g. a refactor that forgets to `.use(healthRoutes(...))`
 * in src/app.ts).
 */
const app = createApp();

describe("pulse API app", () => {
  describe("GET /", () => {
    it("returns service identifier", async () => {
      const res = await app.handle(new Request("http://localhost/"));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { status: string; service: string };
      expect(body.status).toBe("ok");
      expect(body.service).toBe("pulse-api");
    });
  });

  describe("GET /health", () => {
    it("returns ok from the shared observability health route", async () => {
      const res = await app.handle(new Request("http://localhost/health"));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { status: string; service: string };
      expect(body.status).toBe("ok");
      expect(body.service).toBe("pulse-api");
    });
  });

  describe("GET /ready", () => {
    it("returns ready (no probe supplied)", async () => {
      const res = await app.handle(new Request("http://localhost/ready"));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { status: string; service: string };
      expect(body.status).toBe("ready");
      expect(body.service).toBe("pulse-api");
    });
  });

  it("emits x-request-id on every response (plugin mounted)", async () => {
    const res = await app.handle(new Request("http://localhost/health"));
    expect(res.headers.get("x-request-id")).toBeTruthy();
  });

  /**
   * The docs are a tier-gated surface — served on `local` and `dev`, absent on
   * `staging` and `production`. The document maps every route, parameter and
   * error shape, and nothing reads it at runtime (the committed
   * `shared/openapi/pulse.json` feeds the generated clients), so a deployed
   * public host serving it only donates reconnaissance. `src/index.ts` derives
   * the flag from the request-scoped `OSN_ENV` binding; here we check the
   * mount honours it in both directions.
   */
  describe("OpenAPI docs gate", () => {
    it("mounts the document by default (local, tests, the generator)", async () => {
      const res = await app.handle(new Request("http://localhost/openapi/json"));
      expect(res.status).toBe(200);
    });

    it("withholds the document when includeOpenapi is false", async () => {
      const noDocs = createApp({ includeOpenapi: false });
      const res = await noDocs.handle(new Request("http://localhost/openapi/json"));
      expect(res.status).toBe(404);
    });

    it("withholds the Scalar UI too, not just the document", async () => {
      const noDocs = createApp({ includeOpenapi: false });
      const res = await noDocs.handle(new Request("http://localhost/openapi"));
      expect(res.status).toBe(404);
    });

    it("still serves the rest of the app with the docs off", async () => {
      const noDocs = createApp({ includeOpenapi: false });
      const res = await noDocs.handle(new Request("http://localhost/health"));
      expect(res.status).toBe(200);
    });
  });
});
