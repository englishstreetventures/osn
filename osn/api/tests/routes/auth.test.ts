import type { RateLimiterBackend } from "@shared/rate-limit";
import { Effect, Layer } from "effect";
import { describe, it, expect, beforeEach, beforeAll } from "vitest";

import { createAuthRoutes, createDefaultAuthRateLimiters } from "../../src/routes/auth";
import { createAuthService } from "../../src/services/auth";
import { makeTestAuthConfig } from "../helpers/auth-config";
import { createTestLayer } from "../helpers/db";

let config: Awaited<ReturnType<typeof makeTestAuthConfig>>;

beforeAll(async () => {
  config = await makeTestAuthConfig();
});

describe("auth routes", () => {
  let app: ReturnType<typeof createAuthRoutes>;
  let layer: ReturnType<typeof createTestLayer>;

  beforeEach(() => {
    layer = createTestLayer();
    app = createAuthRoutes(config, layer);
  });

  // -------------------------------------------------------------------------
  // Registration
  // -------------------------------------------------------------------------
  describe("POST /register", () => {
    it("creates a user and returns 201", async () => {
      const res = await app.handle(
        new Request("http://localhost/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            email: "alice@example.com",
            handle: "alice",
            displayName: "Alice",
          }),
        }),
      );
      expect(res.status).toBe(201);
      const json = (await res.json()) as { profileId: string; handle: string; email: string };
      expect(json.handle).toBe("alice");
      expect(json.email).toBe("alice@example.com");
      expect(json.profileId).toMatch(/^usr_/);
    });

    it("returns 400 for duplicate email", async () => {
      await app.handle(
        new Request("http://localhost/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: "bob@example.com", handle: "bob" }),
        }),
      );
      const res = await app.handle(
        new Request("http://localhost/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: "bob@example.com", handle: "bob2" }),
        }),
      );
      expect(res.status).toBe(400);
    });

    it("returns 400 for duplicate handle", async () => {
      await app.handle(
        new Request("http://localhost/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: "carol@example.com", handle: "carol" }),
        }),
      );
      const res = await app.handle(
        new Request("http://localhost/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: "carol2@example.com", handle: "carol" }),
        }),
      );
      expect(res.status).toBe(400);
    });

    it("returns 400 for invalid handle format", async () => {
      const res = await app.handle(
        new Request("http://localhost/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: "dan@example.com", handle: "Dan!" }),
        }),
      );
      expect(res.status).toBe(400);
    });
  });

  // -------------------------------------------------------------------------
  // Email-verified registration (begin + complete)
  // -------------------------------------------------------------------------
  describe("POST /register/begin + /register/complete", () => {
    it("does not create the user until the OTP is verified", async () => {
      let captured: string | undefined;
      const verifiedConfig = {
        ...config,
        sendEmail: async (_to: string, _subject: string, body: string) => {
          const m = body.match(/code is: (\d{6})/);
          if (m) captured = m[1];
        },
      };
      const verifiedApp = createAuthRoutes(verifiedConfig, layer);

      // Begin: should send a code but NOT create the user yet.
      const beginRes = await verifiedApp.handle(
        new Request("http://localhost/register/begin", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            email: "verify-me@example.com",
            handle: "verifyme",
            displayName: "Verify Me",
          }),
        }),
      );
      expect(beginRes.status).toBe(200);
      expect(((await beginRes.json()) as { sent: boolean }).sent).toBe(true);
      expect(captured).toMatch(/^\d{6}$/);

      // Handle should still be free, since user wasn't created.
      const checkRes = await verifiedApp.handle(new Request("http://localhost/handle/verifyme"));
      expect(((await checkRes.json()) as { available: boolean }).available).toBe(true);

      // Complete: with the right code, user is created and a Session +
      // enrollment_token are returned directly (no /token round-trip).
      const completeRes = await verifiedApp.handle(
        new Request("http://localhost/register/complete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: "verify-me@example.com", code: captured! }),
        }),
      );
      expect(completeRes.status).toBe(201);
      const json = (await completeRes.json()) as {
        profileId: string;
        handle: string;
        email: string;
        session: {
          access_token: string;
          refresh_token: string;
          token_type: string;
          expires_in: number;
        };
        enrollment_token: string;
      };
      expect(json.profileId).toMatch(/^usr_/);
      expect(json.handle).toBe("verifyme");
      expect(json.email).toBe("verify-me@example.com");
      expect(json.session.access_token.length).toBeGreaterThan(0);
      // C3: refresh_token no longer in body — carried in HttpOnly cookie
      expect(json.session.refresh_token).toBeUndefined();
      expect(json.session.token_type).toBe("Bearer");
      expect(json.session.expires_in).toBeGreaterThan(0);
      // Verify Set-Cookie header is present
      expect(completeRes.headers.get("set-cookie")).toContain("osn_session=");
      expect(completeRes.headers.get("set-cookie")).toContain("HttpOnly");
      expect(json.enrollment_token.length).toBeGreaterThan(0);

      // Handle now taken.
      const checkRes2 = await verifiedApp.handle(new Request("http://localhost/handle/verifyme"));
      expect(((await checkRes2.json()) as { available: boolean }).available).toBe(false);
    });

    it("rejects the wrong OTP and does not create the user", async () => {
      const beginRes = await app.handle(
        new Request("http://localhost/register/begin", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: "wrong-otp@example.com", handle: "wrongotp" }),
        }),
      );
      expect(beginRes.status).toBe(200);

      const completeRes = await app.handle(
        new Request("http://localhost/register/complete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: "wrong-otp@example.com", code: "000000" }),
        }),
      );
      expect(completeRes.status).toBe(400);

      const checkRes = await app.handle(new Request("http://localhost/handle/wrongotp"));
      expect(((await checkRes.json()) as { available: boolean }).available).toBe(true);
    });

    it("S-M1: returns sent:true silently when the email is already registered", async () => {
      // Enumeration-resistant: never differentiate between "free" and "taken"
      // accounts on /register/begin. The handle availability check is the
      // appropriate channel for that question.
      await app.handle(
        new Request("http://localhost/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: "taken@example.com", handle: "takenuser" }),
        }),
      );
      const res = await app.handle(
        new Request("http://localhost/register/begin", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: "taken@example.com", handle: "newhandle" }),
        }),
      );
      expect(res.status).toBe(200);
      expect(((await res.json()) as { sent: boolean }).sent).toBe(true);
    });

    it("S-M1: returns sent:true silently when the handle is already taken", async () => {
      await app.handle(
        new Request("http://localhost/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: "first@example.com", handle: "duphandle" }),
        }),
      );
      const res = await app.handle(
        new Request("http://localhost/register/begin", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: "second@example.com", handle: "duphandle" }),
        }),
      );
      expect(res.status).toBe(200);
      expect(((await res.json()) as { sent: boolean }).sent).toBe(true);
    });

    it("rejects begin for an invalid handle format", async () => {
      const res = await app.handle(
        new Request("http://localhost/register/begin", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: "ok@example.com", handle: "Bad Handle!" }),
        }),
      );
      expect(res.status).toBe(400);
    });

    it("rejects /register/complete with no preceding /register/begin", async () => {
      const res = await app.handle(
        new Request("http://localhost/register/complete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: "never-began@example.com", code: "123456" }),
        }),
      );
      expect(res.status).toBe(400);
    });

    it("rejects /register/complete on replay (single-use OTP)", async () => {
      let captured: string | undefined;
      const verifiedConfig = {
        ...config,
        sendEmail: async (_to: string, _subject: string, body: string) => {
          const m = body.match(/code is: (\d{6})/);
          if (m) captured = m[1];
        },
      };
      const verifiedApp = createAuthRoutes(verifiedConfig, layer);

      await verifiedApp.handle(
        new Request("http://localhost/register/begin", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: "replay-route@example.com", handle: "replayroute" }),
        }),
      );

      const first = await verifiedApp.handle(
        new Request("http://localhost/register/complete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: "replay-route@example.com", code: captured! }),
        }),
      );
      expect(first.status).toBe(201);

      const second = await verifiedApp.handle(
        new Request("http://localhost/register/complete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: "replay-route@example.com", code: captured! }),
        }),
      );
      expect(second.status).toBe(400);
    });
  });

  // -------------------------------------------------------------------------
  // Reserved handles via /handle/:handle
  // -------------------------------------------------------------------------
  describe("GET /handle/:handle (reserved)", () => {
    it("returns available:false for a reserved handle", async () => {
      const res = await app.handle(new Request("http://localhost/handle/admin"));
      expect(res.status).toBe(200);
      const json = (await res.json()) as { available: boolean };
      expect(json.available).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Handle availability
  // -------------------------------------------------------------------------
  describe("GET /handle/:handle", () => {
    it("returns available:true for a free handle", async () => {
      const res = await app.handle(new Request("http://localhost/handle/freehandle"));
      expect(res.status).toBe(200);
      const json = (await res.json()) as { available: boolean };
      expect(json.available).toBe(true);
    });

    it("returns available:false for a taken handle", async () => {
      await app.handle(
        new Request("http://localhost/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: "eve@example.com", handle: "eve" }),
        }),
      );
      const res = await app.handle(new Request("http://localhost/handle/eve"));
      expect(res.status).toBe(200);
      const json = (await res.json()) as { available: boolean };
      expect(json.available).toBe(false);
    });

    it("returns 400 for invalid handle format", async () => {
      const res = await app.handle(new Request("http://localhost/handle/INVALID%21"));
      expect(res.status).toBe(400);
    });
  });

  // -------------------------------------------------------------------------
  // Token endpoint
  // -------------------------------------------------------------------------
  describe("POST /token", () => {
    it("returns 400 for unsupported grant_type", async () => {
      const res = await app.handle(
        new Request("http://localhost/token", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ grant_type: "implicit" }),
        }),
      );
      expect(res.status).toBe(400);
      const json = (await res.json()) as { error: string };
      expect(json.error).toBe("unsupported_grant_type");
    });

    it("C2: replaying a rotated-out refresh cookie revokes the entire family", async () => {
      // Route-layer integration test for reuse detection. Service-level
      // coverage already exercises the detector in isolation; this one
      // locks in the Elysia derive + cookie-reader glue so a regression in
      // cookie handling or rate-limit ordering can't silently downgrade C2.
      let captured: string | undefined;
      const verifiedApp = createAuthRoutes(
        {
          ...config,
          sendEmail: async (_to, _subject, body) => {
            const m = body.match(/code is: (\d{6})/);
            if (m) captured = m[1];
          },
        },
        layer,
      );

      await verifiedApp.handle(
        new Request("http://localhost/register/begin", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: "reuse-route@example.com", handle: "reuseroute" }),
        }),
      );
      const completeRes = await verifiedApp.handle(
        new Request("http://localhost/register/complete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: "reuse-route@example.com", code: captured! }),
        }),
      );
      expect(completeRes.status).toBe(201);
      const originalCookie = completeRes.headers.get("set-cookie")!;
      const originalSession = originalCookie.match(/osn_session=([^;]+)/)![1]!;

      // Rotate once — the server-issued Set-Cookie carries the new token.
      const rotateRes = await verifiedApp.handle(
        new Request("http://localhost/token", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            cookie: `osn_session=${originalSession}`,
          },
          body: JSON.stringify({ grant_type: "refresh_token" }),
        }),
      );
      expect(rotateRes.status).toBe(200);
      const rotatedCookie = rotateRes.headers.get("set-cookie")!;
      const rotatedSession = rotatedCookie.match(/osn_session=([^;]+)/)![1]!;
      expect(rotatedSession).not.toBe(originalSession);

      // Replay the original (rotated-out) cookie — must be rejected.
      const replayRes = await verifiedApp.handle(
        new Request("http://localhost/token", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            cookie: `osn_session=${originalSession}`,
          },
          body: JSON.stringify({ grant_type: "refresh_token" }),
        }),
      );
      expect(replayRes.status).toBe(400);

      // And the token from the rotation must now be revoked too — family
      // revocation logs everyone out, not just the attacker.
      const rotatedAfterReuse = await verifiedApp.handle(
        new Request("http://localhost/token", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            cookie: `osn_session=${rotatedSession}`,
          },
          body: JSON.stringify({ grant_type: "refresh_token" }),
        }),
      );
      expect(rotatedAfterReuse.status).toBe(400);
    });

    it("rejects refresh_token supplied in the body (cookie-only contract, S-M1)", async () => {
      // The body fallback was removed: any refresh_token submitted outside
      // the HttpOnly cookie must fail with invalid_request, independent of
      // whether the token itself would be valid.
      let captured: string | undefined;
      const cookieOnlyApp = createAuthRoutes(
        {
          ...config,
          sendEmail: async (_to, _subject, body) => {
            const m = body.match(/code is: (\d{6})/);
            if (m) captured = m[1];
          },
        },
        layer,
      );

      await cookieOnlyApp.handle(
        new Request("http://localhost/register/begin", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: "cookie-only@example.com", handle: "cookieonly" }),
        }),
      );
      const completeRes = await cookieOnlyApp.handle(
        new Request("http://localhost/register/complete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: "cookie-only@example.com", code: captured! }),
        }),
      );
      expect(completeRes.status).toBe(201);
      const cookie = completeRes.headers.get("set-cookie")!;
      const refreshToken = cookie.match(/osn_session=([^;]+)/)![1]!;

      // No cookie, token in body — must 400 with invalid_request.
      const res = await cookieOnlyApp.handle(
        new Request("http://localhost/token", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ grant_type: "refresh_token", refresh_token: refreshToken }),
        }),
      );
      expect(res.status).toBe(400);
      const json = (await res.json()) as { error: string };
      expect(json.error).toBe("invalid_request");
    });
  });

  // -------------------------------------------------------------------------
  // Direct-session login (/login/*)
  // -------------------------------------------------------------------------
  describe("POST /login/otp/begin", () => {
    it("returns sent:true for a known user", async () => {
      await app.handle(
        new Request("http://localhost/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: "nia@example.com", handle: "nia" }),
        }),
      );
      const res = await app.handle(
        new Request("http://localhost/login/otp/begin", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ identifier: "nia@example.com" }),
        }),
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ sent: true });
    });

    it("still returns sent:true for an unknown user (enumeration-safe)", async () => {
      const res = await app.handle(
        new Request("http://localhost/login/otp/begin", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ identifier: "ghost@example.com" }),
        }),
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ sent: true });
    });
  });

  describe("POST /login/otp/complete", () => {
    it("returns a session + public user on a valid code", async () => {
      let capturedCode: string | undefined;
      const authHelper = createAuthService({
        ...config,
        sendEmail: async (_to, _subject, body) => {
          const m = body.match(/\b(\d{6})\b/);
          if (m) capturedCode = m[1];
        },
      });
      await Effect.runPromise(
        authHelper
          .registerProfile("otp-direct@example.com", "otpdirect")
          .pipe(Effect.provide(layer)),
      );
      await Effect.runPromise(
        authHelper.beginOtp("otp-direct@example.com").pipe(Effect.provide(layer)),
      );

      const res = await app.handle(
        new Request("http://localhost/login/otp/complete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ identifier: "otp-direct@example.com", code: capturedCode }),
        }),
      );
      expect(res.status).toBe(200);
      const json = (await res.json()) as {
        session: { access_token: string; expires_in: number };
        profile: { id: string; handle: string; email: string };
      };
      expect(json.session.access_token).toBeTruthy();
      // C3: refresh_token in cookie, not body
      expect(res.headers.get("set-cookie")).toContain("osn_session=");
      expect(json.profile.handle).toBe("otpdirect");
      expect(json.profile.email).toBe("otp-direct@example.com");
    });

    it("returns 400 for a wrong code", async () => {
      await app.handle(
        new Request("http://localhost/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: "oscar@example.com", handle: "oscar" }),
        }),
      );
      await app.handle(
        new Request("http://localhost/login/otp/begin", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ identifier: "oscar@example.com" }),
        }),
      );
      const res = await app.handle(
        new Request("http://localhost/login/otp/complete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ identifier: "oscar@example.com", code: "000000" }),
        }),
      );
      expect(res.status).toBe(400);
    });
  });

  describe("POST /login/magic/begin", () => {
    it("returns sent:true for a known user", async () => {
      await app.handle(
        new Request("http://localhost/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: "pip@example.com", handle: "pip" }),
        }),
      );
      const res = await app.handle(
        new Request("http://localhost/login/magic/begin", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ identifier: "pip@example.com" }),
        }),
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ sent: true });
    });

    it("still returns sent:true for an unknown user (enumeration-safe)", async () => {
      const res = await app.handle(
        new Request("http://localhost/login/magic/begin", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ identifier: "ghost2@example.com" }),
        }),
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ sent: true });
    });
  });

  describe("POST /login/magic/verify", () => {
    it("returns a session + public user for a valid magic token", async () => {
      let capturedToken: string | undefined;
      const authHelper = createAuthService({
        ...config,
        sendEmail: async (_to, _subject, body) => {
          const m = body.match(/token=([^\s]+)/);
          if (m) capturedToken = m[1];
        },
      });
      await Effect.runPromise(
        authHelper
          .registerProfile("magic-direct@example.com", "magicdirect")
          .pipe(Effect.provide(layer)),
      );
      await Effect.runPromise(
        authHelper.beginMagic("magic-direct@example.com").pipe(Effect.provide(layer)),
      );

      const res = await app.handle(
        new Request("http://localhost/login/magic/verify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token: capturedToken }),
        }),
      );
      expect(res.status).toBe(200);
      const json = (await res.json()) as {
        session: { access_token: string };
        profile: { handle: string; email: string };
      };
      expect(json.session.access_token).toBeTruthy();
      expect(json.profile.handle).toBe("magicdirect");
    });

    it("returns 400 for an unknown token", async () => {
      const res = await app.handle(
        new Request("http://localhost/login/magic/verify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token: "bogus" }),
        }),
      );
      expect(res.status).toBe(400);
    });

    it("S-H1: emailed URL points at the frontend origin, not the API", async () => {
      // Lockstep check: beginMagic emits a URL whose origin must be
      // `config.origin` (the frontend RP origin) — putting the access token
      // on the API domain would render it in the browser window and burn it
      // to email-scanner pre-fetchers.
      let capturedUrl: string | undefined;
      const emailSpy = async (_to: string, _subject: string, body: string) => {
        const m = body.match(/https?:\/\/\S+/);
        if (m) capturedUrl = m[0];
      };
      const spyApp = createAuthRoutes({ ...config, sendEmail: emailSpy }, layer);

      await spyApp.handle(
        new Request("http://localhost/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: "lockstep@example.com", handle: "lockstep" }),
        }),
      );
      await spyApp.handle(
        new Request("http://localhost/login/magic/begin", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ identifier: "lockstep@example.com" }),
        }),
      );
      expect(capturedUrl).toBeTruthy();
      const parsed = new URL(capturedUrl!);
      // Frontend origin (config.origin), NOT the API (config.issuerUrl).
      expect(parsed.origin).toBe(config.origin);
      expect(parsed.origin).not.toBe(config.issuerUrl);
      expect(parsed.searchParams.get("token")).toBeTruthy();

      // The token extracted from the emitted URL must verify successfully
      // when POSTed to the API — that's the path MagicLinkHandler drives.
      const token = parsed.searchParams.get("token")!;
      const verifyRes = await spyApp.handle(
        new Request("http://localhost/login/magic/verify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token }),
        }),
      );
      expect(verifyRes.status).toBe(200);
    });
  });

  describe("POST /login/passkey/begin", () => {
    it("returns 400 for an unknown identifier", async () => {
      const res = await app.handle(
        new Request("http://localhost/login/passkey/begin", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ identifier: "nobody@example.com" }),
        }),
      );
      expect(res.status).toBe(400);
    });

    it("returns 400 when the user has no registered passkey", async () => {
      const svc = createAuthService(config);
      await Effect.runPromise(
        svc.registerProfile("pk-begin@example.com", "pkbegin").pipe(Effect.provide(layer)),
      );
      const res = await app.handle(
        new Request("http://localhost/login/passkey/begin", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ identifier: "pk-begin@example.com" }),
        }),
      );
      // Service surfaces "No passkey registered" → 400.
      expect(res.status).toBe(400);
    });
  });

  describe("POST /login/passkey/complete", () => {
    it("returns 400 when no login challenge has been issued", async () => {
      // Call /login/passkey/complete without a preceding /login/passkey/begin —
      // the service's in-memory challenge guard rejects before any DB work.
      const res = await app.handle(
        new Request("http://localhost/login/passkey/complete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            identifier: "nobody@example.com",
            assertion: { id: "fake", rawId: "fake", response: {}, type: "public-key" },
          }),
        }),
      );
      expect(res.status).toBe(400);
    });

    it("returns 400 for a malformed assertion", async () => {
      const svc = createAuthService(config);
      await Effect.runPromise(
        svc.registerProfile("pk-complete@example.com", "pkcomplete").pipe(Effect.provide(layer)),
      );
      // Issue a challenge (matches what /login/passkey/begin would do for a
      // user with a registered passkey — we don't have one, but the challenge
      // guard itself is populated by beginPasskeyLogin's precondition failure,
      // so just hit complete with a bogus payload and expect a 400 from the
      // downstream "passkey not found" / verification-failed path).
      const res = await app.handle(
        new Request("http://localhost/login/passkey/complete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            identifier: "pk-complete@example.com",
            assertion: { id: "fake", rawId: "fake", response: {}, type: "public-key" },
          }),
        }),
      );
      expect(res.status).toBe(400);
    });
  });

  // -------------------------------------------------------------------------
  // OIDC discovery
  // -------------------------------------------------------------------------
  describe("GET /.well-known/openid-configuration", () => {
    it("returns OIDC discovery document", async () => {
      const res = await app.handle(
        new Request("http://localhost/.well-known/openid-configuration"),
      );
      expect(res.status).toBe(200);
      const json = (await res.json()) as {
        issuer: string;
        token_endpoint: string;
        grant_types_supported: string[];
      };
      expect(json.issuer).toBe("http://localhost:4000");
      expect(json.token_endpoint).toBe("http://localhost:4000/token");
      expect(json.grant_types_supported).toEqual(["refresh_token"]);
    });
  });

  // -------------------------------------------------------------------------
  // Authorization gating on /passkey/register/*
  // -------------------------------------------------------------------------
  describe("POST /passkey/register/begin (Authorization gating)", () => {
    /**
     * Helper: register a user via the legacy path, then mint an enrollment
     * token directly via the service. Mirrors what completeRegistration does
     * in the new flow.
     */
    async function setupProfileAndEnrollmentToken(): Promise<{
      profileId: string;
      accountId: string;
      enrollmentToken: string;
    }> {
      const svc = createAuthService(config);
      const profile = await Effect.runPromise(
        svc.registerProfile("paul@example.com", "paul").pipe(Effect.provide(layer)),
      );
      // Enrollment token sub = accountId (passkeys belong to accounts)
      const enrollmentToken = await Effect.runPromise(svc.issueEnrollmentToken(profile.accountId));
      return { profileId: profile.id, accountId: profile.accountId, enrollmentToken };
    }

    it("S-C1: rejects with 401 when Authorization header is present but invalid", async () => {
      const { profileId } = await setupProfileAndEnrollmentToken();
      const res = await app.handle(
        new Request("http://localhost/passkey/register/begin", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer not-a-real-token",
          },
          body: JSON.stringify({ profileId }),
        }),
      );
      expect(res.status).toBe(401);
    });

    it("S-C1: rejects with 401 when enrollment token's sub mismatches body.profileId", async () => {
      const { enrollmentToken } = await setupProfileAndEnrollmentToken();
      const res = await app.handle(
        new Request("http://localhost/passkey/register/begin", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${enrollmentToken}`,
          },
          body: JSON.stringify({ profileId: "usr_someoneelse" }),
        }),
      );
      expect(res.status).toBe(401);
    });

    it("accepts a valid enrollment token whose sub matches body.profileId's account", async () => {
      const { profileId, enrollmentToken } = await setupProfileAndEnrollmentToken();
      const res = await app.handle(
        new Request("http://localhost/passkey/register/begin", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${enrollmentToken}`,
          },
          body: JSON.stringify({ profileId }),
        }),
      );
      // 200 OK (WebAuthn options blob) — not 401, not 400.
      expect(res.status).toBe(200);
      const json = (await res.json()) as { challenge?: string };
      expect(json.challenge).toBeTruthy();
    });

    it("accepts a normal access token (existing user adding a passkey)", async () => {
      const svc = createAuthService(config);
      const profile = await Effect.runPromise(
        svc.registerProfile("quinn@example.com", "quinn").pipe(Effect.provide(layer)),
      );
      const tokens = await Effect.runPromise(
        svc
          .issueTokens(
            profile.id,
            profile.accountId,
            profile.email,
            profile.handle,
            profile.displayName,
          )
          .pipe(Effect.provide(layer)),
      );
      const res = await app.handle(
        new Request("http://localhost/passkey/register/begin", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${tokens.accessToken}`,
          },
          body: JSON.stringify({ profileId: profile.id }),
        }),
      );
      expect(res.status).toBe(200);
    });

    it("rejects requests without Authorization header (S-H5: legacy path removed)", async () => {
      const svc = createAuthService(config);
      const profile = await Effect.runPromise(
        svc.registerProfile("rita@example.com", "rita").pipe(Effect.provide(layer)),
      );
      const res = await app.handle(
        new Request("http://localhost/passkey/register/begin", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ profileId: profile.id }),
        }),
      );
      expect(res.status).toBe(401);
    });
  });

  describe("POST /passkey/register/complete (enrollment token consumption)", () => {
    it("rejects when the enrollment token has already been consumed", async () => {
      const svc = createAuthService(config);
      const profile = await Effect.runPromise(
        svc.registerProfile("sam@example.com", "samuser").pipe(Effect.provide(layer)),
      );
      const enrollmentToken = await Effect.runPromise(svc.issueEnrollmentToken(profile.id));

      // First call: consumes the token. The attestation is bogus so the
      // service will fail downstream — but the *consumption* happens in the
      // route guard before that, so this still marks the token used.
      await app.handle(
        new Request("http://localhost/passkey/register/complete", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${enrollmentToken}`,
          },
          body: JSON.stringify({ profileId: profile.id, attestation: { id: "x" } }),
        }),
      );

      // Second call with the same token must be rejected at the auth layer.
      const second = await app.handle(
        new Request("http://localhost/passkey/register/complete", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${enrollmentToken}`,
          },
          body: JSON.stringify({ profileId: profile.id, attestation: { id: "x" } }),
        }),
      );
      expect(second.status).toBe(401);
    });
  });

  // -------------------------------------------------------------------------
  // Rate limiting (S-H1)
  // -------------------------------------------------------------------------
  describe("rate limiting", () => {
    it("returns 429 after exceeding rate limit on /handle/:handle", async () => {
      // The handle check limiter allows 10 req/min. Create a fresh app
      // so the limiter is clean.
      const freshApp = createAuthRoutes(config, layer);
      for (let i = 0; i < 10; i++) {
        // eslint-disable-next-line no-await-in-loop -- sequential dispatch required for rate-limit correctness
        const res = await freshApp.handle(
          new Request(`http://localhost/handle/test${i}`, {
            headers: { "x-forwarded-for": "1.2.3.4" },
          }),
        );
        // May be 200 or 400 depending on user existence — doesn't matter
        expect(res.status).not.toBe(429);
      }
      // 11th request should be rate-limited
      const blocked = await freshApp.handle(
        new Request("http://localhost/handle/test99", {
          headers: { "x-forwarded-for": "1.2.3.4" },
        }),
      );
      expect(blocked.status).toBe(429);
      const json = (await blocked.json()) as { error: string };
      expect(json.error).toBe("rate_limited");
    });

    it("rate limits are per-IP — different IPs are independent", async () => {
      const freshApp = createAuthRoutes(config, layer);
      // Exhaust the limit for IP A
      for (let i = 0; i < 10; i++) {
        // eslint-disable-next-line no-await-in-loop -- sequential dispatch required for rate-limit correctness
        await freshApp.handle(
          new Request(`http://localhost/handle/x${i}`, {
            headers: { "x-forwarded-for": "10.0.0.1" },
          }),
        );
      }
      // IP A is blocked
      const blockedA = await freshApp.handle(
        new Request("http://localhost/handle/y", {
          headers: { "x-forwarded-for": "10.0.0.1" },
        }),
      );
      expect(blockedA.status).toBe(429);

      // IP B is not blocked
      const allowedB = await freshApp.handle(
        new Request("http://localhost/handle/y", {
          headers: { "x-forwarded-for": "10.0.0.2" },
        }),
      );
      expect(allowedB.status).not.toBe(429);
    });

    it("returns 429 on /register/begin when rate-limited", async () => {
      const freshApp = createAuthRoutes(config, layer);
      // register/begin allows 5 req/min
      for (let i = 0; i < 5; i++) {
        // eslint-disable-next-line no-await-in-loop -- sequential dispatch required for rate-limit correctness
        await freshApp.handle(
          new Request("http://localhost/register/begin", {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-forwarded-for": "5.5.5.5" },
            body: JSON.stringify({ email: `u${i}@example.com`, handle: `u${i}` }),
          }),
        );
      }
      const blocked = await freshApp.handle(
        new Request("http://localhost/register/begin", {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-forwarded-for": "5.5.5.5" },
          body: JSON.stringify({ email: "extra@example.com", handle: "extra" }),
        }),
      );
      expect(blocked.status).toBe(429);
    });

    it("returns 429 on /login/otp/begin when rate-limited", async () => {
      const freshApp = createAuthRoutes(config, layer);
      // otp/begin allows 5 req/min — shared with /login/otp/begin
      for (let i = 0; i < 5; i++) {
        // eslint-disable-next-line no-await-in-loop -- sequential dispatch required for rate-limit correctness
        await freshApp.handle(
          new Request("http://localhost/login/otp/begin", {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-forwarded-for": "6.6.6.6" },
            body: JSON.stringify({ identifier: `u${i}@example.com` }),
          }),
        );
      }
      const blocked = await freshApp.handle(
        new Request("http://localhost/login/otp/begin", {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-forwarded-for": "6.6.6.6" },
          body: JSON.stringify({ identifier: "extra@example.com" }),
        }),
      );
      expect(blocked.status).toBe(429);
      const json = (await blocked.json()) as { error: string };
      expect(json.error).toBe("rate_limited");
    });

    it("returns 429 on /login/magic/begin when rate-limited", async () => {
      const freshApp = createAuthRoutes(config, layer);
      for (let i = 0; i < 5; i++) {
        // eslint-disable-next-line no-await-in-loop -- sequential dispatch required for rate-limit correctness
        await freshApp.handle(
          new Request("http://localhost/login/magic/begin", {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-forwarded-for": "7.7.7.7" },
            body: JSON.stringify({ identifier: `u${i}@example.com` }),
          }),
        );
      }
      const blocked = await freshApp.handle(
        new Request("http://localhost/login/magic/begin", {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-forwarded-for": "7.7.7.7" },
          body: JSON.stringify({ identifier: "extra@example.com" }),
        }),
      );
      expect(blocked.status).toBe(429);
    });
  });

  // -------------------------------------------------------------------------
  // Rate limiter dependency injection (Phase 1 of Redis migration)
  //
  // Verifies the `RateLimiterBackend` abstraction: createAuthRoutes accepts
  // an injected rate limiter bundle, sync and async backends both work, and
  // the endpoint-to-limiter wiring inside the route factory is stable. This
  // is the contract Phase 2 (Redis) relies on.
  // -------------------------------------------------------------------------
  describe("rate limiter dependency injection", () => {
    it("uses the injected rate limiter bundle instead of the default", async () => {
      // An "always reject" limiter — every check returns false.
      const rejectAll: RateLimiterBackend = { check: () => false };
      const limiters = { ...createDefaultAuthRateLimiters(), handleCheck: rejectAll };

      const freshApp = createAuthRoutes(config, layer, Layer.empty, limiters);
      const res = await freshApp.handle(
        new Request("http://localhost/handle/alice", {
          headers: { "x-forwarded-for": "9.9.9.9" },
        }),
      );
      expect(res.status).toBe(429);
      const json = (await res.json()) as { error: string };
      expect(json.error).toBe("rate_limited");
    });

    it("supports async rate limiter backends (Promise<boolean>)", async () => {
      // Simulates the future Redis backend's async check().
      const asyncBackend: RateLimiterBackend = {
        check: () => Promise.resolve(false),
      };
      const limiters = { ...createDefaultAuthRateLimiters(), registerBegin: asyncBackend };

      const freshApp = createAuthRoutes(config, layer, Layer.empty, limiters);
      const res = await freshApp.handle(
        new Request("http://localhost/register/begin", {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-forwarded-for": "8.8.8.8" },
          body: JSON.stringify({ email: "async@example.com", handle: "async" }),
        }),
      );
      expect(res.status).toBe(429);
    });

    it("fails closed when the backend rejects (S-M1)", async () => {
      // Simulates a Redis outage where check() throws.
      const failing: RateLimiterBackend = {
        check: () => Promise.reject(new Error("Redis connection refused")),
      };
      const limiters = { ...createDefaultAuthRateLimiters(), handleCheck: failing };

      const freshApp = createAuthRoutes(config, layer, Layer.empty, limiters);
      const res = await freshApp.handle(
        new Request("http://localhost/handle/alice", {
          headers: { "x-forwarded-for": "4.4.4.4" },
        }),
      );
      // Must return 429 (fail-closed), not 500 (unhandled rejection).
      expect(res.status).toBe(429);
    });

    it("passes when the injected limiter returns true", async () => {
      const allowAll: RateLimiterBackend = { check: () => true };
      const limiters = { ...createDefaultAuthRateLimiters(), handleCheck: allowAll };

      const freshApp = createAuthRoutes(config, layer, Layer.empty, limiters);
      // Fire a burst that would exceed the default 10/min cap; everything
      // should pass because the injected limiter always says yes.
      for (let i = 0; i < 20; i++) {
        // eslint-disable-next-line no-await-in-loop -- sequential dispatch required for rate-limit correctness
        const res = await freshApp.handle(
          new Request(`http://localhost/handle/user${i}`, {
            headers: { "x-forwarded-for": "7.7.7.7" },
          }),
        );
        expect(res.status).not.toBe(429);
      }
    });
  });

  // -------------------------------------------------------------------------
  // Profile switching (P2)
  // -------------------------------------------------------------------------

  describe("GET /profiles/list", () => {
    async function getAccessToken(): Promise<{ accessToken: string; profileId: string }> {
      let captured: string | undefined;
      const verifiedConfig = {
        ...config,
        sendEmail: async (_to: string, _subject: string, body: string) => {
          const m = body.match(/code is: (\d{6})/);
          if (m) captured = m[1];
        },
      };
      const verifiedApp = createAuthRoutes(verifiedConfig, layer);
      await verifiedApp.handle(
        new Request("http://localhost/register/begin", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            email: "profiles@example.com",
            handle: "profilelist",
            displayName: "Profile List",
          }),
        }),
      );
      const completeRes = await verifiedApp.handle(
        new Request("http://localhost/register/complete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: "profiles@example.com", code: captured }),
        }),
      );
      const json = (await completeRes.json()) as {
        profileId: string;
        session: { access_token: string };
      };
      return { accessToken: json.session.access_token, profileId: json.profileId };
    }

    it("returns the list of profiles for a valid access token", async () => {
      const { accessToken } = await getAccessToken();
      const res = await app.handle(
        new Request("http://localhost/profiles/list", {
          headers: { Authorization: `Bearer ${accessToken}` },
        }),
      );
      expect(res.status).toBe(200);
      const json = (await res.json()) as { profiles: { id: string; handle: string }[] };
      expect(json.profiles).toHaveLength(1);
      expect(json.profiles[0]!.handle).toBe("profilelist");
    });

    it("returns error with an invalid token", async () => {
      const res = await app.handle(
        new Request("http://localhost/profiles/list", {
          headers: { Authorization: "Bearer not.a.valid.token" },
        }),
      );
      expect(res.status).toBeGreaterThanOrEqual(400);
    });

    it("rate limits profile list requests", async () => {
      const denyAll: RateLimiterBackend = { check: () => false };
      const limiters = { ...createDefaultAuthRateLimiters(), profileList: denyAll };
      const freshApp = createAuthRoutes(config, layer, Layer.empty, limiters);
      const res = await freshApp.handle(
        new Request("http://localhost/profiles/list", {
          headers: {
            "x-forwarded-for": "10.10.10.10",
          },
        }),
      );
      expect(res.status).toBe(429);
    });
  });

  describe("POST /profiles/switch", () => {
    async function registerAndGetTokens(): Promise<{
      accessToken: string;
      profileId: string;
    }> {
      let captured: string | undefined;
      const verifiedConfig = {
        ...config,
        sendEmail: async (_to: string, _subject: string, body: string) => {
          const m = body.match(/code is: (\d{6})/);
          if (m) captured = m[1];
        },
      };
      const verifiedApp = createAuthRoutes(verifiedConfig, layer);
      await verifiedApp.handle(
        new Request("http://localhost/register/begin", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            email: "switch@example.com",
            handle: "switchrt",
            displayName: "Switch Test",
          }),
        }),
      );
      const completeRes = await verifiedApp.handle(
        new Request("http://localhost/register/complete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: "switch@example.com", code: captured }),
        }),
      );
      const json = (await completeRes.json()) as {
        profileId: string;
        session: { access_token: string };
      };
      return { accessToken: json.session.access_token, profileId: json.profileId };
    }

    it("switches to an owned profile and returns a new access token", async () => {
      const { accessToken, profileId } = await registerAndGetTokens();
      const res = await app.handle(
        new Request("http://localhost/profiles/switch", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
          body: JSON.stringify({
            profile_id: profileId,
          }),
        }),
      );
      expect(res.status).toBe(200);
      const json = (await res.json()) as {
        access_token: string;
        expires_in: number;
        profile: { id: string; handle: string };
      };
      expect(json.access_token).toBeTruthy();
      expect(json.expires_in).toBe(300);
      expect(json.profile.handle).toBe("switchrt");
    });

    it("returns error for non-existent profile", async () => {
      const { accessToken } = await registerAndGetTokens();
      const res = await app.handle(
        new Request("http://localhost/profiles/switch", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
          body: JSON.stringify({
            profile_id: "usr_aabbccddeeff",
          }),
        }),
      );
      expect(res.status).toBeGreaterThanOrEqual(400);
    });

    it("returns error for invalid access token", async () => {
      const res = await app.handle(
        new Request("http://localhost/profiles/switch", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer not.a.token" },
          body: JSON.stringify({
            profile_id: "usr_aabbccddeeff",
          }),
        }),
      );
      expect(res.status).toBeGreaterThanOrEqual(400);
    });

    it("rate limits profile switch requests", async () => {
      const denyAll: RateLimiterBackend = { check: () => false };
      const limiters = { ...createDefaultAuthRateLimiters(), profileSwitch: denyAll };
      const freshApp = createAuthRoutes(config, layer, Layer.empty, limiters);
      const res = await freshApp.handle(
        new Request("http://localhost/profiles/switch", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-forwarded-for": "10.10.10.10",
            Authorization: "Bearer any",
          },
          body: JSON.stringify({
            profile_id: "usr_aabbccddeeff",
          }),
        }),
      );
      expect(res.status).toBe(429);
    });
  });

  describe("recovery codes (Copenhagen Book M2)", () => {
    async function registerForRecovery(): Promise<{
      accessToken: string;
      email: string;
      identifier: string;
      stepUpToken: string;
    }> {
      // Buffer every captured code so we can distinguish register-OTP from
      // the subsequent step-up OTP emailed after we've already logged in.
      const captured: string[] = [];
      const verifiedConfig = {
        ...config,
        sendEmail: async (_to: string, _subject: string, body: string) => {
          const m = body.match(/(?:code is|OSN step-up code is): (\d{6})/);
          if (m) captured.push(m[1]!);
        },
      };
      const verifiedApp = createAuthRoutes(verifiedConfig, layer);
      await verifiedApp.handle(
        new Request("http://localhost/register/begin", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            email: "recovery-user@example.com",
            handle: "recoveryuser",
            displayName: "Recovery User",
          }),
        }),
      );
      const completeRes = await verifiedApp.handle(
        new Request("http://localhost/register/complete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: "recovery-user@example.com", code: captured[0]! }),
        }),
      );
      const json = (await completeRes.json()) as {
        session: { access_token: string };
      };
      const accessToken = json.session.access_token;

      // M-PK1: /recovery/generate requires a step-up token. Drive the OTP
      // ceremony now so the caller can attach `step_up_token` to its body.
      await verifiedApp.handle(
        new Request("http://localhost/step-up/otp/begin", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${accessToken}`,
          },
        }),
      );
      const stepUpCode = captured[captured.length - 1]!;
      const stepUpRes = await verifiedApp.handle(
        new Request("http://localhost/step-up/otp/complete", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${accessToken}`,
          },
          body: JSON.stringify({ code: stepUpCode }),
        }),
      );
      const stepUpJson = (await stepUpRes.json()) as { step_up_token: string };

      return {
        accessToken,
        email: "recovery-user@example.com",
        identifier: "recoveryuser",
        stepUpToken: stepUpJson.step_up_token,
      };
    }

    it("POST /recovery/generate returns 10 codes with the expected shape", async () => {
      const { accessToken, stepUpToken } = await registerForRecovery();
      const res = await app.handle(
        new Request("http://localhost/recovery/generate", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${accessToken}`,
          },
          body: JSON.stringify({ step_up_token: stepUpToken }),
        }),
      );
      expect(res.status).toBe(200);
      const json = (await res.json()) as { recoveryCodes: string[] };
      expect(json.recoveryCodes).toHaveLength(10);
      for (const c of json.recoveryCodes) {
        expect(c).toMatch(/^[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}$/);
      }
    });

    it("POST /recovery/generate without an access token returns 401", async () => {
      const res = await app.handle(
        new Request("http://localhost/recovery/generate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        }),
      );
      expect(res.status).toBe(401);
    });

    // M-PK1 gate: authenticated access token alone is no longer enough; a
    // fresh step-up ceremony must have been completed.
    it("POST /recovery/generate without a step-up token returns 403", async () => {
      const { accessToken } = await registerForRecovery();
      const res = await app.handle(
        new Request("http://localhost/recovery/generate", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${accessToken}`,
          },
          body: "{}",
        }),
      );
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: string }).error).toBe("step_up_required");
    });

    it("POST /login/recovery/complete returns a session cookie on success", async () => {
      const { accessToken, email, stepUpToken } = await registerForRecovery();
      const genRes = await app.handle(
        new Request("http://localhost/recovery/generate", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${accessToken}`,
          },
          body: JSON.stringify({ step_up_token: stepUpToken }),
        }),
      );
      const { recoveryCodes: codes } = (await genRes.json()) as { recoveryCodes: string[] };

      const loginRes = await app.handle(
        new Request("http://localhost/login/recovery/complete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ identifier: email, code: codes[0] }),
        }),
      );
      expect(loginRes.status).toBe(200);
      const loginJson = (await loginRes.json()) as {
        session: { access_token: string };
        profile: { handle: string };
      };
      expect(loginJson.session.access_token).toBeTruthy();
      expect(loginJson.profile.handle).toBe("recoveryuser");
      expect(loginRes.headers.get("set-cookie")).toContain("osn_session=");
    });

    it("POST /login/recovery/complete rejects a reused code", async () => {
      const { accessToken, email, stepUpToken } = await registerForRecovery();
      const genRes = await app.handle(
        new Request("http://localhost/recovery/generate", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${accessToken}`,
          },
          body: JSON.stringify({ step_up_token: stepUpToken }),
        }),
      );
      const { recoveryCodes: codes } = (await genRes.json()) as { recoveryCodes: string[] };

      await app.handle(
        new Request("http://localhost/login/recovery/complete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ identifier: email, code: codes[0] }),
        }),
      );
      const replay = await app.handle(
        new Request("http://localhost/login/recovery/complete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ identifier: email, code: codes[0] }),
        }),
      );
      expect(replay.status).toBe(400);
    });

    it("rate limits recovery generate requests", async () => {
      const denyAll: RateLimiterBackend = { check: () => false };
      const limiters = { ...createDefaultAuthRateLimiters(), recoveryGenerate: denyAll };
      const freshApp = createAuthRoutes(config, layer, Layer.empty, limiters);
      const res = await freshApp.handle(
        new Request("http://localhost/recovery/generate", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-forwarded-for": "10.10.10.10",
            Authorization: "Bearer any",
          },
          body: "{}",
        }),
      );
      expect(res.status).toBe(429);
    });

    it("rate limits recovery login requests", async () => {
      const denyAll: RateLimiterBackend = { check: () => false };
      const limiters = { ...createDefaultAuthRateLimiters(), recoveryComplete: denyAll };
      const freshApp = createAuthRoutes(config, layer, Layer.empty, limiters);
      const res = await freshApp.handle(
        new Request("http://localhost/login/recovery/complete", {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-forwarded-for": "10.10.10.10" },
          body: JSON.stringify({ identifier: "x@y.com", code: "aaaa-bbbb-cccc-dddd" }),
        }),
      );
      expect(res.status).toBe(429);
    });
  });

  // ---------------------------------------------------------------------------
  // Step-up (sudo) ceremonies — T-R1
  //
  // Service-layer behaviour is exercised in services/step-up.test.ts; these
  // tests pin the HTTP wire contract: Bearer-auth gate, rate-limiter wiring,
  // response shape (snake_case `step_up_token` + `expires_in`), and the
  // begin-needs-passkeys failure mode.
  // ---------------------------------------------------------------------------
  describe("step-up routes", () => {
    /** Drive the full register+verify flow and return an access token. */
    async function registerAndGetAccessToken(
      freshApp: ReturnType<typeof createAuthRoutes>,
      captured: { code?: string },
      email: string,
      handle: string,
    ): Promise<string> {
      await freshApp.handle(
        new Request("http://localhost/register/begin", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, handle }),
        }),
      );
      const completeRes = await freshApp.handle(
        new Request("http://localhost/register/complete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, code: captured.code }),
        }),
      );
      const json = (await completeRes.json()) as {
        session: { access_token: string };
      };
      return json.session.access_token;
    }

    function appWithCapturingEmail(): {
      app: ReturnType<typeof createAuthRoutes>;
      captured: { code?: string; all: string[] };
    } {
      const captured: { code?: string; all: string[] } = { all: [] };
      const verifiedConfig = {
        ...config,
        sendEmail: async (_to: string, _subject: string, body: string) => {
          // Matches register-OTP ("code is: NNNNNN"), step-up-OTP
          // ("step-up code is: NNNNNN"), and email-change-OTP ("code is:") —
          // the single shared regex lets tests grab whichever code was last sent.
          const m = body.match(/(?:step-up code is|code is): (\d{6})/);
          if (m) {
            captured.code = m[1];
            captured.all.push(m[1]!);
          }
        },
      };
      return { app: createAuthRoutes(verifiedConfig, layer), captured };
    }

    it("POST /step-up/otp/begin returns 401 without Bearer auth", async () => {
      const res = await app.handle(
        new Request("http://localhost/step-up/otp/begin", { method: "POST" }),
      );
      expect(res.status).toBe(401);
    });

    it("POST /step-up/otp/{begin,complete} mints a token the recovery gate accepts", async () => {
      const { app: freshApp, captured } = appWithCapturingEmail();
      const accessToken = await registerAndGetAccessToken(
        freshApp,
        captured,
        "su-route@example.com",
        "suroute",
      );

      const beginRes = await freshApp.handle(
        new Request("http://localhost/step-up/otp/begin", {
          method: "POST",
          headers: { Authorization: `Bearer ${accessToken}` },
        }),
      );
      expect(beginRes.status).toBe(200);
      expect(captured.code).toMatch(/^\d{6}$/);

      const completeRes = await freshApp.handle(
        new Request("http://localhost/step-up/otp/complete", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${accessToken}`,
          },
          body: JSON.stringify({ code: captured.code }),
        }),
      );
      expect(completeRes.status).toBe(200);
      const json = (await completeRes.json()) as { step_up_token: string; expires_in: number };
      expect(json.step_up_token).toMatch(/^eyJ/);
      expect(json.expires_in).toBe(300);

      // The minted token now satisfies the /recovery/generate gate.
      const recoveryRes = await freshApp.handle(
        new Request("http://localhost/recovery/generate", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${accessToken}`,
          },
          body: JSON.stringify({ step_up_token: json.step_up_token }),
        }),
      );
      expect(recoveryRes.status).toBe(200);
    });

    it("POST /step-up/passkey/begin rejects accounts without passkeys", async () => {
      const { app: freshApp, captured } = appWithCapturingEmail();
      const accessToken = await registerAndGetAccessToken(
        freshApp,
        captured,
        "su-pkbegin@example.com",
        "supkbegin",
      );
      const res = await freshApp.handle(
        new Request("http://localhost/step-up/passkey/begin", {
          method: "POST",
          headers: { Authorization: `Bearer ${accessToken}` },
        }),
      );
      // Service surfaces "No passkeys registered" → 400 via publicError mapping.
      expect([400, 404]).toContain(res.status);
    });

    it("rate limits step-up OTP begin requests", async () => {
      const denyAll: RateLimiterBackend = { check: () => false };
      const limiters = { ...createDefaultAuthRateLimiters(), stepUpOtpBegin: denyAll };
      const freshApp = createAuthRoutes(config, layer, Layer.empty, limiters);
      const res = await freshApp.handle(
        new Request("http://localhost/step-up/otp/begin", {
          method: "POST",
          headers: {
            "x-forwarded-for": "10.10.10.10",
            Authorization: "Bearer any",
          },
        }),
      );
      expect(res.status).toBe(429);
    });
  });

  // ---------------------------------------------------------------------------
  // Session introspection + revocation — T-R2
  // ---------------------------------------------------------------------------
  describe("session routes", () => {
    async function setup(): Promise<{
      app: ReturnType<typeof createAuthRoutes>;
      accessToken: string;
      cookieHeader: string;
    }> {
      const captured: { code?: string } = {};
      const verifiedConfig = {
        ...config,
        sendEmail: async (_to: string, _subject: string, body: string) => {
          const m = body.match(/code is: (\d{6})/);
          if (m) captured.code = m[1];
        },
      };
      const freshApp = createAuthRoutes(verifiedConfig, layer);
      await freshApp.handle(
        new Request("http://localhost/register/begin", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: "sess-route@example.com", handle: "sessroute" }),
        }),
      );
      const completeRes = await freshApp.handle(
        new Request("http://localhost/register/complete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: "sess-route@example.com", code: captured.code }),
        }),
      );
      const json = (await completeRes.json()) as {
        session: { access_token: string };
      };
      // Extract the session cookie so follow-up requests can identify
      // themselves as the "current" device.
      const setCookie = completeRes.headers.get("set-cookie") ?? "";
      const cookieName = setCookie.split("=")[0]!;
      const cookieValue = setCookie.split("=")[1]!.split(";")[0]!;
      return {
        app: freshApp,
        accessToken: json.session.access_token,
        cookieHeader: `${cookieName}=${cookieValue}`,
      };
    }

    it("GET /sessions requires Bearer auth", async () => {
      const res = await app.handle(new Request("http://localhost/sessions"));
      expect(res.status).toBe(401);
    });

    it("GET /sessions lists the caller's sessions and flags isCurrent via cookie", async () => {
      const { app: freshApp, accessToken, cookieHeader } = await setup();
      const res = await freshApp.handle(
        new Request("http://localhost/sessions", {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            Cookie: cookieHeader,
          },
        }),
      );
      expect(res.status).toBe(200);
      const json = (await res.json()) as {
        sessions: Array<{ id: string; isCurrent: boolean }>;
      };
      expect(json.sessions).toHaveLength(1);
      expect(json.sessions[0]!.isCurrent).toBe(true);
      expect(json.sessions[0]!.id).toMatch(/^[0-9a-f]{16}$/);
    });

    it("DELETE /sessions/:id clears the cookie when the caller revokes their own session", async () => {
      const { app: freshApp, accessToken, cookieHeader } = await setup();
      const listRes = await freshApp.handle(
        new Request("http://localhost/sessions", {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            Cookie: cookieHeader,
          },
        }),
      );
      const list = (await listRes.json()) as { sessions: Array<{ id: string }> };
      const own = list.sessions[0]!.id;

      const delRes = await freshApp.handle(
        new Request(`http://localhost/sessions/${own}`, {
          method: "DELETE",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            Cookie: cookieHeader,
          },
        }),
      );
      expect(delRes.status).toBe(200);
      expect(delRes.headers.get("set-cookie") ?? "").toMatch(/Max-Age=0/);
      const body = (await delRes.json()) as { revokedSelf: boolean };
      expect(body.revokedSelf).toBe(true);
    });

    it("DELETE /sessions/:id rejects malformed handles via path regex", async () => {
      const { app: freshApp, accessToken } = await setup();
      const res = await freshApp.handle(
        new Request("http://localhost/sessions/not-a-hex-handle", {
          method: "DELETE",
          headers: { Authorization: `Bearer ${accessToken}` },
        }),
      );
      // Elysia returns 422 when the param fails its schema. Either that or
      // a 400/404 is acceptable — the point is the route doesn't mistake
      // a garbage handle for a valid target.
      expect([400, 404, 422]).toContain(res.status);
    });

    it("POST /sessions/revoke-all-other returns 400 without a session cookie", async () => {
      const { app: freshApp, accessToken } = await setup();
      const res = await freshApp.handle(
        new Request("http://localhost/sessions/revoke-all-other", {
          method: "POST",
          headers: { Authorization: `Bearer ${accessToken}` },
        }),
      );
      expect(res.status).toBe(400);
    });

    it("POST /sessions/revoke-all-other succeeds when the cookie is present", async () => {
      const { app: freshApp, accessToken, cookieHeader } = await setup();
      const res = await freshApp.handle(
        new Request("http://localhost/sessions/revoke-all-other", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            Cookie: cookieHeader,
          },
        }),
      );
      expect(res.status).toBe(200);
    });
  });

  // ---------------------------------------------------------------------------
  // Email change — T-R3
  // ---------------------------------------------------------------------------
  describe("email change routes", () => {
    async function setupWithStepUp(): Promise<{
      app: ReturnType<typeof createAuthRoutes>;
      accessToken: string;
      captured: { last?: string };
    }> {
      const captured: { last?: string } = {};
      const verifiedConfig = {
        ...config,
        sendEmail: async (_to: string, _subject: string, body: string) => {
          const m = body.match(/(?:step-up code is|code is): (\d{6})/);
          if (m) captured.last = m[1];
        },
      };
      const freshApp = createAuthRoutes(verifiedConfig, layer);
      await freshApp.handle(
        new Request("http://localhost/register/begin", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: "ec-route@example.com", handle: "ecroute" }),
        }),
      );
      const completeRes = await freshApp.handle(
        new Request("http://localhost/register/complete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: "ec-route@example.com", code: captured.last }),
        }),
      );
      const json = (await completeRes.json()) as {
        session: { access_token: string };
      };
      return { app: freshApp, accessToken: json.session.access_token, captured };
    }

    async function mintStepUpToken(
      freshApp: ReturnType<typeof createAuthRoutes>,
      accessToken: string,
      captured: { last?: string },
    ): Promise<string> {
      await freshApp.handle(
        new Request("http://localhost/step-up/otp/begin", {
          method: "POST",
          headers: { Authorization: `Bearer ${accessToken}` },
        }),
      );
      const completeRes = await freshApp.handle(
        new Request("http://localhost/step-up/otp/complete", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${accessToken}`,
          },
          body: JSON.stringify({ code: captured.last }),
        }),
      );
      const json = (await completeRes.json()) as { step_up_token: string };
      return json.step_up_token;
    }

    it("POST /account/email/begin requires Bearer auth", async () => {
      const res = await app.handle(
        new Request("http://localhost/account/email/begin", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ new_email: "x@example.com" }),
        }),
      );
      expect(res.status).toBe(401);
    });

    it("end-to-end: begin → mint step-up → complete swaps the email", async () => {
      const { app: freshApp, accessToken, captured } = await setupWithStepUp();

      // 1. Begin — sends OTP to the new address.
      const beginRes = await freshApp.handle(
        new Request("http://localhost/account/email/begin", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${accessToken}`,
          },
          body: JSON.stringify({ new_email: "ec-route-next@example.com" }),
        }),
      );
      expect(beginRes.status).toBe(200);
      const beginOtp = captured.last!;

      // 2. Mint a step-up token for the complete step.
      const stepUpToken = await mintStepUpToken(freshApp, accessToken, captured);

      // 3. Complete — atomic swap.
      const completeRes = await freshApp.handle(
        new Request("http://localhost/account/email/complete", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${accessToken}`,
          },
          body: JSON.stringify({ code: beginOtp, step_up_token: stepUpToken }),
        }),
      );
      expect(completeRes.status).toBe(200);
      const json = (await completeRes.json()) as { email: string };
      expect(json.email).toBe("ec-route-next@example.com");
    });

    it("POST /account/email/complete fails without a step-up token", async () => {
      const { app: freshApp, accessToken, captured } = await setupWithStepUp();
      await freshApp.handle(
        new Request("http://localhost/account/email/begin", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${accessToken}`,
          },
          body: JSON.stringify({ new_email: "ec-nostepup@example.com" }),
        }),
      );
      const otp = captured.last!;
      const res = await freshApp.handle(
        new Request("http://localhost/account/email/complete", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${accessToken}`,
          },
          body: JSON.stringify({ code: otp, step_up_token: "not.a.jwt" }),
        }),
      );
      expect([400, 401, 403]).toContain(res.status);
    });

    it("rate limits /account/email/begin aggressively (3/hr)", async () => {
      const denyAll: RateLimiterBackend = { check: () => false };
      const limiters = { ...createDefaultAuthRateLimiters(), emailChangeBegin: denyAll };
      const freshApp = createAuthRoutes(config, layer, Layer.empty, limiters);
      const res = await freshApp.handle(
        new Request("http://localhost/account/email/begin", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-forwarded-for": "10.10.10.10",
            Authorization: "Bearer any",
          },
          body: JSON.stringify({ new_email: "x@example.com" }),
        }),
      );
      expect(res.status).toBe(429);
    });
  });

  // ---------------------------------------------------------------------------
  // Security events (M-PK1b)
  // ---------------------------------------------------------------------------
  describe("security events routes", () => {
    // Step-up `jti`s are single-use, so each ack call needs its own token.
    async function mintStepUp(
      freshApp: ReturnType<typeof createAuthRoutes>,
      accessToken: string,
      captured: string[],
    ): Promise<string> {
      await freshApp.handle(
        new Request("http://localhost/step-up/otp/begin", {
          method: "POST",
          headers: { Authorization: `Bearer ${accessToken}` },
        }),
      );
      const stepUpRes = await freshApp.handle(
        new Request("http://localhost/step-up/otp/complete", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${accessToken}`,
          },
          body: JSON.stringify({ code: captured[captured.length - 1] }),
        }),
      );
      const { step_up_token: stepUpToken } = (await stepUpRes.json()) as {
        step_up_token: string;
      };
      return stepUpToken;
    }

    async function setupWithRecovery(): Promise<{
      app: ReturnType<typeof createAuthRoutes>;
      accessToken: string;
      captured: string[];
      generatedEventId: string;
    }> {
      // Drive the full register → step-up → /recovery/generate ceremony so
      // there's exactly one unacked recovery_code_generate event on the
      // account by the time we hit GET /account/security-events.
      const captured: string[] = [];
      const verifiedConfig = {
        ...config,
        sendEmail: async (_to: string, _subject: string, body: string) => {
          const m = body.match(/(?:step-up code is|code is): (\d{6})/);
          if (m) captured.push(m[1]!);
        },
      };
      const freshApp = createAuthRoutes(verifiedConfig, layer);

      await freshApp.handle(
        new Request("http://localhost/register/begin", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: "sev-route@example.com", handle: "sevroute" }),
        }),
      );
      const completeRes = await freshApp.handle(
        new Request("http://localhost/register/complete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: "sev-route@example.com", code: captured[0] }),
        }),
      );
      const {
        session: { access_token: accessToken },
      } = (await completeRes.json()) as { session: { access_token: string } };

      const stepUpToken = await mintStepUp(freshApp, accessToken, captured);

      // Generate recovery codes — this records the security_events row.
      await freshApp.handle(
        new Request("http://localhost/recovery/generate", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${accessToken}`,
          },
          body: JSON.stringify({ step_up_token: stepUpToken }),
        }),
      );

      // Fetch to capture the event id.
      const listRes = await freshApp.handle(
        new Request("http://localhost/account/security-events", {
          headers: { Authorization: `Bearer ${accessToken}` },
        }),
      );
      const { events } = (await listRes.json()) as {
        events: Array<{ id: string; kind: string }>;
      };
      return { app: freshApp, accessToken, captured, generatedEventId: events[0]!.id };
    }

    it("GET /account/security-events requires Bearer auth", async () => {
      const res = await app.handle(new Request("http://localhost/account/security-events"));
      expect(res.status).toBe(401);
    });

    it("GET /account/security-events surfaces the recovery_code_generate event end-to-end", async () => {
      const { app: freshApp, accessToken } = await setupWithRecovery();
      const res = await freshApp.handle(
        new Request("http://localhost/account/security-events", {
          headers: { Authorization: `Bearer ${accessToken}` },
        }),
      );
      expect(res.status).toBe(200);
      const json = (await res.json()) as {
        events: Array<{
          id: string;
          kind: string;
          createdAt: number;
          uaLabel: string | null;
          ipHash: string | null;
        }>;
      };
      expect(json.events).toHaveLength(1);
      expect(json.events[0]!.kind).toBe("recovery_code_generate");
      expect(json.events[0]!.id).toMatch(/^sev_[a-f0-9]{12}$/);
    });

    // S-M1: an access-token-only ack would let an XSS silently dismiss the
    // very banner that warns about its own compromise.
    it("POST /account/security-events/:id/ack without a step-up token returns 403", async () => {
      const { app: freshApp, accessToken, generatedEventId } = await setupWithRecovery();
      const ackRes = await freshApp.handle(
        new Request(`http://localhost/account/security-events/${generatedEventId}/ack`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${accessToken}`,
          },
          body: "{}",
        }),
      );
      expect(ackRes.status).toBe(403);
      expect(((await ackRes.json()) as { error: string }).error).toBe("step_up_required");
    });

    it("POST /account/security-events/:id/ack with a valid step-up token hides the event from subsequent lists", async () => {
      const { app: freshApp, accessToken, captured, generatedEventId } = await setupWithRecovery();
      const stepUpToken = await mintStepUp(freshApp, accessToken, captured);
      const ackRes = await freshApp.handle(
        new Request(`http://localhost/account/security-events/${generatedEventId}/ack`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${accessToken}`,
          },
          body: JSON.stringify({ step_up_token: stepUpToken }),
        }),
      );
      expect(ackRes.status).toBe(200);
      expect((await ackRes.json()) as { acknowledged: boolean }).toEqual({ acknowledged: true });

      // List again — should be empty.
      const listAfter = await freshApp.handle(
        new Request("http://localhost/account/security-events", {
          headers: { Authorization: `Bearer ${accessToken}` },
        }),
      );
      const json = (await listAfter.json()) as { events: unknown[] };
      expect(json.events).toHaveLength(0);
    });

    it("POST /account/security-events/:id/ack rejects malformed ids via path regex", async () => {
      const { app: freshApp, accessToken, captured } = await setupWithRecovery();
      const stepUpToken = await mintStepUp(freshApp, accessToken, captured);
      const res = await freshApp.handle(
        new Request("http://localhost/account/security-events/not-a-valid-id/ack", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${accessToken}`,
          },
          body: JSON.stringify({ step_up_token: stepUpToken }),
        }),
      );
      // Elysia returns 422 when the param fails its schema — other status
      // codes would indicate the service silently accepted a garbage id.
      expect([400, 404, 422]).toContain(res.status);
    });

    it("POST /account/security-events/:id/ack for a nonexistent id returns 200 with acknowledged:false", async () => {
      const { app: freshApp, accessToken, captured } = await setupWithRecovery();
      const stepUpToken = await mintStepUp(freshApp, accessToken, captured);
      const res = await freshApp.handle(
        new Request("http://localhost/account/security-events/sev_000000000000/ack", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${accessToken}`,
          },
          body: JSON.stringify({ step_up_token: stepUpToken }),
        }),
      );
      expect(res.status).toBe(200);
      expect((await res.json()) as { acknowledged: boolean }).toEqual({ acknowledged: false });
    });

    it("POST /account/security-events/ack-all dismisses every unacked event in one call", async () => {
      const { app: freshApp, accessToken, captured } = await setupWithRecovery();
      // Generate two more events so there are 3 unacked rows.
      for (const _ of [1, 2]) {
        const freshStepUp = await mintStepUp(freshApp, accessToken, captured);
        await freshApp.handle(
          new Request("http://localhost/recovery/generate", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${accessToken}`,
            },
            body: JSON.stringify({ step_up_token: freshStepUp }),
          }),
        );
      }

      const stepUpToken = await mintStepUp(freshApp, accessToken, captured);
      const ackAllRes = await freshApp.handle(
        new Request("http://localhost/account/security-events/ack-all", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${accessToken}`,
          },
          body: JSON.stringify({ step_up_token: stepUpToken }),
        }),
      );
      expect(ackAllRes.status).toBe(200);
      expect((await ackAllRes.json()) as { acknowledged: number }).toEqual({ acknowledged: 3 });

      const listAfter = await freshApp.handle(
        new Request("http://localhost/account/security-events", {
          headers: { Authorization: `Bearer ${accessToken}` },
        }),
      );
      expect(((await listAfter.json()) as { events: unknown[] }).events).toHaveLength(0);
    });

    it("POST /account/security-events/ack-all without a step-up token returns 403", async () => {
      const { app: freshApp, accessToken } = await setupWithRecovery();
      const res = await freshApp.handle(
        new Request("http://localhost/account/security-events/ack-all", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${accessToken}`,
          },
          body: "{}",
        }),
      );
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: string }).error).toBe("step_up_required");
    });

    it("rate limits /account/security-events when the backend says no", async () => {
      const denyAll: RateLimiterBackend = { check: () => false };
      const limiters = { ...createDefaultAuthRateLimiters(), securityEventList: denyAll };
      const freshApp = createAuthRoutes(config, layer, Layer.empty, limiters);
      const res = await freshApp.handle(
        new Request("http://localhost/account/security-events", {
          headers: { Authorization: "Bearer any" },
        }),
      );
      expect(res.status).toBe(429);
    });
  });
});
