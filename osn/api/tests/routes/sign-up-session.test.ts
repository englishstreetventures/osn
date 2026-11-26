/**
 * The session a completed sign-up hands the tab that began it, before the
 * account has a passkey.
 *
 * `POST /register/:requestId/status` makes the account and answers with a
 * session, but the account has no credential yet: the tab still has to enrol
 * its first passkey. Until it does, the session is a restricted one, as
 * account recovery's is — its access tokens carry `osn-recovery`, which only
 * the passkey-enrolment routes accept, and its cookie is no signed-in session
 * to `/authorize` or to a `/token` grant for anything but itself. It records
 * `signup` rather than a factor, so it takes nobody past the step-up gate,
 * and the passkey it enrols is the account's root of trust (`webauthn`), not
 * a recovery's.
 * Enrolling lifts the restriction, as it does for recovery.
 *
 * `/authorize` with this session's cookie is in `oidc.test.ts`, beside the
 * recovery session's.
 */

import { passkeys, sessions } from "@osn/db/schema";
import { eq } from "drizzle-orm";
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";

import { createGraphRoutes } from "../../src/routes/graph";
import { ACCESS_TOKEN_AUDIENCE, RECOVERY_TOKEN_AUDIENCE } from "../../src/services/auth/constants";
import { makeTestAuthConfig } from "../helpers/auth-config";
import { createTestLayerWithSqlite } from "../helpers/db";
import { registeredResponse } from "../helpers/registration";
// Wrapped factory (trust XFF under app.handle). See helpers/routes.
import { createAuthRoutes } from "../helpers/routes";
import { noneAttestation, type CreationOptions } from "../helpers/soft-authenticator";

/**
 * Every `metricAuthRegisterStep` call, in order. It calls through, so the
 * counter still moves.
 */
const registerSteps = vi.hoisted(() => [] as string[]);
vi.mock("../../src/metrics", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/metrics")>();
  return {
    ...actual,
    metricAuthRegisterStep: (step: string) => {
      registerSteps.push(step);
      actual.metricAuthRegisterStep(step as Parameters<typeof actual.metricAuthRegisterStep>[0]);
    },
  };
});

let config: Awaited<ReturnType<typeof makeTestAuthConfig>>;

beforeAll(async () => {
  config = await makeTestAuthConfig();
});

/** A JWT's `aud`, read without verifying it. */
function audienceOf(jwt: string): unknown {
  return (
    JSON.parse(Buffer.from(jwt.split(".")[1]!, "base64url").toString("utf8")) as { aud?: unknown }
  ).aud;
}

describe("the session a sign-up hands over before its first passkey", () => {
  let harness: ReturnType<typeof createTestLayerWithSqlite>;
  let authApp: ReturnType<typeof createAuthRoutes>;
  let graphApp: ReturnType<typeof createGraphRoutes>;

  beforeEach(() => {
    harness = createTestLayerWithSqlite();
    authApp = createAuthRoutes(config, harness.layer);
    graphApp = createGraphRoutes(config, harness.layer);
  });

  /** A sign-up through the routes, as the tab that began it holds it. */
  async function signedUp(email: string, handle: string) {
    const res = await registeredResponse(authApp, () => harness.email.recorded(), email, handle);
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      profileId: string;
      session: { access_token: string };
    };
    const cookie = res.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
    expect(cookie).toContain("osn_session=");
    const refresh = /osn_session=([^;]+)/.exec(cookie)![1]!;
    return { profileId: body.profileId, accessToken: body.session.access_token, cookie, refresh };
  }

  const accountOf = (profileId: string) =>
    harness.sqlite
      .query<{ account_id: string }, [string]>("SELECT account_id FROM users WHERE id = ?")
      .get(profileId)!.account_id;

  /** `POST /token` with a session cookie, as the browser renews. */
  const grant = (cookie: string) =>
    authApp.handle(
      new Request("http://localhost/token", {
        method: "POST",
        headers: { "Content-Type": "application/json", cookie },
        body: JSON.stringify({ grant_type: "refresh_token" }),
      }),
    );

  /** The passkey-enrolment pair, with the bearer and cookie a tab sends. */
  async function enrol(s: { profileId: string; accessToken: string; cookie: string }) {
    const headers = {
      Authorization: `Bearer ${s.accessToken}`,
      "Content-Type": "application/json",
      cookie: s.cookie,
    };
    const begun = await authApp.handle(
      new Request("http://localhost/passkey/register/begin", {
        method: "POST",
        headers,
        body: JSON.stringify({ profileId: s.profileId }),
      }),
    );
    if (begun.status !== 200) return { begun, completed: null };
    const attestation = await noneAttestation(
      (await begun.json()) as CreationOptions,
      config.origin,
      config.rpId,
    );
    const completed = await authApp.handle(
      new Request("http://localhost/passkey/register/complete", {
        method: "POST",
        headers,
        body: JSON.stringify({ profileId: s.profileId, attestation }),
      }),
    );
    return { begun, completed };
  }

  it("is restricted: its token is on the recovery audience, its row restricted and marked as a sign-up's", async () => {
    const s = await signedUp("su-restricted@example.com", "surestricted");

    expect(audienceOf(s.accessToken)).toBe(RECOVERY_TOKEN_AUDIENCE);
    const row = await harness.db
      .select()
      .from(sessions)
      .where(eq(sessions.accountId, accountOf(s.profileId)))
      .limit(1);
    const nowSec = Math.floor(Date.now() / 1000);
    expect(row[0]?.restrictedUntil).not.toBeNull();
    // Absolute and short: the row's deadline is its restriction's.
    expect(row[0]?.expiresAt).toBe(row[0]?.restrictedUntil);
    expect(row[0]!.restrictedUntil! - nowSec).toBeLessThanOrEqual(15 * 60);
    expect(row[0]!.restrictedUntil! - nowSec).toBeGreaterThan(14 * 60);
    // `signup`, no factor: sign-up proved a mailbox for a new account, not
    // who owns an existing one, so the step-up bypass has nothing to rest on.
    expect(row[0]?.restrictedAmr).toBe("signup");
  });

  it("renews at /token only onto the recovery audience while the account has no passkey", async () => {
    const s = await signedUp("su-token@example.com", "sutoken");

    const granted = await grant(s.cookie);
    expect(granted.status).toBe(200);
    const { access_token } = (await granted.json()) as { access_token: string };
    expect(audienceOf(access_token)).toBe(RECOVERY_TOKEN_AUDIENCE);
  });

  it("reaches no ordinary route", async () => {
    const s = await signedUp("su-graph@example.com", "sugraph");
    const url = "http://localhost/graph/connections";

    const refused = await graphApp.handle(
      new Request(url, { headers: { Authorization: `Bearer ${s.accessToken}` } }),
    );
    expect(refused.status).toBe(401);

    // Nor the step-up ceremonies, which mint the tokens the guarded routes
    // take.
    const stepUp = await authApp.handle(
      new Request("http://localhost/step-up/passkey/begin", {
        method: "POST",
        headers: { Authorization: `Bearer ${s.accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }),
    );
    expect(stepUp.status).toBe(401);

    const switched = await authApp.handle(
      new Request("http://localhost/profiles/switch", {
        method: "POST",
        headers: { Authorization: `Bearer ${s.accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ profile_id: s.profileId }),
      }),
    );
    expect(switched.status).toBe(401);

    // The control: once the passkey is in, the same cookie renews to a token
    // the same route serves, so the 401 above is the restriction.
    const { completed } = await enrol(s);
    expect(completed?.status).toBe(200);
    const { access_token } = (await (await grant(s.cookie)).json()) as { access_token: string };
    const allowed = await graphApp.handle(
      new Request(url, { headers: { Authorization: `Bearer ${access_token}` } }),
    );
    expect(allowed.status).toBe(200);
  });

  it("enrols the first passkey, stamped as the account's own, and enrolling lifts it", async () => {
    const s = await signedUp("su-enrol@example.com", "suenrol");
    registerSteps.length = 0;

    const { begun, completed } = await enrol(s);
    expect(begun.status).toBe(200);
    expect(completed?.status).toBe(200);

    const accountId = accountOf(s.profileId);
    const credential = await harness.db
      .select({ provenanceAmr: passkeys.provenanceAmr })
      .from(passkeys)
      .where(eq(passkeys.accountId, accountId));
    expect(credential).toEqual([{ provenanceAmr: "webauthn" }]);

    const row = await harness.db
      .select({ restrictedUntil: sessions.restrictedUntil })
      .from(sessions)
      .where(eq(sessions.accountId, accountId));
    expect(row).toEqual([{ restrictedUntil: null }]);

    const { access_token } = (await (await grant(s.cookie)).json()) as { access_token: string };
    expect(audienceOf(access_token)).toBe(ACCESS_TOKEN_AUDIENCE);
    // The funnel counts it once, on the sign-up's own enrolment.
    expect(registerSteps).toEqual(["passkey_enroll"]);
  });

  it("stamps the first passkey `recovery` when the restricted row says nothing, never `webauthn`", async () => {
    const s = await signedUp("su-nofactor@example.com", "sunofactor");
    const accountId = accountOf(s.profileId);
    // A restricted row with no recorded value is no sign-up's: an absent value
    // must not earn the account's own root-of-trust stamp.
    harness.sqlite.run("UPDATE sessions SET restricted_amr = NULL WHERE account_id = ?", [
      accountId,
    ]);
    registerSteps.length = 0;

    const { completed } = await enrol(s);
    expect(completed?.status).toBe(200);
    // Not a sign-up's enrolment, so the funnel does not count it.
    expect(registerSteps).toEqual([]);
    const credential = await harness.db
      .select({ provenanceAmr: passkeys.provenanceAmr })
      .from(passkeys)
      .where(eq(passkeys.accountId, accountId));
    expect(credential).toEqual([{ provenanceAmr: "recovery" }]);
  });

  it("takes nobody past the step-up gate once the account holds a passkey", async () => {
    const s = await signedUp("su-gate@example.com", "sugate");
    const accountId = accountOf(s.profileId);
    // A passkey the session did not enrol, with the session still restricted:
    // a second ceremony from it must need a step-up like any other.
    await harness.db.insert(passkeys).values({
      id: "pk_sugate_seeded",
      accountId,
      credentialId: "su-gate-seeded-credential",
      publicKey: "AQIDBA==",
      counter: 0,
      transports: null,
      createdAt: new Date(),
      label: null,
      lastUsedAt: null,
      aaguid: null,
      backupEligible: false,
      backupState: false,
      updatedAt: Math.floor(Date.now() / 1000),
    });

    const { begun } = await enrol(s);
    expect(begun.status).toBe(400);
    expect(((await begun.json()) as { error?: string }).error).toBe("invalid_request");
    const count = await harness.db
      .select({ id: passkeys.id })
      .from(passkeys)
      .where(eq(passkeys.accountId, accountId));
    expect(count).toHaveLength(1);
  });
});
