import { describe, it, expect } from "bun:test";

import { Hono } from "hono";

import { originGuard } from "./origin-guard";

const ALLOWED = "https://cire.example.com";

function createTestApp(origins: string[]) {
  const app = new Hono();
  app.use("*", originGuard({ allowedOrigins: new Set(origins) }));
  app.post("/p", (c) => c.json({ ok: true }));
  app.put("/p", (c) => c.json({ ok: true }));
  app.delete("/p", (c) => c.json({ ok: true }));
  app.get("/p", (c) => c.json({ ok: true }));
  return app;
}

describe("originGuard", () => {
  it("rejects a state-changing request with no Origin header (403)", async () => {
    const app = createTestApp([ALLOWED]);
    const res = await app.request("/p", { method: "POST" });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body).toMatchObject({ error: "forbidden" });
  });

  it("rejects a state-changing request whose Origin is not allowlisted (403)", async () => {
    const app = createTestApp([ALLOWED]);
    const res = await app.request("/p", {
      method: "POST",
      headers: { Origin: "https://evil.example.com" },
    });
    expect(res.status).toBe(403);
  });

  it("allows a state-changing request with an allowlisted Origin", async () => {
    const app = createTestApp([ALLOWED]);
    const res = await app.request("/p", {
      method: "POST",
      headers: { Origin: ALLOWED },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("enforces on PUT and DELETE too", async () => {
    const app = createTestApp([ALLOWED]);
    const put = await app.request("/p", { method: "PUT" });
    expect(put.status).toBe(403);
    const del = await app.request("/p", { method: "DELETE" });
    expect(del.status).toBe(403);
  });

  it("skips validation for GET (non-state-changing)", async () => {
    const app = createTestApp([ALLOWED]);
    const res = await app.request("/p", { method: "GET" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("skips validation entirely when no allowlist is configured (dev mode)", async () => {
    const app = createTestApp([]);
    const res = await app.request("/p", { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
