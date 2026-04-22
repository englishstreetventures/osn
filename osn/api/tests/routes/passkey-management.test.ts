import { passkeys } from "@osn/db/schema";
import { Db } from "@osn/db/service";
import { Effect } from "effect";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";

import { createAuthRoutes } from "../../src/routes/auth";
import { createAuthService } from "../../src/services/auth";
import { makeTestAuthConfig } from "../helpers/auth-config";
import { createTestLayer } from "../helpers/db";

/**
 * Route-level coverage for the passkey management surface:
 *   GET    /passkeys
 *   PATCH  /passkeys/:id
 *   DELETE /passkeys/:id      — step-up gated
 */

let config: Awaited<ReturnType<typeof makeTestAuthConfig>>;

beforeAll(async () => {
  config = await makeTestAuthConfig();
});

describe("passkey management routes", () => {
  let app: ReturnType<typeof createAuthRoutes>;
  let layer: ReturnType<typeof createTestLayer>;
  let svc: ReturnType<typeof createAuthService>;

  beforeEach(() => {
    layer = createTestLayer();
    app = createAuthRoutes(config, layer);
    svc = createAuthService(config);
  });

  async function seedAccount() {
    const profile = await Effect.runPromise(
      svc.registerProfile("pk-mgmt@example.com", "pkmgmt").pipe(Effect.provide(layer)),
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
    return { profile, tokens };
  }

  /**
   * Build a route app that allows OTP step-up for rename + delete (the
   * default is passkey-only — S-L4 — but driving a real WebAuthn ceremony
   * in tests isn't practical, so we widen the allow-list explicitly).
   * Returns the app, an access token, and a helper that drives the OTP
   * step-up ceremony and hands back a fresh step-up token each call.
   */
  async function setupStepUp() {
    const captured: string[] = [];
    const sendEmail = async (_to: string, _subject: string, body: string) => {
      const m = body.match(/\b(\d{6})\b/);
      if (m) captured.push(m[1]!);
    };
    const appWithOtp = createAuthRoutes(
      { ...config, sendEmail, passkeyDeleteAllowedAmr: ["webauthn", "otp"] },
      layer,
    );
    const { profile, tokens } = await seedAccount();
    const accessToken = tokens.accessToken;

    const mintOtpStepUp = async (): Promise<string> => {
      await appWithOtp.handle(
        new Request("http://localhost/step-up/otp/begin", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${accessToken}`,
          },
        }),
      );
      const code = captured[captured.length - 1]!;
      const stepUpRes = await appWithOtp.handle(
        new Request("http://localhost/step-up/otp/complete", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${accessToken}`,
          },
          body: JSON.stringify({ code }),
        }),
      );
      const { step_up_token } = (await stepUpRes.json()) as { step_up_token: string };
      return step_up_token;
    };

    return { app: appWithOtp, accessToken, profile, mintOtpStepUp };
  }

  async function seedPasskey(accountId: string, label: string | null = null) {
    const id = `pk_${Math.random().toString(16).slice(2, 14).padEnd(12, "0")}`;
    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Db;
        yield* Effect.tryPromise(() =>
          db.insert(passkeys).values({
            id,
            accountId,
            credentialId: `cred-${id}`,
            publicKey: "AAAA",
            counter: 0,
            transports: null,
            createdAt: new Date(),
            label,
            lastUsedAt: null,
            aaguid: null,
            backupEligible: false,
            backupState: false,
            updatedAt: null,
          }),
        );
      }).pipe(Effect.provide(layer)),
    );
    return id;
  }

  describe("GET /passkeys", () => {
    it("returns 401 without bearer", async () => {
      const res = await app.handle(new Request("http://localhost/passkeys"));
      expect(res.status).toBe(401);
    });

    it("returns the caller's passkeys", async () => {
      const { tokens, profile } = await seedAccount();
      await seedPasskey(profile.accountId, "Laptop");
      const res = await app.handle(
        new Request("http://localhost/passkeys", {
          headers: { Authorization: `Bearer ${tokens.accessToken}` },
        }),
      );
      expect(res.status).toBe(200);
      const json = (await res.json()) as { passkeys: { label: string | null }[] };
      expect(json.passkeys).toHaveLength(1);
      expect(json.passkeys[0]!.label).toBe("Laptop");
    });
  });

  describe("PATCH /passkeys/:id", () => {
    it("returns 401 without bearer", async () => {
      const res = await app.handle(
        new Request("http://localhost/passkeys/pk_abcdef012345", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ label: "X" }),
        }),
      );
      expect(res.status).toBe(401);
    });

    it("returns 403 without step-up token (S-M2)", async () => {
      const { tokens, profile } = await seedAccount();
      const pk = await seedPasskey(profile.accountId);
      const res = await app.handle(
        new Request(`http://localhost/passkeys/${pk}`, {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${tokens.accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ label: "Renamed" }),
        }),
      );
      expect(res.status).toBe(403);
      const json = (await res.json()) as { error?: string };
      expect(json.error).toBe("step_up_required");
    });

    it("renames a passkey with a valid step-up token", async () => {
      const { app: verifiedApp, accessToken, profile, mintOtpStepUp } = await setupStepUp();
      const pk = await seedPasskey(profile.accountId);
      const stepUp = await mintOtpStepUp();

      const res = await verifiedApp.handle(
        new Request(`http://localhost/passkeys/${pk}`, {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
            "X-Step-Up-Token": stepUp,
          },
          body: JSON.stringify({ label: "Renamed" }),
        }),
      );
      expect(res.status).toBe(200);
    });

    it("rejects malformed passkey ids at the route layer", async () => {
      const { tokens } = await seedAccount();
      const res = await app.handle(
        new Request("http://localhost/passkeys/not-a-pk-id", {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${tokens.accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ label: "X" }),
        }),
      );
      // Elysia's TypeBox validator rejects with 422.
      expect([400, 422]).toContain(res.status);
    });
  });

  describe("DELETE /passkeys/:id", () => {
    it("returns 401 without bearer", async () => {
      const res = await app.handle(
        new Request("http://localhost/passkeys/pk_abcdef012345", { method: "DELETE" }),
      );
      expect(res.status).toBe(401);
    });

    it("returns 403 without step-up token", async () => {
      const { tokens, profile } = await seedAccount();
      const pk = await seedPasskey(profile.accountId);
      await seedPasskey(profile.accountId);
      const res = await app.handle(
        new Request(`http://localhost/passkeys/${pk}`, {
          method: "DELETE",
          headers: { Authorization: `Bearer ${tokens.accessToken}` },
        }),
      );
      expect(res.status).toBe(403);
      const json = (await res.json()) as { error?: string };
      expect(json.error).toBe("step_up_required");
    });

    // T-S2: end-to-end happy path. The route layer is the only place that
    // wires the X-Step-Up-Token header into the service call — exercise it
    // with a real minted token so a regression in that wiring fails here.
    it("succeeds with a valid step-up token and returns { remaining }", async () => {
      const { app: verifiedApp, accessToken, profile, mintOtpStepUp } = await setupStepUp();
      const pk = await seedPasskey(profile.accountId);
      await seedPasskey(profile.accountId);
      const stepUp = await mintOtpStepUp();

      const res = await verifiedApp.handle(
        new Request(`http://localhost/passkeys/${pk}`, {
          method: "DELETE",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "X-Step-Up-Token": stepUp,
          },
        }),
      );
      expect(res.status).toBe(200);
      const json = (await res.json()) as { success?: boolean; remaining?: number };
      expect(json.success).toBe(true);
      expect(json.remaining).toBe(1);
    });

    // S-L4: default config rejects OTP step-up for delete. The dedicated
    // passkey-only AMR config knob is the intended production posture.
    it("rejects OTP step-up when passkeyDeleteAllowedAmr omits it", async () => {
      const captured: string[] = [];
      const sendEmail = async (_to: string, _subject: string, body: string) => {
        const m = body.match(/\b(\d{6})\b/);
        if (m) captured.push(m[1]!);
      };
      const strictApp = createAuthRoutes({ ...config, sendEmail }, layer);
      const { tokens, profile } = await seedAccount();
      const pk = await seedPasskey(profile.accountId);
      await seedPasskey(profile.accountId);

      await strictApp.handle(
        new Request("http://localhost/step-up/otp/begin", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${tokens.accessToken}`,
          },
        }),
      );
      const code = captured[captured.length - 1]!;
      const stepUpRes = await strictApp.handle(
        new Request("http://localhost/step-up/otp/complete", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${tokens.accessToken}`,
          },
          body: JSON.stringify({ code }),
        }),
      );
      const { step_up_token } = (await stepUpRes.json()) as { step_up_token: string };

      const res = await strictApp.handle(
        new Request(`http://localhost/passkeys/${pk}`, {
          method: "DELETE",
          headers: {
            Authorization: `Bearer ${tokens.accessToken}`,
            "X-Step-Up-Token": step_up_token,
          },
        }),
      );
      // Verifier rejects with AuthError → handleError maps to 4xx.
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
    });
  });

  // T-S1: route-level cross-account guard. The service rejects with
  // AuthError; this confirms `handleError` doesn't downgrade that into a
  // 500 (or surface a useful "is this id real?" oracle).
  describe("PATCH /passkeys/:id (cross-account)", () => {
    it("rejects renaming another account's passkey at the HTTP layer", async () => {
      const alice = await seedAccount();
      // Spin up a separate account for Bob and seed a passkey he owns.
      const bobProfile = await Effect.runPromise(
        svc.registerProfile("pk-mgmt-bob@example.com", "pkmgmtbob").pipe(Effect.provide(layer)),
      );
      const bobPk = await seedPasskey(bobProfile.accountId);

      const res = await app.handle(
        new Request(`http://localhost/passkeys/${bobPk}`, {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${alice.tokens.accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ label: "stolen" }),
        }),
      );
      // The exact code is whatever publicError(AuthError) maps to — accept
      // any 4xx that isn't 401 (since Alice is authenticated).
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
      expect(res.status).not.toBe(401);
    });
  });
});
