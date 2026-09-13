import { describe, it, expect, beforeAll } from "bun:test";

import { createRateLimiter } from "@shared/rate-limit";

import { createApp } from "../../src/app";
import { createDb, seedDb } from "../../src/db/setup";
import { jsonBody } from "../test-helpers";

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
    expect(await jsonBody(res)).toEqual({ error: "forbidden", message: "Missing Origin header" });
  });

  it("403s a state-changing POST with a mismatched Origin", async () => {
    const res = await send("/api/claim", "POST", "http://evil.example");
    expect(res.status).toBe(403);
    expect(await jsonBody(res)).toEqual({ error: "forbidden", message: "Origin not allowed" });
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

/**
 * Stripe delivers server-to-server, with no `Origin` header at all — so the
 * guard's missing-Origin branch would 403 every real delivery before its
 * signature was ever checked, and Stripe would retry that 403 for days.
 *
 * The existing webhook tests cannot see this: they go through `appRequest`,
 * which injects an Origin. These build the request by hand.
 */
describe("the Stripe webhook is exempt (S-C1)", () => {
  const webhookDb = createDb(":memory:");
  const SECRET = "whsec_test";
  const webhookApp = createApp(webhookDb, {
    webOrigin: "http://localhost:4321",
    allowedOrigins: ["http://localhost:4321"],
    stripeWebhookSecret: SECRET,
  });

  beforeAll(() => seedDb(webhookDb));

  async function hmacHex(secret: string, payload: string): Promise<string> {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const digest = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  /** No `Origin` header, the way Stripe actually sends it. */
  function deliver(headers: Record<string, string>, body: string) {
    return webhookApp.fetch(
      new Request("http://localhost/api/stripe/webhook", {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body,
      }),
    );
  }

  it("accepts a signed delivery that carries no Origin", async () => {
    const at = Math.floor(Date.now() / 1000);
    // An event type this product does not act on: still a 200, and enough to
    // prove the request reached the handler rather than the guard.
    const body = JSON.stringify({ id: "evt_1", type: "invoice.paid", created: at, data: {} });
    const res = await deliver(
      { "stripe-signature": `t=${at},v1=${await hmacHex(SECRET, `${at}.${body}`)}` },
      body,
    );
    expect(res.status).toBe(200);
  });

  it("leaves an unsigned delivery to the handler, which refuses it as unsigned", async () => {
    // 400 from the signature check, NOT 403 from the guard: the exemption
    // removes the origin check, not the authentication.
    const res = await deliver({}, JSON.stringify({ id: "evt_2" }));
    expect(res.status).toBe(400);
    expect(await jsonBody(res)).toEqual({ error: "invalid_signature", reason: "malformed" });
  });

  it("matches the exempt path past a query string", async () => {
    // The exemption is keyed on the pathname, which is extracted by hand rather
    // than by a full `new URL()` — so a delivery carrying a query string must
    // still match, not fall through to the missing-Origin 403.
    const at = Math.floor(Date.now() / 1000);
    const body = JSON.stringify({ id: "evt_3", type: "invoice.paid", created: at, data: {} });
    const res = await webhookApp.fetch(
      new Request("http://localhost/api/stripe/webhook?redelivery=1", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "stripe-signature": `t=${at},v1=${await hmacHex(SECRET, `${at}.${body}`)}`,
        },
        body,
      }),
    );
    expect(res.status).toBe(200);
  });

  it("still gates an Origin-less POST to an ordinary route", async () => {
    const res = await webhookApp.fetch(
      new Request("http://localhost/api/claim", {
        method: "POST",
        headers: { "content-type": "application/json", "cf-connecting-ip": CF },
        body: "{}",
      }),
    );
    expect(res.status).toBe(403);
  });
});
