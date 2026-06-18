import type { TurnstileVerifier } from "@shared/turnstile";
import { Layer } from "effect";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";

import { createAuthRoutes } from "../../src/routes/auth";
import { makeTestAuthConfig } from "../helpers/auth-config";
import { createTestLayer } from "../helpers/db";

/**
 * Turnstile bot-protection gate on `/register/begin` + `/login/passkey/begin`.
 *
 * These tests drive the RAW `createAuthRoutes` factory (not the XFF test
 * wrapper) so they can inject the 8th `turnstileVerifier` argument directly.
 * Per-IP keying isn't under test here, so each request carries an
 * `x-forwarded-for`; the routes run in direct mode (no `clientIpConfig`), which
 * trusts the socket peer — absent a Bun server that resolves to UNRESOLVED and
 * the rate-limit gate denies BEFORE the Turnstile gate. To exercise the
 * Turnstile branch we pass `{ trustedProxyCount: 1 }` so XFF keys the limiter.
 */

let config: Awaited<ReturnType<typeof makeTestAuthConfig>>;
beforeAll(async () => {
  config = await makeTestAuthConfig();
});

/** A stub verifier whose verdict + last-seen args are inspectable. */
function stubVerifier(ok: boolean): TurnstileVerifier & {
  calls: Array<{ token: string | null | undefined; remoteip?: string | null }>;
} {
  const calls: Array<{ token: string | null | undefined; remoteip?: string | null }> = [];
  return {
    calls,
    async verify(token, remoteip) {
      calls.push({ token, remoteip });
      // Mirror the real fail-closed behaviour for a blank token.
      if (!token || token.trim() === "")
        return { ok: false, errorCodes: ["missing-input-response"] };
      return { ok, errorCodes: ok ? [] : ["invalid-input-response"] };
    },
  };
}

function buildApp(verifier: TurnstileVerifier | null) {
  const layer = createTestLayer();
  return createAuthRoutes(
    config,
    layer,
    Layer.empty,
    undefined,
    { secure: false },
    { trustedProxyCount: 1 },
    undefined,
    verifier,
  );
}

const headers = { "Content-Type": "application/json", "x-forwarded-for": "203.0.113.9" };

describe("Turnstile gate — UNCONFIGURED (verifier null) is a clean no-op", () => {
  it("/register/begin proceeds with no token when Turnstile is unconfigured", async () => {
    const app = buildApp(null);
    const res = await app.handle(
      new Request("http://localhost/register/begin", {
        method: "POST",
        headers,
        body: JSON.stringify({ email: "a@example.com", handle: "noturnstile" }),
      }),
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { sent: boolean }).sent).toBe(true);
  });

  it("/login/passkey/begin proceeds with no token when Turnstile is unconfigured", async () => {
    const app = buildApp(null);
    const res = await app.handle(
      new Request("http://localhost/login/passkey/begin", {
        method: "POST",
        headers,
        body: JSON.stringify({ identifier: "ghost@example.com" }),
      }),
    );
    // 200 (challenge issued) — never 400 from a Turnstile gate that's off.
    expect(res.status).toBe(200);
  });
});

describe("Turnstile gate — CONFIGURED enforces siteverify (fail-closed)", () => {
  let verifier: ReturnType<typeof stubVerifier>;
  beforeEach(() => {
    verifier = stubVerifier(true);
  });

  it("/register/begin passes when the token verifies", async () => {
    const app = buildApp(verifier);
    const res = await app.handle(
      new Request("http://localhost/register/begin", {
        method: "POST",
        headers,
        body: JSON.stringify({
          email: "ok@example.com",
          handle: "okhandle",
          turnstileToken: "good",
        }),
      }),
    );
    expect(res.status).toBe(200);
    expect(verifier.calls).toHaveLength(1);
    expect(verifier.calls[0]!.token).toBe("good");
    // remoteip is sourced from cf-connecting-ip; absent here ⇒ null.
    expect(verifier.calls[0]!.remoteip).toBeNull();
  });

  it("/register/begin rejects (400 turnstile_failed) when the token is missing", async () => {
    const app = buildApp(verifier);
    const res = await app.handle(
      new Request("http://localhost/register/begin", {
        method: "POST",
        headers,
        body: JSON.stringify({ email: "x@example.com", handle: "missingtok" }),
      }),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("turnstile_failed");
  });

  it("/register/begin rejects when the token is invalid", async () => {
    const app = buildApp(stubVerifier(false));
    const res = await app.handle(
      new Request("http://localhost/register/begin", {
        method: "POST",
        headers,
        body: JSON.stringify({ email: "y@example.com", handle: "badtok", turnstileToken: "nope" }),
      }),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("turnstile_failed");
  });

  it("passes cf-connecting-ip to siteverify as remoteip", async () => {
    const app = buildApp(verifier);
    await app.handle(
      new Request("http://localhost/register/begin", {
        method: "POST",
        headers: { ...headers, "cf-connecting-ip": "198.51.100.4" },
        body: JSON.stringify({
          email: "ip@example.com",
          handle: "iphandle",
          turnstileToken: "good",
        }),
      }),
    );
    expect(verifier.calls[0]!.remoteip).toBe("198.51.100.4");
  });

  it("/login/passkey/begin rejects when the token is missing", async () => {
    const app = buildApp(verifier);
    const res = await app.handle(
      new Request("http://localhost/login/passkey/begin", {
        method: "POST",
        headers,
        body: JSON.stringify({ identifier: "user@example.com" }),
      }),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("turnstile_failed");
  });

  it("/login/passkey/begin EXEMPTS the no-identifier conditional-UI path (no token required)", async () => {
    // The silent discoverable-credential / passkey-autofill ceremony carries no
    // identifier and no Turnstile token by design. It MUST proceed even when
    // Turnstile is configured — otherwise fail-closed breaks passkey autofill
    // sign-in. The gate must be skipped (verifier never consulted), so the
    // response is NOT `turnstile_failed`.
    const app = buildApp(verifier);
    const res = await app.handle(
      new Request("http://localhost/login/passkey/begin", {
        method: "POST",
        headers,
        body: JSON.stringify({}),
      }),
    );
    const json = (await res.json()) as { error?: string };
    expect(json.error).not.toBe("turnstile_failed");
    expect(res.status).toBe(200);
  });

  it("/login/passkey/begin passes when the token verifies", async () => {
    const app = buildApp(verifier);
    const res = await app.handle(
      new Request("http://localhost/login/passkey/begin", {
        method: "POST",
        headers,
        body: JSON.stringify({ identifier: "user@example.com", turnstileToken: "good" }),
      }),
    );
    expect(res.status).toBe(200);
    expect(verifier.calls).toHaveLength(1);
  });
});
