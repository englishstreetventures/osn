import { describe, it, expect } from "bun:test";

import { createRateLimiter } from "@shared/rate-limit";
import { Elysia } from "elysia";

import { appRequest } from "../test-helpers";
import { rateLimitMiddleware } from "./rate-limit";

function createTestApp(maxRequests: number) {
  const limiter = createRateLimiter({ maxRequests, windowMs: 60_000 });
  return new Elysia({ aot: false })
    .use(rateLimitMiddleware(limiter))
    .post("/test", () => ({ ok: true }));
}

describe("rateLimitMiddleware", () => {
  it("passes through when under limit", async () => {
    const app = createTestApp(5);
    const res = await appRequest(app, "/test", { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true });
  });

  it("returns 429 when over limit", async () => {
    const app = createTestApp(2);
    await appRequest(app, "/test", { method: "POST" });
    await appRequest(app, "/test", { method: "POST" });
    const res = await appRequest(app, "/test", { method: "POST" });
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body).toEqual({ error: "Too many requests" });
  });

  it("includes Retry-After header on 429", async () => {
    const app = createTestApp(1);
    await appRequest(app, "/test", { method: "POST" });
    const res = await appRequest(app, "/test", { method: "POST" });
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("60");
  });
});
