import { serviceAccountKeys, serviceAccounts } from "@osn/db/schema";
import { Db } from "@osn/db/service";
import {
  clearPublicKeyCache,
  createArcToken,
  exportKeyToJwk,
  generateArcKeyPair,
} from "@shared/crypto";
import { Effect } from "effect";
import { exportJWK } from "jose";
import { beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../src/app";
import { buildAppDeps, type EnvVars } from "../src/build-deps";
import { createDurableCoordination } from "../src/lib/coordination/durable";
import { osnLoggerLayer } from "../src/observability";
import { createAuthService } from "../src/services/auth";
import { createFakeNamespace, type FakeNamespace } from "./helpers/coordination-namespace";
import { createTestLayerWithSqlite } from "./helpers/db";

/**
 * `createApp` gives the account export and erasure routes the coordination
 * bundle's limiters and step-up guard, not the in-memory defaults their route
 * factories fall back to. Only the bundle reaches the Durable Object stand-in,
 * so a call recorded on it can only come from what `createApp` passed.
 */

let env: EnvVars;
const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString("base64");
const IP = "203.0.113.9";
const ORIGIN = "http://localhost:5173";

beforeAll(async () => {
  const { privateKey, publicKey } = await generateArcKeyPair();
  env = {
    OSN_ENV: "local",
    OSN_JWT_PRIVATE_KEY: b64(await exportJWK(privateKey)),
    OSN_JWT_PUBLIC_KEY: b64(await exportJWK(publicKey)),
    TRUSTED_PROXY_COUNT: "1",
    OSN_CORS_ORIGIN: ORIGIN,
  };
});

async function signedIn() {
  const fake = createFakeNamespace();
  const { layer, sqlite } = createTestLayerWithSqlite();
  const built = await buildAppDeps(env, {
    coordination: (onError) => createDurableCoordination(fake.ns, onError),
    dbAndEmailLayer: layer,
    observabilityLayer: osnLoggerLayer,
    includeObservabilityPlugin: false,
  });
  const auth = createAuthService(built.deps.authConfig);
  const profile = await Effect.runPromise(
    auth.registerProfile("wired@example.com", "wired").pipe(Effect.provide(layer)),
  );
  const { accessToken, refreshToken } = await Effect.runPromise(
    auth
      .issueTokens(
        profile.id,
        profile.accountId,
        profile.email,
        profile.handle,
        profile.displayName,
      )
      .pipe(Effect.provide(layer)),
  );
  // The signed-in session, which the step-up tokens below are minted for.
  const live = await Effect.runPromise(
    auth
      .resolveLiveOrdinarySession(profile.accountId, profile.id, {
        cookieSessionHash: auth.hashSessionToken(refreshToken),
        sessionBinding: null,
      })
      .pipe(Effect.provide(layer)),
  );
  if (!live) throw new Error("the signed-in session is not live");
  return {
    app: createApp(built.deps),
    fake,
    auth,
    layer,
    handle: profile.handle,
    accountId: profile.accountId,
    profileId: profile.id,
    accessToken,
    refreshToken,
    minting: { accountId: profile.accountId, familyId: live.familyId },
    sqlite,
  };
}

const callsOn = (fake: FakeNamespace, store: string) =>
  fake.calls.filter((call) => call.store === store).map((call) => call.op);

/**
 * Registers Pulse as a service allowed to verify step-up tokens, and answers
 * a caller of `POST /internal/step-up/verify` signing as it over ARC.
 */
async function pulseVerifier(h: Awaited<ReturnType<typeof signedIn>>) {
  clearPublicKeyCache();
  const kp = await generateArcKeyPair();
  const keyId = crypto.randomUUID();
  const now = new Date();
  await Effect.runPromise(
    Effect.gen(function* () {
      const { db } = yield* Db;
      yield* Effect.promise(() =>
        db.insert(serviceAccounts).values({
          serviceId: "pulse-api",
          allowedScopes: "step-up:verify",
          createdAt: now,
          updatedAt: now,
        }),
      );
      yield* Effect.promise(async () =>
        db.insert(serviceAccountKeys).values({
          keyId,
          serviceId: "pulse-api",
          publicKeyJwk: await exportKeyToJwk(kp.publicKey),
          registeredAt: now,
          expiresAt: null,
          revokedAt: null,
        }),
      );
    }).pipe(Effect.provide(h.layer)),
  );
  const arc = await createArcToken(kp.privateKey, {
    iss: "pulse-api",
    aud: "osn-api",
    scope: "step-up:verify",
    kid: keyId,
  });
  // The profile Pulse verified its own caller as: the signed-in one, unless
  // a test names another.
  return (token: string, purpose: string, profileId: string = h.profileId) =>
    h.app.handle(
      new Request("http://localhost/internal/step-up/verify", {
        method: "POST",
        headers: { authorization: `ARC ${arc}`, "content-type": "application/json" },
        body: JSON.stringify({ token, purpose, profile_id: profileId }),
      }),
    );
}

describe("createApp wires the coordination bundle into the account routes", () => {
  it("GET /account/export spends the shared per-IP and per-account budgets and step-up guard", async () => {
    const h = await signedIn();
    const exportOnce = async () =>
      h.app.handle(
        new Request("http://localhost/account/export", {
          headers: {
            "x-forwarded-for": IP,
            authorization: `Bearer ${h.accessToken}`,
            "x-step-up-token": await Effect.runPromise(
              h.auth.issueStepUpToken(h.minting, "otp", "account_export"),
            ),
          },
        }),
      );

    const first = await exportOnce();
    expect(first.status).toBe(200);
    await first.body?.cancel();

    const second = await exportOnce();
    expect(second.status).toBe(429);
    expect(await second.json()).toEqual({ error: "rate_limited" });

    expect(callsOn(h.fake, "account.export_ip")).toEqual(["increment", "increment"]);
    expect(callsOn(h.fake, "step_up_jti")).toEqual(["claim", "claim"]);
    expect(callsOn(h.fake, "account.export")).toEqual(["increment", "increment"]);
  });

  it("GET /account/deletion-status spends the shared erasure budget", async () => {
    const h = await signedIn();
    const res = await h.app.handle(
      new Request("http://localhost/account/deletion-status", {
        headers: { "x-forwarded-for": IP, authorization: `Bearer ${h.accessToken}` },
      }),
    );
    expect(res.status).toBe(200);
    expect(callsOn(h.fake, "account.deletion_status")).toEqual(["increment"]);
  });

  it("DELETE /account claims its step-up token on the shared store", async () => {
    const h = await signedIn();
    const res = await h.app.handle(
      new Request("http://localhost/account", {
        method: "DELETE",
        headers: {
          "x-forwarded-for": IP,
          origin: ORIGIN,
          authorization: `Bearer ${h.accessToken}`,
          "content-type": "application/json",
          "x-step-up-token": await Effect.runPromise(
            h.auth.issueStepUpToken(h.minting, "otp", "account_delete"),
          ),
        },
        body: JSON.stringify({ confirm_handle: h.handle }),
      }),
    );
    expect(res.status).toBe(202);
    expect(callsOn(h.fake, "step_up_jti")).toEqual(["claim"]);
  });

  it("POST /internal/step-up/verify claims its step-up token on the shared store", async () => {
    const h = await signedIn();
    const verify = await pulseVerifier(h);
    const token = await Effect.runPromise(
      h.auth.issueStepUpToken(h.minting, "otp", "pulse_app_delete"),
    );

    expect(await (await verify(token, "pulse_app_delete")).json()).toEqual({
      ok: true,
      account_id: h.accountId,
    });
    expect(await (await verify(token, "pulse_app_delete")).json()).toEqual({
      ok: false,
      reason: "consumed",
    });
    expect(callsOn(h.fake, "step_up_jti")).toEqual(["claim", "claim"]);
  });
});

// Pulse spends a step-up token here with no OSN session on the hop, so the
// token's binding to the session family that minted it is the only session
// check this route makes.
describe("POST /internal/step-up/verify, for a token whose minting session has ended", () => {
  it("refuses it and claims nothing on the shared store", async () => {
    // Red on removing the family check from `verifyStepUpToken`, or on
    // making it after the single-use claim.
    const h = await signedIn();
    const verify = await pulseVerifier(h);
    const token = await Effect.runPromise(
      h.auth.issueStepUpToken(h.minting, "otp", "pulse_app_delete"),
    );
    // The device that minted it signs out, as `POST /logout` does.
    await Effect.runPromise(h.auth.invalidateSession(h.refreshToken).pipe(Effect.provide(h.layer)));

    const res = await verify(token, "pulse_app_delete");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: false, reason: "invalid" });
    expect(callsOn(h.fake, "step_up_jti")).toEqual([]);
  });

  it("answers a database fault while it reads the family as a 500, and claims nothing", async () => {
    // Red on the route answering every verifier failure as a refusal: Pulse
    // would read a database it could not reach as a refused token.
    const h = await signedIn();
    const verify = await pulseVerifier(h);
    const token = await Effect.runPromise(
      h.auth.issueStepUpToken(h.minting, "otp", "pulse_app_delete"),
    );
    // Nothing on this hop reads `sessions` before the family lookup.
    h.sqlite.run("DROP TABLE sessions");

    const res = await verify(token, "pulse_app_delete");
    expect({ status: res.status, body: await res.json() }).toEqual({
      status: 500,
      body: { error: "internal_error" },
    });
    expect(callsOn(h.fake, "step_up_jti")).toEqual([]);
  });

  it("refuses a token of another account than the one owning Pulse's caller, and claims nothing", async () => {
    // Red on the route spending a token without checking that the profile
    // Pulse verified belongs to the token's account: a caller of Pulse would
    // delete someone else's Pulse data with a token minted on an account of
    // their own.
    const h = await signedIn();
    const verify = await pulseVerifier(h);
    const token = await Effect.runPromise(
      h.auth.issueStepUpToken(h.minting, "otp", "pulse_app_delete"),
    );
    const someoneElse = await Effect.runPromise(
      h.auth
        .registerProfile("someone-else@example.com", "someoneelse")
        .pipe(Effect.provide(h.layer)),
    );

    for (const profileId of [someoneElse.id, "usr_000000000000"]) {
      const res = await verify(token, "pulse_app_delete", profileId);
      expect(await res.json()).toEqual({ ok: false, reason: "invalid" });
    }
    expect(callsOn(h.fake, "step_up_jti")).toEqual([]);

    // The same token, for the profile it belongs to, is still unspent.
    expect(await (await verify(token, "pulse_app_delete")).json()).toEqual({
      ok: true,
      account_id: h.accountId,
    });
  });

  it("refuses another app's deletion purpose to Pulse, and claims nothing", async () => {
    // Red on the route letting any service holding the scope spend any
    // downstream purpose: only Zap spends `zap_app_delete`.
    const h = await signedIn();
    const verify = await pulseVerifier(h);
    const token = await Effect.runPromise(
      h.auth.issueStepUpToken(h.minting, "otp", "zap_app_delete"),
    );

    expect(await (await verify(token, "zap_app_delete")).json()).toEqual({
      ok: false,
      reason: "invalid",
    });
    expect(callsOn(h.fake, "step_up_jti")).toEqual([]);
  });

  it("refuses the account_delete purpose before reading the token", async () => {
    // Red on the route's body still listing `account_delete`: account
    // deletion spends its token at `DELETE /account`, behind a live session.
    const h = await signedIn();
    const verify = await pulseVerifier(h);
    const token = await Effect.runPromise(
      h.auth.issueStepUpToken(h.minting, "otp", "account_delete"),
    );

    const res = await verify(token, "account_delete");
    expect(res.status).toBe(422);
    await res.body?.cancel();
    expect(callsOn(h.fake, "step_up_jti")).toEqual([]);
  });
});
