import { describe, it, expect, beforeEach } from "vitest";
import { createTestLayer } from "../helpers/db";
import { createAuthRoutes } from "../../src/routes/auth";
import { createAuthService } from "../../src/services/auth";
import { Effect } from "effect";

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
      const json = (await res.json()) as { userId: string; handle: string; email: string };
      expect(json.handle).toBe("alice");
      expect(json.email).toBe("alice@example.com");
      expect(json.userId).toMatch(/^usr_/);
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
        authHelper.registerUser("judy@example.com", "judy").pipe(Effect.provide(layer)),
      );
      await Effect.runPromise(authHelper.beginOtp("judy@example.com").pipe(Effect.provide(layer)));
      const { code } = await Effect.runPromise(
        authHelper.completeOtp("judy@example.com", capturedOtp!).pipe(Effect.provide(layer)),
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
            code_verifier: "test-verifier",
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
          .registerUser("magic-route@example.com", "magicroute")
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
        auth.registerUser("noah@example.com", "noah").pipe(Effect.provide(layer)),
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
        auth.registerUser("olivia@example.com", "olivia").pipe(Effect.provide(layer)),
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
});
