import { describe, it, expect, beforeAll } from "bun:test";

import { createRateLimiter } from "@shared/rate-limit";
import type { TurnstileVerifier } from "@shared/turnstile";

import { createApp } from "../app";
import { createDb, seedDb } from "../db/setup";

/**
 * Turnstile bot-protection gate on the guest surfaces (`/api/claim`,
 * `/api/rsvp`). Exercises the key-optional contract end-to-end through the
 * full app (CORS + origin guard + rate limit + the gate).
 *
 * Every request carries `cf-connecting-ip` (the fail-closed limiter denies a
 * request without a resolvable IP) and a same-origin `Origin` (the origin guard
 * gates state-changing methods).
 */

const db = createDb(":memory:");
beforeAll(() => seedDb(db));

/** Stub verifier with inspectable verdict + captured args. */
function stubVerifier(ok: boolean): TurnstileVerifier & {
  calls: Array<{ token: string | null | undefined; remoteip?: string | null }>;
} {
  const calls: Array<{ token: string | null | undefined; remoteip?: string | null }> = [];
  return {
    calls,
    async verify(token, remoteip) {
      calls.push({ token, remoteip });
      if (!token || token.trim() === "")
        return { ok: false, errorCodes: ["missing-input-response"] };
      return { ok, errorCodes: ok ? [] : ["invalid-input-response"] };
    },
  };
}

const headers = (extra: Record<string, string> = {}) => ({
  "Content-Type": "application/json",
  "cf-connecting-ip": "203.0.113.7",
  Origin: "http://localhost:4321",
  ...extra,
});

function appWith(verifier: TurnstileVerifier | null) {
  return createApp(db, {
    claimLimiter: createRateLimiter({ maxRequests: 10_000, windowMs: 60_000 }),
    turnstileVerifier: verifier,
  });
}

describe("Turnstile gate — UNCONFIGURED is a clean no-op", () => {
  it("/api/claim succeeds with no token when Turnstile is unconfigured", async () => {
    const app = appWith(null);
    const res = await app.fetch(
      new Request("http://localhost/api/claim", {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ publicId: "TESTONE-IVY-AA11" }),
      }),
    );
    expect(res.status).toBe(200);
  });
});

describe("Turnstile gate on /api/claim — CONFIGURED (fail-closed)", () => {
  it("passes a valid token through to the credential lookup", async () => {
    const verifier = stubVerifier(true);
    const app = appWith(verifier);
    const res = await app.fetch(
      new Request("http://localhost/api/claim", {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ publicId: "TESTONE-IVY-AA11", turnstileToken: "good" }),
      }),
    );
    expect(res.status).toBe(200);
    expect(verifier.calls).toHaveLength(1);
    expect(verifier.calls[0]!.token).toBe("good");
    expect(verifier.calls[0]!.remoteip).toBe("203.0.113.7");
  });

  it("rejects (403) a missing token BEFORE the credential lookup", async () => {
    const verifier = stubVerifier(true);
    const app = appWith(verifier);
    const res = await app.fetch(
      new Request("http://localhost/api/claim", {
        method: "POST",
        headers: headers(),
        // A VALID code, but no token — must still be rejected by the gate, and
        // the claim lookup must never run (no session minted).
        body: JSON.stringify({ publicId: "TESTONE-IVY-AA11" }),
      }),
    );
    expect(res.status).toBe(403);
    expect(res.headers.get("Set-Cookie")).toBeNull();
  });

  it("rejects (403) an invalid token", async () => {
    const app = appWith(stubVerifier(false));
    const res = await app.fetch(
      new Request("http://localhost/api/claim", {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ publicId: "TESTONE-IVY-AA11", turnstileToken: "bad" }),
      }),
    );
    expect(res.status).toBe(403);
  });
});

describe("Turnstile is NOT enforced on /api/rsvp — claimed guests are already trusted", () => {
  /** Claim first (with a passing gate) to obtain a session cookie. */
  async function claimSession(verifier: TurnstileVerifier): Promise<string> {
    const app = appWith(verifier);
    const res = await app.fetch(
      new Request("http://localhost/api/claim", {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ publicId: "TESTONE-IVY-AA11", turnstileToken: "good" }),
      }),
    );
    expect(res.status).toBe(200);
    const cookie = res.headers.get("Set-Cookie");
    expect(cookie).not.toBeNull();
    return cookie!.split(";")[0]!;
  }

  it("accepts an RSVP with a valid session and NO token, even when Turnstile is configured", async () => {
    const verifier = stubVerifier(true);
    const sessionCookie = await claimSession(verifier);
    const callsAfterClaim = verifier.calls.length;
    const app = appWith(verifier);
    const res = await app.fetch(
      new Request("http://localhost/api/rsvp", {
        method: "POST",
        headers: headers({ Cookie: sessionCookie }),
        // No turnstileToken. An empty batch is a valid no-op RSVP and must reach
        // the handler (200) — proving RSVP is not behind the Turnstile gate.
        body: JSON.stringify({ rsvps: [] }),
      }),
    );
    expect(res.status).toBe(200);
    // The verifier was consulted only by /api/claim, never by /api/rsvp.
    expect(verifier.calls.length).toBe(callsAfterClaim);
  });
});
