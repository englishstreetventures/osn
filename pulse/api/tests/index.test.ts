import { describe, expect, it } from "vitest";

import { app } from "../src/index";

/**
 * Top-level app smoke tests. The route-level tests in
 * tests/routes/events.test.ts build a fresh `createEventsRoutes` per
 * test and bypass the plugin wiring, so they don't cover the
 * entry-point wiring. These tests exist to catch plugin-mount
 * regressions (e.g. a refactor that forgets to `.use(healthRoutes(...))`
 * in src/index.ts).
 */
describe("pulse API app", () => {
  describe("GET /", () => {
    it("returns service identifier", async () => {
      const res = await app.handle(new Request("http://localhost/"));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { status: string; service: string };
      expect(body.status).toBe("ok");
      expect(body.service).toBe("osn-api");
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
});
