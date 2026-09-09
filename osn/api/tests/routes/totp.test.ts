import { base32Decode, deriveTotpCode } from "@shared/crypto/totp";
import { Effect } from "effect";
import { beforeAll, describe, expect, it } from "vitest";

import { createAuthService, type AuthConfig } from "../../src/services/auth";
import { makeTestAuthConfig } from "../helpers/auth-config";
import { createTestLayer } from "../helpers/db";
import { createAuthRoutes } from "../helpers/routes";

/**
 * The HTTP surface: status codes, the step-up gates, and — most importantly —
 * what the wire is allowed to carry. `GET /totp/status` must never leak the
 * secret, the ciphertext or the replay step.
 */

let config: AuthConfig;

beforeAll(async () => {
  config = await makeTestAuthConfig();
});

const STEP_SECONDS = 30;

/** A route app and a service sharing ONE layer, so both see the same database. */
function makeApp() {
  const layer = createTestLayer();
  const app = createAuthRoutes(config, layer);
  const auth = createAuthService(config);
  const svc = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.runPromise(effect.pipe(Effect.provide(layer)) as Effect.Effect<A, E, never>);
  /** Register an account and return it with a live access token. */
  const seed = async (emailAddr: string, handle: string) => {
    const profile = await svc(auth.registerProfile(emailAddr, handle));
    const tokens = await svc(
      auth.issueTokens(
        profile.id,
        profile.accountId,
        profile.email,
        profile.handle,
        profile.displayName,
      ),
    );
    return { profile, tokens };
  };
  return { app, auth, layer, svc, seed };
}

const json = (path: string, init: RequestInit = {}) =>
  new Request(`http://localhost${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...init.headers },
  });

describe("POST /totp/enroll/begin", () => {
  it("401s without a bearer token", async () => {
    const { app } = makeApp();
    const res = await app.handle(json("/totp/enroll/begin", { method: "POST", body: "{}" }));
    expect(res.status).toBe(401);
  });

  it("403s with a valid bearer token but no step-up token", async () => {
    // The gate that matters: an access token alone must not bind an
    // authenticator to the account.
    const { app, auth, svc, seed } = makeApp();
    const { profile, tokens } = await seed("r-a@example.com", "rtotpa");

    const res = await app.handle(
      json("/totp/enroll/begin", {
        method: "POST",
        body: "{}",
        headers: { authorization: `Bearer ${tokens.accessToken}` },
      }),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "step_up_required" });
  });

  it("returns the secret once, with no-store, on a gated call", async () => {
    const { app, auth, svc, seed } = makeApp();
    const { profile, tokens } = await seed("r-b@example.com", "rtotpb");
    const stepUp = await svc(auth.issueStepUpToken(profile.accountId, "passkey", "totp_enroll"));

    const res = await app.handle(
      json("/totp/enroll/begin", {
        method: "POST",
        body: JSON.stringify({ step_up_token: stepUp }),
        headers: { authorization: `Bearer ${tokens.accessToken}` },
      }),
    );
    expect(res.status).toBe(200);
    // Secret material must never sit in a shared cache.
    expect(res.headers.get("cache-control")).toBe("no-store");

    const body = (await res.json()) as { otpauthUri: string; totpSecret: string };
    expect(body.otpauthUri).toMatch(/^otpauth:\/\/totp\//);
    // The field names are the logger deny-list entries. Renaming either
    // silently un-redacts the secret, so pin them.
    expect(Object.keys(body).toSorted()).toEqual(["otpauthUri", "totpSecret"]);
  });
});

describe("the enrol → confirm → status round trip", () => {
  it("enrols and reports status without ever returning secret material", async () => {
    const { app, auth, svc, seed } = makeApp();
    const { profile, tokens } = await seed("r-c@example.com", "rtotpc");
    const stepUp = await svc(auth.issueStepUpToken(profile.accountId, "passkey", "totp_enroll"));

    const begun = (await (
      await app.handle(
        json("/totp/enroll/begin", {
          method: "POST",
          body: JSON.stringify({ step_up_token: stepUp }),
          headers: { authorization: `Bearer ${tokens.accessToken}` },
        }),
      )
    ).json()) as { totpSecret: string };

    const code = await deriveTotpCode(
      base32Decode(begun.totpSecret),
      Math.floor(Date.now() / 1000 / STEP_SECONDS),
    );

    const completed = await app.handle(
      json("/totp/enroll/complete", {
        method: "POST",
        body: JSON.stringify({ code, label: "Pixel" }),
        headers: { authorization: `Bearer ${tokens.accessToken}` },
      }),
    );
    expect(completed.status).toBe(200);
    expect(await completed.json()).toEqual({ enrolled: true });

    const statusRes = await app.handle(
      json("/totp/status", { headers: { authorization: `Bearer ${tokens.accessToken}` } }),
    );
    expect(statusRes.status).toBe(200);
    expect(statusRes.headers.get("cache-control")).toBe("no-store");

    const status = (await statusRes.json()) as Record<string, unknown>;
    // Assert the WHOLE body. A projection that grew a column would otherwise
    // ship the ciphertext, the IV or the replay step without a failing test.
    expect(Object.keys(status).toSorted()).toEqual([
      "createdAt",
      "enrolled",
      "label",
      "lastUsedAt",
    ]);
    expect(status["enrolled"]).toBe(true);

    const serialised = JSON.stringify(status);
    for (const forbidden of ["secret", "ciphertext", "iv", "otpauth", "Step", "keyVersion"]) {
      expect(serialised).not.toContain(forbidden);
    }
  });

  it("400s on a wrong confirmation code and enrols nothing", async () => {
    const { app, auth, svc, seed } = makeApp();
    const { profile, tokens } = await seed("r-d@example.com", "rtotpd");
    const stepUp = await svc(auth.issueStepUpToken(profile.accountId, "passkey", "totp_enroll"));
    await app.handle(
      json("/totp/enroll/begin", {
        method: "POST",
        body: JSON.stringify({ step_up_token: stepUp }),
        headers: { authorization: `Bearer ${tokens.accessToken}` },
      }),
    );

    const res = await app.handle(
      json("/totp/enroll/complete", {
        method: "POST",
        body: JSON.stringify({ code: "000000" }),
        headers: { authorization: `Bearer ${tokens.accessToken}` },
      }),
    );
    expect(res.status).toBe(400);

    const status = (await (
      await app.handle(
        json("/totp/status", { headers: { authorization: `Bearer ${tokens.accessToken}` } }),
      )
    ).json()) as { enrolled: boolean };
    expect(status.enrolled).toBe(false);
  });
});

describe("DELETE /totp", () => {
  it("403s without a step-up token", async () => {
    const { app, auth, svc, seed } = makeApp();
    const { profile, tokens } = await seed("r-e@example.com", "rtotpe");

    const res = await app.handle(
      json("/totp", {
        method: "DELETE",
        body: "{}",
        headers: { authorization: `Bearer ${tokens.accessToken}` },
      }),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "step_up_required" });
  });

  it("401s without a bearer token", async () => {
    const { app } = makeApp();
    const res = await app.handle(json("/totp", { method: "DELETE", body: "{}" }));
    expect(res.status).toBe(401);
  });

  it("accepts the step-up token from the X-Step-Up-Token header too", async () => {
    const { app, auth, svc, seed } = makeApp();
    const { profile, tokens } = await seed("r-f@example.com", "rtotpf");
    const stepUp = await svc(auth.issueStepUpToken(profile.accountId, "passkey", "totp_disable"));

    const res = await app.handle(
      json("/totp", {
        method: "DELETE",
        headers: {
          authorization: `Bearer ${tokens.accessToken}`,
          "x-step-up-token": stepUp,
        },
      }),
    );
    // Nothing enrolled, so this is the idempotent branch — the point is that the
    // header satisfied the gate rather than 403ing.
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ disabled: false });
  });
});

describe("GET /totp/status", () => {
  it("401s without a bearer token", async () => {
    const { app } = makeApp();
    const res = await app.handle(json("/totp/status"));
    expect(res.status).toBe(401);
  });

  it("reports not-enrolled without disclosing anything else", async () => {
    const { app, auth, svc, seed } = makeApp();
    const { profile, tokens } = await seed("r-g@example.com", "rtotpg");

    const res = await app.handle(
      json("/totp/status", { headers: { authorization: `Bearer ${tokens.accessToken}` } }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      enrolled: false,
      label: null,
      lastUsedAt: null,
      createdAt: null,
    });
  });
});

describe("POST /step-up/totp/complete", () => {
  it("401s without a bearer token", async () => {
    const { app } = makeApp();
    const res = await app.handle(
      json("/step-up/totp/complete", {
        method: "POST",
        body: JSON.stringify({ code: "123456" }),
      }),
    );
    expect(res.status).toBe(401);
  });

  it("mints a step-up token from a code, and refuses that code a second time", async () => {
    const { app, auth, svc, seed } = makeApp();
    const { profile, tokens } = await seed("r-h@example.com", "rtotph");
    const stepUp = await svc(auth.issueStepUpToken(profile.accountId, "passkey", "totp_enroll"));

    const begun = (await (
      await app.handle(
        json("/totp/enroll/begin", {
          method: "POST",
          body: JSON.stringify({ step_up_token: stepUp }),
          headers: { authorization: `Bearer ${tokens.accessToken}` },
        }),
      )
    ).json()) as { totpSecret: string };
    const secret = base32Decode(begun.totpSecret);
    const nowStep = Math.floor(Date.now() / 1000 / STEP_SECONDS);

    await app.handle(
      json("/totp/enroll/complete", {
        method: "POST",
        body: JSON.stringify({ code: await deriveTotpCode(secret, nowStep) }),
        headers: { authorization: `Bearer ${tokens.accessToken}` },
      }),
    );

    // A later step than enrolment consumed, so this is a clean first use.
    const code = await deriveTotpCode(secret, nowStep + 1);
    const first = await app.handle(
      json("/step-up/totp/complete", {
        method: "POST",
        body: JSON.stringify({ code, purpose: "passkey_register" }),
        headers: { authorization: `Bearer ${tokens.accessToken}` },
      }),
    );
    expect(first.status).toBe(200);
    const minted = (await first.json()) as { step_up_token: string; expires_in: number };
    expect(minted.step_up_token).toMatch(/^eyJ/);

    const replay = await app.handle(
      json("/step-up/totp/complete", {
        method: "POST",
        body: JSON.stringify({ code, purpose: "passkey_register" }),
        headers: { authorization: `Bearer ${tokens.accessToken}` },
      }),
    );
    expect(replay.status).toBe(400);
  });
});
