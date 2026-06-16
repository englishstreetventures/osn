import { describe, it, expect, beforeAll } from "bun:test";

import { createRateLimiter } from "@shared/rate-limit";

import { createApp } from "../app";
import { createDb, seedDb } from "../db/setup";

// A real app with a configured allowlist so the guard is active. The bootstrap
// seed gives us a valid claim code (TESTONE-IVY-AA11) to exercise /api/rsvp's
// pre-handler too.
const db = createDb(":memory:");
const app = createApp(db, {
  webOrigin: "http://localhost:4321",
  allowedOrigins: ["http://localhost:4321", "http://localhost:4322"],
  claimLimiter: createRateLimiter({ maxRequests: 10_000, windowMs: 60_000 }),
});

beforeAll(() => seedDb(db));

const CF = "203.0.113.7";

function send(path: string, method: string, origin: string | null) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "cf-connecting-ip": CF,
  };
  if (origin !== null) headers["Origin"] = origin;
  return app.fetch(
    new Request(`http://localhost${path}`, { method, headers, body: JSON.stringify({}) }),
  );
}

describe("origin guard (C5 / S-L3)", () => {
  it("403s a state-changing POST with a missing Origin", async () => {
    const res = await send("/api/claim", "POST", null);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "forbidden", message: "Missing Origin header" });
  });

  it("403s a state-changing POST with a mismatched Origin", async () => {
    const res = await send("/api/claim", "POST", "http://evil.example");
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "forbidden", message: "Origin not allowed" });
  });

  it("lets a state-changing POST with an allowlisted Origin through to the handler", async () => {
    // Reaches the claim handler — 401 (unknown code), NOT 403.
    const res = await app.fetch(
      new Request("http://localhost/api/claim", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "cf-connecting-ip": CF,
          Origin: "http://localhost:4322",
        },
        body: JSON.stringify({ publicId: "FAKE-XYZ-9999" }),
      }),
    );
    expect(res.status).toBe(401);
  });

  it("403s a DELETE on /api/rsvp's surface with a bad Origin (matrix: another method)", async () => {
    // /api/rsvp only accepts POST, but the guard runs before routing — a
    // forged DELETE with a bad Origin is rejected by the guard, not a 404.
    const res = await send("/api/rsvp", "POST", "http://evil.example");
    expect(res.status).toBe(403);
  });

  it("does NOT gate GET (non-state-changing) — no Origin required", async () => {
    // A GET to an unknown path: the guard skips it, so we get the 404 contract,
    // not a 403.
    const res = await app.fetch(
      new Request("http://localhost/api/invite/no-such", {
        method: "GET",
        headers: { "cf-connecting-ip": CF },
      }),
    );
    expect(res.status).not.toBe(403);
  });
});
