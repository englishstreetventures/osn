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

describe("rateLimitMiddleware", () => {
  it("passes through when under limit", async () => {
    const app = createTestApp(5);
    const res = await app.request("/test", { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true });
  });

  it("returns 429 when over limit", async () => {
    const app = createTestApp(2);
    await app.request("/test", { method: "POST" });
    await app.request("/test", { method: "POST" });
    const res = await app.request("/test", { method: "POST" });
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body).toEqual({ error: "Too many requests" });
  });

  it("includes Retry-After header on 429", async () => {
    const app = createTestApp(1);
    await app.request("/test", { method: "POST" });
    const res = await app.request("/test", { method: "POST" });
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("60");
  });
});
