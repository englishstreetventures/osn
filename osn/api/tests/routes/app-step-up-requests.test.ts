/**
 * An app's step-up request, end to end through `createApp`: cire-api begins it
 * over ARC for one profile, bound to the hash of a secret its cookie holds in
 * the asking browser; the person confirms it on Musubi with a step-up; osn-api
 * hands that browser back a code; cire-api verifies the request with the
 * secret's hash and the code. Every store call reaches the Durable Object
 * stand-in, as on a deployed tier, so a request begun by one route is the one
 * the next route reads.
 *
 * Read by whoever changes `services/auth/app-step-up.ts`, the routes in
 * `routes/internal-account.ts` and `routes/auth/step-up.ts`, or cire-api's
 * removal of a person's Cire data, which spends these requests.
 */

import { createHash, randomBytes } from "node:crypto";

import { serviceAccountKeys, serviceAccounts } from "@osn/db/schema";
import { Db } from "@osn/db/service";
import type { CoordinationNamespace } from "@shared/coordination";
import {
  clearPublicKeyCache,
  createArcToken,
  exportKeyToJwk,
  generateArcKeyPair,
} from "@shared/crypto";
import type { StepUpFactor } from "@shared/observability/metrics";
import { Effect } from "effect";
import { exportJWK } from "jose";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { createApp } from "../../src/app";
import { buildAppDeps, type EnvVars } from "../../src/build-deps";
import { buildSessionCookies } from "../../src/lib/cookie-session";
import { createDurableCoordination } from "../../src/lib/coordination/durable";
import { osnLoggerLayer } from "../../src/observability";
import { createAuthService } from "../../src/services/auth";
import { appStepUpReturnConfig, returnToAdmitted } from "../../src/services/auth/app-step-up";
import type { AssertingCredential } from "../../src/services/auth/types";
import { createFakeNamespace, type FakeNamespace } from "../helpers/coordination-namespace";
import { createTestLayerWithSqlite } from "../helpers/db";

const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString("base64");
const IP = "203.0.113.24";
const ORIGIN = "http://localhost:5173";
const PORTAL = "http://localhost:4322";
const RETURN_TO = `${PORTAL}/#/remove-data`;

let env: EnvVars;

beforeAll(async () => {
  const { privateKey, publicKey } = await generateArcKeyPair();
  env = {
    OSN_ENV: "local",
    OSN_JWT_PRIVATE_KEY: b64(await exportJWK(privateKey)),
    OSN_JWT_PUBLIC_KEY: b64(await exportJWK(publicKey)),
    TRUSTED_PROXY_COUNT: "1",
    OSN_CORS_ORIGIN: ORIGIN,
    CIRE_ORGANISER_ORIGIN: PORTAL,
  };
});

afterEach(() => {
  vi.useRealTimers();
});

const nowSec = () => Math.floor(Date.now() / 1000);
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const secret = () => randomBytes(32).toString("base64url");

/** Registers `serviceId` with `step-up:verify` and answers ARC headers signed as it. */
async function arcCaller(
  run: <A, E>(effect: Effect.Effect<A, E, Db>) => Promise<A>,
  serviceId: string,
) {
  clearPublicKeyCache();
  const kp = await generateArcKeyPair();
  const keyId = crypto.randomUUID();
  const now = new Date();
  await run(
    Effect.gen(function* () {
      const { db } = yield* Db;
      yield* Effect.promise(() =>
        db.insert(serviceAccounts).values({
          serviceId,
          allowedScopes: "step-up:verify",
          createdAt: now,
          updatedAt: now,
        }),
      );
      yield* Effect.promise(async () =>
        db.insert(serviceAccountKeys).values({
          keyId,
          serviceId,
          publicKeyJwk: await exportKeyToJwk(kp.publicKey),
          registeredAt: now,
          expiresAt: null,
          revokedAt: null,
        }),
      );
    }),
  );
  // A fresh token each call, so a test that moves the clock past a token's
  // life still sends a live one.
  return () =>
    createArcToken(kp.privateKey, {
      iss: serviceId,
      aud: "osn-api",
      scope: "step-up:verify",
      kid: keyId,
    });
}

/**
 * `ns`, with a gate on the `app_step_up` objects' reads. Once armed with `n`,
 * each read runs and none answers until `n` have arrived, so `n` confirms
 * have all read the pending request before any of them can write.
 */
function gatedReads(ns: CoordinationNamespace) {
  let armed: { n: number; arrived: (() => void)[] } | null = null;
  const gated: CoordinationNamespace = {
    getByName(name, options) {
      const stub = ns.getByName(name, options);
      if (!name.startsWith("app_step_up:")) return stub;
      return {
        ...stub,
        read: async () => {
          const value = await stub.read();
          const gate = armed;
          if (gate) {
            await new Promise<void>((resolve) => {
              gate.arrived.push(resolve);
              if (gate.arrived.length === gate.n) {
                armed = null;
                for (const release of gate.arrived) release();
              }
            });
          }
          return value;
        },
      };
    },
  };
  return {
    ns: gated,
    holdReads(n: number) {
      armed = { n, arrived: [] };
    },
  };
}

/**
 * Two accounts, each signed in once; the first with a second profile. Every
 * route through one `createApp` over the Durable Object stand-in.
 */
async function harness() {
  const fake = createFakeNamespace();
  const reads = gatedReads(fake.ns);
  const { layer, sqlite } = createTestLayerWithSqlite();
  const built = await buildAppDeps(env, {
    coordination: (onError) => createDurableCoordination(reads.ns, onError),
    dbAndEmailLayer: layer,
    observabilityLayer: osnLoggerLayer,
    includeObservabilityPlugin: false,
  });
  const app = createApp(built.deps);
  // Mints step-up tokens and sessions; never verifies one, so its own
  // in-memory stores never stand in for the app's.
  const auth = createAuthService(built.deps.authConfig);
  const run = <A, E>(effect: Effect.Effect<A, E, Db>) =>
    Effect.runPromise(effect.pipe(Effect.provide(layer)) as Effect.Effect<A, E>);

  const signIn = async (email: string, handle: string) => {
    const profile = await run(auth.registerProfile(email, handle));
    const tokens = await run(
      auth.issueTokens(
        profile.id,
        profile.accountId,
        profile.email,
        profile.handle,
        profile.displayName,
      ),
    );
    const live = await run(
      auth.resolveLiveOrdinarySession(profile.accountId, profile.id, {
        cookieSessionHash: auth.hashSessionToken(tokens.refreshToken),
        sessionBinding: null,
      }),
    );
    if (!live) throw new Error("the signed-in session is not live");
    return {
      ...profile,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      minting: { accountId: profile.accountId, familyId: live.familyId },
    };
  };

  const a = await signIn("person@example.com", "person");
  const b = await signIn("someone@example.com", "someone");
  const aSecond = "usr_person_second";
  sqlite.run(
    "INSERT INTO users (id, account_id, handle, display_name, is_default, created_at, updated_at) VALUES (?, ?, ?, NULL, 0, ?, ?)",
    [aSecond, a.accountId, "person_second", nowSec(), nowSec()],
  );

  const cireArc = await arcCaller(run, "cire-api");
  const pulseArc = await arcCaller(run, "pulse-api");
  const zapArc = await arcCaller(run, "zap-api");

  type Arc = () => Promise<string>;
  const internal = async (path: string, arc: Arc, body: unknown) =>
    app.handle(
      new Request(`http://localhost/internal${path}`, {
        method: "POST",
        headers: { authorization: `ARC ${await arc()}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  const begin = (
    body: { profile_id: string; binding: string; return_to?: string },
    arc: Arc = cireArc,
  ) =>
    internal("/step-up/requests", arc, {
      purpose: "cire_app_delete",
      return_to: RETURN_TO,
      ...body,
    });
  const verify = (
    body: { profile_id: string; request: { id: string; binding: string; code: string } },
    arc: Arc = cireArc,
  ) => internal("/step-up/verify", arc, { purpose: "cire_app_delete", ...body });
  const read = (id: string, accessToken: string) =>
    app.handle(
      new Request(`http://localhost/step-up/requests/${id}`, {
        headers: { "x-forwarded-for": IP, authorization: `Bearer ${accessToken}` },
      }),
    );
  const confirm = (id: string, accessToken: string, stepUpToken: string) =>
    app.handle(
      new Request(`http://localhost/step-up/requests/${id}/confirm`, {
        method: "POST",
        headers: {
          "x-forwarded-for": IP,
          origin: ORIGIN,
          authorization: `Bearer ${accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ step_up_token: stepUpToken }),
      }),
    );
  /**
   * A step-up token of `who` for `purpose`. By default a passkey's, asserted by
   * a credential the account has held for a month, which every app-data gate
   * admits; `asserting: null` mints one that names no credential.
   */
  const stepUpToken = (
    who: typeof a,
    purpose: AppDataPurpose,
    factor: StepUpFactor = "passkey",
    asserting?: AssertingCredential | null,
  ) =>
    run(
      auth.issueStepUpToken(
        who.minting,
        factor,
        purpose,
        asserting === null
          ? undefined
          : (asserting ?? (factor === "passkey" ? heldForAMonth() : undefined)),
      ),
    );
  /** Pulse's or Zap's purpose, spent as a token by that app for `a`'s profile. */
  const spend = (purpose: "pulse_app_delete" | "zap_app_delete", token: string) =>
    internal("/step-up/verify", purpose === "pulse_app_delete" ? pulseArc : zapArc, {
      purpose,
      profile_id: a.id,
      token,
    });

  /** Begins a request for `who` and answers its id and the browser's secret. */
  const begun = async (who: { id: string } = a) => {
    const s = secret();
    const res = await begin({ profile_id: who.id, binding: sha256(s) });
    expect(res.status).toBe(200);
    const { request_id } = (await res.json()) as { request_id: string };
    return { id: request_id, secret: s };
  };

  /** Begins and confirms a request for `a`; answers its id, secret and code. */
  const confirmed = async () => {
    const { id, secret: s } = await begun();
    const res = await confirm(id, a.accessToken, await stepUpToken(a, "cire_app_delete"));
    expect(res.status).toBe(200);
    const { return_to } = (await res.json()) as { return_to: string };
    const url = new URL(return_to);
    const code = new URLSearchParams(url.hash.split("?")[1] ?? "").get("code");
    if (!code) throw new Error("no code on the return address");
    return { id, secret: s, code, returnTo: return_to };
  };

  return {
    app,
    auth,
    fake,
    holdReads: reads.holdReads,
    sqlite,
    run,
    a,
    b,
    aSecond,
    cireArc,
    pulseArc,
    begin,
    verify,
    read,
    confirm,
    stepUpToken,
    spend,
    begun,
    confirmed,
  };
}

type AppDataPurpose = "cire_app_delete" | "pulse_app_delete" | "zap_app_delete";

/** How long a passkey added by emailed link, authenticator code or recovery is held. */
const HOLD_S = 72 * 60 * 60;

/** The two factors an app-data gate refuses outright, as a test names them. */
const STEP_UP_BY = {
  otp: "an emailed-link step-up",
  totp: "an authenticator-code step-up",
} as const;

/** A credential the account has held for a month, with full standing. */
const heldForAMonth = (): AssertingCredential => ({
  id: "pk_aaaaaaaaaaaa",
  provenance: "webauthn",
  createdAt: nowSec() - 30 * 24 * 60 * 60,
});

const callsOn = (fake: FakeNamespace, store: string) =>
  fake.calls.filter((call) => call.store === store).map((call) => call.op);

describe("the return address an app's request may name", () => {
  it("is the configured portal origin, and on a deployed tier with none there is no return at all", () => {
    // Red on a check by scheme alone: anyone holding cire-api's ARC key could
    // send a confirmation's code to an origin of their own.
    const configured = appStepUpReturnConfig({
      OSN_ENV: "production",
      CIRE_ORGANISER_ORIGIN: "https://host.example",
    });
    expect(
      returnToAdmitted(configured, "cire_app_delete", "https://host.example/#/remove-data"),
    ).toBe("ok");
    expect(
      returnToAdmitted(configured, "cire_app_delete", "https://evil.example/#/remove-data"),
    ).toBe("refused");
    expect(returnToAdmitted(configured, "cire_app_delete", "not a url")).toBe("refused");

    const deployedWithNone = appStepUpReturnConfig({ OSN_ENV: "production" });
    expect(
      returnToAdmitted(deployedWithNone, "cire_app_delete", "https://host.example/#/remove-data"),
    ).toBe("unavailable");

    const localWithNone = appStepUpReturnConfig({ OSN_ENV: "local" });
    expect(returnToAdmitted(localWithNone, "cire_app_delete", "http://localhost:4322/#/")).toBe(
      "ok",
    );
    expect(returnToAdmitted(localWithNone, "cire_app_delete", "http://example.com/#/")).toBe(
      "refused",
    );
  });

  it("refuses a configured origin that is not https on a deployed tier", () => {
    expect(() =>
      appStepUpReturnConfig({
        OSN_ENV: "production",
        CIRE_ORGANISER_ORIGIN: "http://host.example",
      }),
    ).toThrow(/CIRE_ORGANISER_ORIGIN/);
  });
});

describe("POST /internal/step-up/requests", () => {
  it("refuses another service, an unknown profile, a pending deletion and a foreign return address, storing nothing", async () => {
    const h = await harness();
    const binding = sha256(secret());

    const otherService = await h.begin({ profile_id: h.a.id, binding }, h.pulseArc);
    expect(otherService.status).toBe(401);

    const unknown = await h.begin({ profile_id: "usr_000000000000", binding });
    expect(unknown.status).toBe(404);

    const foreign = await h.begin({
      profile_id: h.a.id,
      binding,
      return_to: "https://evil.example/#/remove-data",
    });
    expect({ status: foreign.status, body: await foreign.json() }).toEqual({
      status: 400,
      body: { error: "return_to_refused" },
    });

    h.sqlite.run("UPDATE accounts SET deleted_at = ? WHERE id = ?", [
      Math.floor(Date.now() / 1000),
      h.b.accountId,
    ]);
    const pending = await h.begin({ profile_id: h.b.id, binding });
    expect(pending.status).toBe(404);

    expect(callsOn(h.fake, "app_step_up")).toEqual([]);
  });

  it("refuses a call with no ARC token, and a binding that is not a SHA-256, storing nothing", async () => {
    const h = await harness();
    const withoutArc = (headers: Record<string, string>) =>
      h.app.handle(
        new Request("http://localhost/internal/step-up/requests", {
          method: "POST",
          headers: { "content-type": "application/json", ...headers },
          body: JSON.stringify({
            purpose: "cire_app_delete",
            profile_id: h.a.id,
            binding: sha256(secret()),
            return_to: RETURN_TO,
          }),
        }),
      );
    // Refused before the route runs: no ARC token, no request. Sent from the
    // allowed origin, so the ARC check is what refuses it; sent from no origin
    // at all, the origin guard refuses it first.
    const noToken = await withoutArc({ origin: ORIGIN });
    expect(noToken.ok).toBe(false);
    expect(noToken.status).toBe(401);
    expect((await withoutArc({})).status).toBe(403);
    // Refused by the body schema's SHA-256 pattern.
    for (const binding of ["", "z".repeat(64), sha256(secret()).toUpperCase(), "a".repeat(63)]) {
      const res = await h.begin({ profile_id: h.a.id, binding });
      expect({ binding, ok: res.ok }).toEqual({ binding, ok: false });
      expect({ binding, status: res.status }).toEqual({ binding, status: 422 });
    }
    expect(callsOn(h.fake, "app_step_up")).toEqual([]);
  });
});

describe("GET /step-up/requests/:id and POST …/confirm", () => {
  it("answer another account's session 404, and leave the request pending", async () => {
    const h = await harness();
    const { id } = await h.begun();

    expect((await h.read(id, h.b.accessToken)).status).toBe(404);
    const refused = await h.confirm(
      id,
      h.b.accessToken,
      await h.stepUpToken(h.b, "cire_app_delete"),
    );
    expect(refused.status).toBe(404);

    const mine = await h.read(id, h.a.accessToken);
    expect({ status: mine.status, body: await mine.json() }).toEqual({
      status: 200,
      body: { purpose: "cire_app_delete", return_host: "localhost:4322" },
    });
  });

  it("answer a session of an account whose deletion is pending 404, even for its own request", async () => {
    // Red on letting the window's session confirm: a deletion that is pending
    // must change nothing in an app, so a cancel loses nothing.
    const h = await harness();
    const { id } = await h.begun();
    const now = nowSec();
    h.sqlite.run("UPDATE accounts SET deleted_at = ? WHERE id = ?", [now, h.a.accountId]);
    h.sqlite.run(
      "INSERT INTO deletion_jobs (account_id, soft_deleted_at, hard_delete_at) VALUES (?, ?, ?)",
      [h.a.accountId, now, now + 7 * 24 * 60 * 60],
    );
    const refreshed = await h.app.handle(
      new Request("http://localhost/token", {
        method: "POST",
        headers: {
          "x-forwarded-for": IP,
          origin: ORIGIN,
          "content-type": "application/json",
          cookie: buildSessionCookies(h.a.refreshToken, { secure: false })
            .map((c) => c.split(";")[0])
            .join("; "),
        },
        body: JSON.stringify({ grant_type: "refresh_token" }),
      }),
    );
    expect(refreshed.status).toBe(200);
    const { access_token: pending } = (await refreshed.json()) as { access_token: string };

    expect((await h.read(id, pending)).status).toBe(404);
    const token = await h.stepUpToken(h.a, "cire_app_delete");
    expect((await h.confirm(id, pending, token)).status).toBe(404);
  });

  it("refuse a step-up token of another purpose, or one already spent, and leave the request pending", async () => {
    const h = await harness();
    const { id } = await h.begun();

    const wrongPurpose = await h.confirm(
      id,
      h.a.accessToken,
      await h.stepUpToken(h.a, "pulse_app_delete"),
    );
    expect(wrongPurpose.status).toBe(403);

    // Spent on a request of its own first.
    const token = await h.stepUpToken(h.a, "cire_app_delete");
    const other = await h.begun();
    expect((await h.confirm(other.id, h.a.accessToken, token)).status).toBe(200);
    const spent = await h.confirm(id, h.a.accessToken, token);
    expect(spent.status).toBe(403);

    expect((await h.read(id, h.a.accessToken)).status).toBe(200);
  });

  it("of two confirms at once, one wins and the other finds no pending request", async () => {
    // Red on writing the confirmed state without comparing it to what was
    // read: both would answer a code, and the second would replace the first.
    // Both confirms read the pending request before either writes: the reads
    // are held until both have arrived.
    const h = await harness();
    const { id } = await h.begun();
    const [t1, t2] = await Promise.all([
      h.stepUpToken(h.a, "cire_app_delete"),
      h.stepUpToken(h.a, "cire_app_delete"),
    ]);
    h.holdReads(2);
    const [first, second] = await Promise.all([
      h.confirm(id, h.a.accessToken, t1),
      h.confirm(id, h.a.accessToken, t2),
    ]);
    expect([first.status, second.status].toSorted()).toEqual([200, 404]);
  });

  it("refuse a missing or malformed access token", async () => {
    const h = await harness();
    const { id } = await h.begun();
    for (const token of ["", "not-a-jwt"]) {
      expect((await h.read(id, token)).status).toBe(401);
      expect((await h.confirm(id, token, "x")).status).toBe(401);
    }
    expect((await h.read(id, h.a.accessToken)).status).toBe(200);
  });

  it("send the person back to the request's own address with a code on its fragment", async () => {
    const h = await harness();
    const { id, returnTo, code } = await h.confirmed();
    const url = new URL(returnTo);
    expect(url.origin).toBe(PORTAL);
    expect(url.hash).toBe(`#/remove-data?code=${code}`);
    expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // A confirmed request is no longer pending: Musubi cannot confirm it twice.
    const again = await h.confirm(id, h.a.accessToken, await h.stepUpToken(h.a, "cire_app_delete"));
    expect(again.status).toBe(404);
    expect((await h.read(id, h.a.accessToken)).status).toBe(404);
  });
});

describe("POST /internal/step-up/verify, for an app's request", () => {
  it("answers the account and every profile of it once confirmed, and again: it spends nothing", async () => {
    const h = await harness();
    const { id, secret: s, code } = await h.confirmed();
    const body = { profile_id: h.a.id, request: { id, binding: sha256(s), code } };

    for (let i = 0; i < 2; i++) {
      const res = await h.verify(body);
      const answer = (await res.json()) as {
        ok: boolean;
        account_id: string;
        profile_ids: string[];
      };
      expect(answer.ok).toBe(true);
      expect(answer.account_id).toBe(h.a.accountId);
      expect(answer.profile_ids.toSorted()).toEqual([h.a.id, h.aSecond].toSorted());
    }
  });

  it("refuses before confirmation, with a wrong code or binding, for another account's profile, and for another service", async () => {
    const h = await harness();
    const pending = await h.begun();
    expect(
      await (
        await h.verify({
          profile_id: h.a.id,
          request: { id: pending.id, binding: sha256(pending.secret), code: secret() },
        })
      ).json(),
    ).toEqual({ ok: false, reason: "invalid" });

    const { id, secret: s, code } = await h.confirmed();
    const cases = [
      { profile_id: h.a.id, request: { id, binding: sha256(s), code: secret() } },
      { profile_id: h.a.id, request: { id, binding: sha256(secret()), code } },
      { profile_id: h.b.id, request: { id, binding: sha256(s), code } },
    ];
    for (const body of cases) {
      expect(await (await h.verify(body)).json()).toEqual({ ok: false, reason: "invalid" });
    }
    expect(
      await (
        await h.verify(
          { profile_id: h.a.id, request: { id, binding: sha256(s), code } },
          h.pulseArc,
        )
      ).json(),
    ).toEqual({ ok: false, reason: "invalid" });

    // None of it spent the request.
    expect(
      (
        (await (
          await h.verify({ profile_id: h.a.id, request: { id, binding: sha256(s), code } })
        ).json()) as {
          ok: boolean;
        }
      ).ok,
    ).toBe(true);
  });

  it("refuses once the account's deletion is pending, once the confirming session has ended, and after five minutes", async () => {
    const pendingDeletion = await harness();
    {
      const h = pendingDeletion;
      const { id, secret: s, code } = await h.confirmed();
      h.sqlite.run("UPDATE accounts SET deleted_at = ? WHERE id = ?", [
        Math.floor(Date.now() / 1000),
        h.a.accountId,
      ]);
      expect(
        await (
          await h.verify({ profile_id: h.a.id, request: { id, binding: sha256(s), code } })
        ).json(),
      ).toEqual({ ok: false, reason: "invalid" });
    }

    const signedOut = await harness();
    {
      const h = signedOut;
      const { id, secret: s, code } = await h.confirmed();
      await h.run(h.auth.invalidateSession(h.a.refreshToken));
      expect(
        await (
          await h.verify({ profile_id: h.a.id, request: { id, binding: sha256(s), code } })
        ).json(),
      ).toEqual({ ok: false, reason: "invalid" });
    }

    const late = await harness();
    {
      const h = late;
      const { id, secret: s, code } = await h.confirmed();
      vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 5 * 60_000 + 1_000 });
      expect(
        await (
          await h.verify({ profile_id: h.a.id, request: { id, binding: sha256(s), code } })
        ).json(),
      ).toEqual({ ok: false, reason: "invalid" });
    }
  });

  it("refuses cire's purpose sent with a token and no request, and a Pulse purpose sent with a request", async () => {
    const h = await harness();
    const token = await h.stepUpToken(h.a, "cire_app_delete");
    const asToken = await h.app.handle(
      new Request("http://localhost/internal/step-up/verify", {
        method: "POST",
        headers: { authorization: `ARC ${await h.cireArc()}`, "content-type": "application/json" },
        body: JSON.stringify({ purpose: "cire_app_delete", profile_id: h.a.id, token }),
      }),
    );
    expect(await asToken.json()).toEqual({ ok: false, reason: "invalid" });

    const { id, secret: s, code } = await h.confirmed();
    const asRequest = await h.app.handle(
      new Request("http://localhost/internal/step-up/verify", {
        method: "POST",
        headers: { authorization: `ARC ${await h.pulseArc()}`, "content-type": "application/json" },
        body: JSON.stringify({
          purpose: "pulse_app_delete",
          profile_id: h.a.id,
          request: { id, binding: sha256(s), code },
        }),
      }),
    );
    expect(await asRequest.json()).toEqual({ ok: false, reason: "invalid" });
  });
});

// Removing an app's data takes a passkey that is past its hold. An emailed link
// or an authenticator code is refused for every app-data purpose, and so is a
// passkey added under one of them or by recovery, until it is 72 hours old:
// otherwise whoever holds the mailbox or the authenticator seed could add a
// passkey of their own and remove the data at once. Pulse's and Zap's purposes
// are spent as a token at `/internal/step-up/verify`, cire's through a request
// confirmed on Musubi. A refusal spends nothing.
describe("removing an app's data takes a passkey past its hold", () => {
  for (const purpose of ["pulse_app_delete", "zap_app_delete"] as const) {
    for (const factor of ["otp", "totp"] as const) {
      it(`refuses ${purpose} to ${STEP_UP_BY[factor]}, and claims nothing`, async () => {
        const h = await harness();
        const res = await h.spend(purpose, await h.stepUpToken(h.a, purpose, factor));
        expect(await res.json()).toEqual({ ok: false, reason: "invalid" });
        expect(callsOn(h.fake, "step_up_jti")).toEqual([]);
      });
    }
  }

  it("admits zap_app_delete for a passkey the account has held", async () => {
    // Red on the gate refusing every factor: Zap could never remove anyone's data.
    const h = await harness();
    const res = await h.spend("zap_app_delete", await h.stepUpToken(h.a, "zap_app_delete"));
    expect(await res.json()).toEqual({ ok: true, account_id: h.a.accountId });
  });

  for (const factor of ["otp", "totp"] as const) {
    it(`refuses cire's confirm to ${STEP_UP_BY[factor]}, and leaves the request pending`, async () => {
      const h = await harness();
      const { id } = await h.begun();
      const res = await h.confirm(
        id,
        h.a.accessToken,
        await h.stepUpToken(h.a, "cire_app_delete", factor),
      );
      expect({ status: res.status, body: await res.json() }).toEqual({
        status: 403,
        body: { error: "step_up_required" },
      });
      expect(callsOn(h.fake, "step_up_jti")).toEqual([]);
      const passkey = await h.stepUpToken(h.a, "cire_app_delete");
      expect((await h.confirm(id, h.a.accessToken, passkey)).status).toBe(200);
    });
  }

  for (const provenance of ["otp", "totp", "recovery"] as const) {
    it(`holds cire's confirm from a passkey added by ${provenance} until it is 72 hours old`, async () => {
      const h = await harness();
      const { id } = await h.begun();
      const made = nowSec();
      const fresh = await h.stepUpToken(h.a, "cire_app_delete", "passkey", {
        id: "pk_bbbbbbbbbbbb",
        provenance,
        createdAt: made,
      });
      const res = await h.confirm(id, h.a.accessToken, fresh);
      expect({ status: res.status, body: await res.json() }).toEqual({
        status: 403,
        body: { error: "passkey_held", hold_ends_at: made + HOLD_S },
      });
      expect(callsOn(h.fake, "step_up_jti")).toEqual([]);
      // Still pending: a passkey the account has held confirms it.
      const held = await h.stepUpToken(h.a, "cire_app_delete");
      expect((await h.confirm(id, h.a.accessToken, held)).status).toBe(200);
    });
  }

  it("still holds cire's confirm a minute before a passkey's 72 hours are over", async () => {
    // Red on a hold shorter than the 72 hours `hold_ends_at` reports.
    const h = await harness();
    const { id } = await h.begun();
    const made = nowSec() - HOLD_S + 60;
    const token = await h.stepUpToken(h.a, "cire_app_delete", "passkey", {
      id: "pk_bbbbbbbbbbbb",
      provenance: "otp",
      createdAt: made,
    });
    const res = await h.confirm(id, h.a.accessToken, token);
    expect({ status: res.status, body: await res.json() }).toEqual({
      status: 403,
      body: { error: "passkey_held", hold_ends_at: made + HOLD_S },
    });
  });

  it("admits cire's confirm from a passkey added by emailed link once its 72 hours are over", async () => {
    // Red on a hold that counts from anything but the passkey's own creation.
    const h = await harness();
    const { id } = await h.begun();
    const token = await h.stepUpToken(h.a, "cire_app_delete", "passkey", {
      id: "pk_bbbbbbbbbbbb",
      provenance: "otp",
      createdAt: nowSec() - HOLD_S - 1,
    });
    expect((await h.confirm(id, h.a.accessToken, token)).status).toBe(200);
  });

  it("refuses cire's confirm to a passkey step-up that names no credential, as no hold", async () => {
    // A rule that read a missing claim as "no hold" would be no rule at all.
    const h = await harness();
    const { id } = await h.begun();
    const token = await h.stepUpToken(h.a, "cire_app_delete", "passkey", null);
    const res = await h.confirm(id, h.a.accessToken, token);
    expect({ status: res.status, body: await res.json() }).toEqual({
      status: 403,
      body: { error: "step_up_required" },
    });
  });

  for (const [purpose, provenance] of [
    ["pulse_app_delete", "otp"],
    ["zap_app_delete", "recovery"],
  ] as const) {
    it(`refuses ${purpose} to a passkey added by ${provenance} inside its hold, and claims nothing`, async () => {
      const h = await harness();
      const token = await h.stepUpToken(h.a, purpose, "passkey", {
        id: "pk_bbbbbbbbbbbb",
        provenance,
        createdAt: nowSec(),
      });
      expect(await (await h.spend(purpose, token)).json()).toEqual({
        ok: false,
        reason: "invalid",
      });
      expect(callsOn(h.fake, "step_up_jti")).toEqual([]);
    });
  }
});
