import { Effect, Layer } from "effect";
import { describe, it, expect, beforeEach } from "vitest";

import type { RateLimiterBackend } from "../../src/lib/rate-limit";
import { createAuthRoutes, createDefaultAuthRateLimiters } from "../../src/routes/auth";
import { createAuthService } from "../../src/services/auth";
import { createTestLayer } from "../helpers/db";

const config = {
  rpId: "localhost",
  rpName: "OSN Test",
  origin: "http://localhost:5173",
  issuerUrl: "http://localhost:4000",
  jwtSecret: "test-secret-at-least-32-characters-long",
};

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
      expect(json.session.refresh_token.length).toBeGreaterThan(0);
      expect(json.session.token_type).toBe("Bearer");
      expect(json.session.expires_in).toBeGreaterThan(0);
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
  // Authorization
  // -------------------------------------------------------------------------
  describe("GET /authorize", () => {
    it("returns 400 for unsupported response_type", async () => {
      const res = await app.handle(
        new Request(
          "http://localhost/authorize?response_type=token&client_id=pulse&redirect_uri=http://localhost:5173/callback&state=abc&code_challenge=xyz",
        ),
      );
      expect(res.status).toBe(400);
    });

    it("returns HTML page for valid request", async () => {
      const res = await app.handle(
        new Request(
          "http://localhost/authorize?response_type=code&client_id=pulse&redirect_uri=http://localhost:5173/callback&state=abc&code_challenge=xyz",
        ),
      );
      expect(res.status).toBe(200);
      const text = (await res.text()) as string;
      expect(text).toContain("Sign in to OSN");
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

    it("returns tokens for a valid authorization_code grant", async () => {
      // Register then obtain a real auth code via OTP flow
      let capturedOtp: string | undefined;
      const authHelper = createAuthService({
        ...config,
        sendEmail: async (_to, _subject, body) => {
          const m = body.match(/code is: (\d{6})/);
          if (m) capturedOtp = m[1];
        },
      });
      await Effect.runPromise(
        authHelper.registerProfile("judy@example.com", "judy").pipe(Effect.provide(layer)),
      );
      await Effect.runPromise(authHelper.beginOtp("judy@example.com").pipe(Effect.provide(layer)));
      const { code } = await Effect.runPromise(
        authHelper.completeOtp("judy@example.com", capturedOtp!).pipe(Effect.provide(layer)),
      );

      // S-H4: PKCE is now mandatory — set up a PKCE entry via /authorize first
      const verifier = "test-verifier-that-is-long-enough";
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
      const challenge = Buffer.from(digest)
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=/g, "");
      const testState = "test-state-" + Date.now();

      await app.handle(
        new Request(
          `http://localhost/authorize?response_type=code&client_id=pulse&redirect_uri=${encodeURIComponent("http://localhost:5173/callback")}&state=${testState}&code_challenge=${challenge}&code_challenge_method=S256`,
        ),
      );

      const res = await app.handle(
        new Request("http://localhost/token", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            grant_type: "authorization_code",
            code,
            redirect_uri: "http://localhost:5173/callback",
            client_id: "pulse",
            code_verifier: verifier,
            state: testState,
          }),
        }),
      );
      expect(res.status).toBe(200);
      const json = (await res.json()) as {
        access_token: string;
        refresh_token: string;
        token_type: string;
        expires_in: number;
      };
      expect(json.access_token).toBeTruthy();
      expect(json.refresh_token).toBeTruthy();
      expect(json.token_type).toBe("Bearer");
      expect(json.expires_in).toBe(3600);
    });
  });

  // -------------------------------------------------------------------------
  // OTP
  // -------------------------------------------------------------------------
  describe("POST /otp/begin", () => {
    it("returns sent:true when user exists (email identifier)", async () => {
      await app.handle(
        new Request("http://localhost/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: "kate@example.com", handle: "kate" }),
        }),
      );
      const res = await app.handle(
        new Request("http://localhost/otp/begin", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ identifier: "kate@example.com" }),
        }),
      );
      expect(res.status).toBe(200);
      const json = (await res.json()) as { sent: boolean };
      expect(json.sent).toBe(true);
    });

    it("returns sent:true when user exists (handle identifier)", async () => {
      await app.handle(
        new Request("http://localhost/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: "lars@example.com", handle: "lars" }),
        }),
      );
      const res = await app.handle(
        new Request("http://localhost/otp/begin", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ identifier: "lars" }),
        }),
      );
      expect(res.status).toBe(200);
      const json = (await res.json()) as { sent: boolean };
      expect(json.sent).toBe(true);
    });

    it("returns 400 when user does not exist", async () => {
      const res = await app.handle(
        new Request("http://localhost/otp/begin", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ identifier: "ghost@example.com" }),
        }),
      );
      expect(res.status).toBe(400);
    });
  });

  describe("POST /otp/complete", () => {
    it("returns 400 for wrong OTP code", async () => {
      await app.handle(
        new Request("http://localhost/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: "liam@example.com", handle: "liam" }),
        }),
      );
      await app.handle(
        new Request("http://localhost/otp/begin", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ identifier: "liam@example.com" }),
        }),
      );
      const res = await app.handle(
        new Request("http://localhost/otp/complete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ identifier: "liam@example.com", code: "000000" }),
        }),
      );
      expect(res.status).toBe(400);
    });
  });

  // -------------------------------------------------------------------------
  // Magic link
  // -------------------------------------------------------------------------
  describe("POST /magic/begin", () => {
    it("returns sent:true for existing user", async () => {
      await app.handle(
        new Request("http://localhost/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: "mia@example.com", handle: "mia" }),
        }),
      );
      const res = await app.handle(
        new Request("http://localhost/magic/begin", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ identifier: "mia@example.com" }),
        }),
      );
      expect(res.status).toBe(200);
      const json = (await res.json()) as { sent: boolean };
      expect(json.sent).toBe(true);
    });

    it("returns 400 for non-existent user", async () => {
      const res = await app.handle(
        new Request("http://localhost/magic/begin", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ identifier: "ghost@example.com" }),
        }),
      );
      expect(res.status).toBe(400);
    });
  });

  describe("GET /magic/verify", () => {
    it("returns 302 redirect for a valid magic token", async () => {
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
          .registerProfile("magic-route@example.com", "magicroute")
          .pipe(Effect.provide(layer)),
      );
      await Effect.runPromise(
        authHelper.beginMagic("magic-route@example.com").pipe(Effect.provide(layer)),
      );

      const encodedRedirect = encodeURIComponent("http://localhost:5173/callback");
      const res = await app.handle(
        new Request(
          `http://localhost/magic/verify?token=${capturedToken}&redirect_uri=${encodedRedirect}&state=abc123`,
        ),
      );
      expect(res.status).toBe(302);
    });

    it("returns 400 for an unknown token", async () => {
      const res = await app.handle(
        new Request(
          "http://localhost/magic/verify?token=bad-token&redirect_uri=http%3A%2F%2Flocalhost%3A5173%2Fcallback&state=xyz",
        ),
      );
      expect(res.status).toBe(400);
    });

    it("returns 422 when required query params are missing", async () => {
      const res = await app.handle(new Request("http://localhost/magic/verify?token=something"));
      expect(res.status).toBe(422);
    });
  });

  // -------------------------------------------------------------------------
  // First-party direct-session login (/login/*)
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
        session: { accessToken: string; refreshToken: string; expiresIn: number };
        profile: { id: string; handle: string; email: string };
      };
      expect(json.session.accessToken).toBeTruthy();
      expect(json.session.refreshToken).toBeTruthy();
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

  describe("GET /login/magic/verify", () => {
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
        new Request(`http://localhost/login/magic/verify?token=${capturedToken}`),
      );
      expect(res.status).toBe(200);
      const json = (await res.json()) as {
        session: { accessToken: string };
        profile: { handle: string; email: string };
      };
      expect(json.session.accessToken).toBeTruthy();
      expect(json.profile.handle).toBe("magicdirect");
    });

    it("returns 400 for an unknown token", async () => {
      const res = await app.handle(new Request("http://localhost/login/magic/verify?token=bogus"));
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
        authorization_endpoint: string;
        token_endpoint: string;
      };
      expect(json.issuer).toBe("http://localhost:4000");
      expect(json.authorization_endpoint).toBe("http://localhost:4000/authorize");
      expect(json.token_endpoint).toBe("http://localhost:4000/token");
    });
  });

  // -------------------------------------------------------------------------
  // Passkey login
  // -------------------------------------------------------------------------
  describe("POST /passkey/login/begin", () => {
    it("returns 400 when user has no passkeys (by email)", async () => {
      const auth = createAuthService(config);
      await Effect.runPromise(
        auth.registerProfile("noah@example.com", "noah").pipe(Effect.provide(layer)),
      );

      const res = await app.handle(
        new Request("http://localhost/passkey/login/begin", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ identifier: "noah@example.com" }),
        }),
      );
      expect(res.status).toBe(400);
    });

    it("returns 400 when user has no passkeys (by handle)", async () => {
      const auth = createAuthService(config);
      await Effect.runPromise(
        auth.registerProfile("olivia@example.com", "olivia").pipe(Effect.provide(layer)),
      );

      const res = await app.handle(
        new Request("http://localhost/passkey/login/begin", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ identifier: "olivia" }),
        }),
      );
      expect(res.status).toBe(400);
    });

    it("returns 400 when user does not exist", async () => {
      const res = await app.handle(
        new Request("http://localhost/passkey/login/begin", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ identifier: "nobody@example.com" }),
        }),
      );
      expect(res.status).toBe(400);
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
        svc.issueTokens(
          profile.id,
          profile.accountId,
          profile.email,
          profile.handle,
          profile.displayName,
        ),
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
  // PKCE enforcement (S-H4)
  // -------------------------------------------------------------------------
  describe("POST /token — PKCE enforcement", () => {
    it("returns 400 when state is missing", async () => {
      const res = await app.handle(
        new Request("http://localhost/token", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            grant_type: "authorization_code",
            code: "some-code",
            redirect_uri: "http://localhost:5173/callback",
            client_id: "pulse",
            code_verifier: "some-verifier",
          }),
        }),
      );
      expect(res.status).toBe(400);
      const json = (await res.json()) as { error: string; message: string };
      expect(json.message).toBe("PKCE parameters required");
    });

    it("returns 400 when code_verifier is missing", async () => {
      const res = await app.handle(
        new Request("http://localhost/token", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            grant_type: "authorization_code",
            code: "some-code",
            redirect_uri: "http://localhost:5173/callback",
            client_id: "pulse",
            state: "some-state",
          }),
        }),
      );
      expect(res.status).toBe(400);
      const json = (await res.json()) as { error: string; message: string };
      expect(json.message).toBe("PKCE parameters required");
    });

    it("returns 400 for unknown state", async () => {
      const res = await app.handle(
        new Request("http://localhost/token", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            grant_type: "authorization_code",
            code: "some-code",
            redirect_uri: "http://localhost:5173/callback",
            client_id: "pulse",
            code_verifier: "some-verifier",
            state: "nonexistent-state",
          }),
        }),
      );
      expect(res.status).toBe(400);
      const json = (await res.json()) as { error: string; message: string };
      expect(json.message).toBe("Unknown state");
    });

    it("returns 400 when redirect_uri does not match stored value", async () => {
      // Set up a PKCE entry via /authorize
      const verifier = "test-verifier-for-mismatch";
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
      const challenge = Buffer.from(digest)
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=/g, "");
      const testState = "mismatch-state-" + Date.now();

      await app.handle(
        new Request(
          `http://localhost/authorize?response_type=code&client_id=pulse&redirect_uri=${encodeURIComponent("http://localhost:5173/callback")}&state=${testState}&code_challenge=${challenge}&code_challenge_method=S256`,
        ),
      );

      const res = await app.handle(
        new Request("http://localhost/token", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            grant_type: "authorization_code",
            code: "some-code",
            redirect_uri: "http://different-origin:5173/callback",
            client_id: "pulse",
            code_verifier: verifier,
            state: testState,
          }),
        }),
      );
      expect(res.status).toBe(400);
      const json = (await res.json()) as { error: string; message: string };
      expect(json.message).toBe("redirect_uri mismatch");
    });
  });

  // -------------------------------------------------------------------------
  // Redirect URI allowlist (S-H3)
  // -------------------------------------------------------------------------
  describe("redirect URI allowlist", () => {
    it("/authorize rejects disallowed redirect_uri when allowlist is set", async () => {
      const restrictedApp = createAuthRoutes(
        { ...config, allowedRedirectUris: ["http://localhost:5173"] },
        layer,
      );
      const res = await restrictedApp.handle(
        new Request(
          "http://localhost/authorize?response_type=code&client_id=pulse&redirect_uri=http%3A%2F%2Fevil.com%2Fcallback&state=s1&code_challenge=ch1&code_challenge_method=S256",
        ),
      );
      expect(res.status).toBe(400);
      const json = (await res.json()) as { error: string; message: string };
      expect(json.message).toBe("redirect_uri not allowed");
    });

    it("/authorize allows redirect_uri from the allowlist", async () => {
      const restrictedApp = createAuthRoutes(
        { ...config, allowedRedirectUris: ["http://localhost:5173"] },
        layer,
      );
      const res = await restrictedApp.handle(
        new Request(
          "http://localhost/authorize?response_type=code&client_id=pulse&redirect_uri=http%3A%2F%2Flocalhost%3A5173%2Fcallback&state=s2&code_challenge=ch2&code_challenge_method=S256",
        ),
      );
      // Should return HTML (200), not an error
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain("Sign in to OSN");
    });

    it("/authorize allows any redirect_uri when allowlist is empty", async () => {
      // Default config has no allowedRedirectUris
      const res = await app.handle(
        new Request(
          "http://localhost/authorize?response_type=code&client_id=pulse&redirect_uri=http%3A%2F%2Fanything.example.com%2Fcb&state=s3&code_challenge=ch3&code_challenge_method=S256",
        ),
      );
      expect(res.status).toBe(200);
    });

    it("/token rejects disallowed redirect_uri when allowlist is set", async () => {
      const restrictedApp = createAuthRoutes(
        { ...config, allowedRedirectUris: ["http://localhost:5173"] },
        layer,
      );

      // First set up a valid PKCE entry with the allowed redirect_uri
      const verifier = "redirect-test-verifier";
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
      const challenge = Buffer.from(digest)
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=/g, "");
      const testState = "redirect-test-state";

      await restrictedApp.handle(
        new Request(
          `http://localhost/authorize?response_type=code&client_id=pulse&redirect_uri=${encodeURIComponent("http://localhost:5173/callback")}&state=${testState}&code_challenge=${challenge}&code_challenge_method=S256`,
        ),
      );

      // Try /token with a different origin
      const res = await restrictedApp.handle(
        new Request("http://localhost/token", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            grant_type: "authorization_code",
            code: "test",
            redirect_uri: "http://evil.com/callback",
            client_id: "pulse",
            code_verifier: verifier,
            state: testState,
          }),
        }),
      );
      expect(res.status).toBe(400);
      const json = (await res.json()) as { error: string; message: string };
      expect(json.message).toBe("redirect_uri not allowed");
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

  describe("POST /profiles/list", () => {
    async function getRefreshToken(): Promise<{ refreshToken: string; profileId: string }> {
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
        session: { refresh_token: string };
      };
      return { refreshToken: json.session.refresh_token, profileId: json.profileId };
    }

    it("returns the list of profiles for a valid refresh token", async () => {
      const { refreshToken } = await getRefreshToken();
      const res = await app.handle(
        new Request("http://localhost/profiles/list", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ refresh_token: refreshToken }),
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
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ refresh_token: "not.a.valid.token" }),
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
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-forwarded-for": "10.10.10.10",
          },
          body: JSON.stringify({ refresh_token: "any" }),
        }),
      );
      expect(res.status).toBe(429);
    });
  });

  describe("POST /profiles/switch", () => {
    async function registerAndGetTokens(): Promise<{
      refreshToken: string;
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
        session: { refresh_token: string };
      };
      return { refreshToken: json.session.refresh_token, profileId: json.profileId };
    }

    it("switches to an owned profile and returns a new access token", async () => {
      const { refreshToken, profileId } = await registerAndGetTokens();
      const res = await app.handle(
        new Request("http://localhost/profiles/switch", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            refresh_token: refreshToken,
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
      expect(json.expires_in).toBe(3600);
      expect(json.profile.handle).toBe("switchrt");
    });

    it("returns error for non-existent profile", async () => {
      const { refreshToken } = await registerAndGetTokens();
      const res = await app.handle(
        new Request("http://localhost/profiles/switch", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            refresh_token: refreshToken,
            profile_id: "usr_aabbccddeeff",
          }),
        }),
      );
      expect(res.status).toBeGreaterThanOrEqual(400);
    });

    it("returns error for invalid refresh token", async () => {
      const res = await app.handle(
        new Request("http://localhost/profiles/switch", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            refresh_token: "not.a.token",
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
          },
          body: JSON.stringify({
            refresh_token: "any",
            profile_id: "usr_aabbccddeeff",
          }),
        }),
      );
      expect(res.status).toBe(429);
    });
  });
});
