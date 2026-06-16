import { describe, it, expect } from "bun:test";

import { createRateLimiter } from "@shared/rate-limit";
import { Hono } from "hono";

import { rateLimitMiddleware } from "./rate-limit";

function createTestApp(maxRequests: number) {
  const limiter = createRateLimiter({ maxRequests, windowMs: 60_000 });
  const app = new Hono();
  app.use("/test", rateLimitMiddleware(limiter));
  app.post("/test", (c) => c.json({ ok: true }));
  return app;
}

// Behind Cloudflare every request carries `cf-connecting-ip`; the limiter keys
// on it. Tests must supply it or they hit the fail-closed path (C4).
const CF_IP = { "cf-connecting-ip": "1.2.3.4" };

describe("rateLimitMiddleware", () => {
  it("passes through when under limit", async () => {
    const app = createTestApp(5);
    const res = await app.request("/test", { method: "POST", headers: CF_IP });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true });
  });

  it("returns 429 when over limit", async () => {
    const app = createTestApp(2);
    await app.request("/test", { method: "POST", headers: CF_IP });
    await app.request("/test", { method: "POST", headers: CF_IP });
    const res = await app.request("/test", { method: "POST", headers: CF_IP });
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body).toEqual({ error: "Too many requests" });
  });

  it("includes Retry-After header on 429", async () => {
    const app = createTestApp(1);
    await app.request("/test", { method: "POST", headers: CF_IP });
    const res = await app.request("/test", { method: "POST", headers: CF_IP });
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("60");
  });

  it("fails closed (429) when no trusted IP header is present (C4)", async () => {
    const app = createTestApp(5);
    // No cf-connecting-ip — and x-forwarded-for must NOT be trusted.
    const res = await app.request("/test", {
      method: "POST",
      headers: { "x-forwarded-for": "9.9.9.9" },
    });
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("60");
    const body = await res.json();
    expect(body).toEqual({ error: "Too many requests" });
  });
});
