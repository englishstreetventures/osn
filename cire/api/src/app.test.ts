import { describe, it, expect } from "bun:test";

import { createRateLimiter } from "@shared/rate-limit";

import { createApp } from "./app";
import { createDb } from "./db/setup";
import { appRequest } from "./test-helpers";

// CORS + not-found behavior only — no DB rows needed.
const db = createDb(":memory:");
const app = createApp(db, {
  webOrigin: "http://localhost:4321",
  allowedOrigins: ["http://localhost:4321", "http://localhost:4322"],
  claimLimiter: createRateLimiter({ maxRequests: 10_000, windowMs: 60_000 }),
});

// S-C2 adjacent: this is credentialed CORS on an auth API. The contract the
// old hand-rolled Hono callback documented — echo the request origin verbatim
// when allowlisted, never `*`, no header on mismatch — must survive the
// @elysiajs/cors swap.
describe("CORS", () => {
  it("echoes an allowlisted Origin verbatim with credentials", async () => {
    const res = await appRequest(app, "/api/claim", {
      method: "POST",
      headers: { Origin: "http://localhost:4322", "Content-Type": "application/json" },
      body: "{}",
    });
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("http://localhost:4322");
    expect(res.headers.get("Access-Control-Allow-Credentials")).toBe("true");
  });

  it("answers preflight with the requesting origin, never *", async () => {
    const res = await appRequest(app, "/api/claim", {
      method: "OPTIONS",
      headers: {
        Origin: "http://localhost:4321",
        "Access-Control-Request-Method": "POST",
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("http://localhost:4321");
  });

  it("omits Access-Control-Allow-Origin for a disallowed origin", async () => {
    const res = await appRequest(app, "/api/claim", {
      method: "POST",
      headers: { Origin: "http://evil.example", "Content-Type": "application/json" },
      body: "{}",
    });
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });
});

describe("not-found handler", () => {
  it("returns the JSON 404 contract for unknown paths", async () => {
    const res = await appRequest(app, "/nope");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Not found" });
  });
});
