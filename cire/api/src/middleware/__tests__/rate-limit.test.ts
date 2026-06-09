import { describe, expect, it } from "bun:test";

import { createRateLimiter } from "@shared/rate-limit";
import { Hono } from "hono";

import { rateLimitMiddleware } from "../rate-limit";

describe("rateLimitMiddleware on @shared/rate-limit", () => {
  it("allows requests up to maxRequests then returns 429", async () => {
    const limiter = createRateLimiter({ maxRequests: 2, windowMs: 60_000 });
    const app = new Hono();
    app.use("/limited", rateLimitMiddleware(limiter));
    app.get("/limited", (c) => c.text("ok"));

    const req = () => app.request("/limited", { headers: { "CF-Connecting-IP": "203.0.113.1" } });

    const r1 = await req();
    const r2 = await req();
    const r3 = await req();

    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r3.status).toBe(429);
    expect(r3.headers.get("Retry-After")).toBe("60");
  });
});
