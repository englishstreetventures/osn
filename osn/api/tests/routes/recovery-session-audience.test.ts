/**
 * Route-level pins on the `osn-recovery` audience.
 *
 * The service-level tests prove `verifyAccessToken` rejects the audience. These
 * prove the rejection actually reaches the wire at every route that could turn a
 * restricted session into something more, and that the two routes which DO
 * accept it accept it for the right reason.
 *
 * Every test carries an ordinary-access-token control, because a 401 is also
 * what a broken harness returns.
 *
 * See `wiki/architecture/account-recovery-factors.md` §B.
 */

import { passkeys, sessions } from "@osn/db/schema";
import type { Db } from "@osn/db/service";
import { eq } from "drizzle-orm";
import { Effect } from "effect";
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";

import { buildSessionCookies } from "../../src/lib/cookie-session";
import { createGraphRoutes } from "../../src/routes/graph";
import { createOrganisationRoutes } from "../../src/routes/organisation";
import { createRecommendationRoutes } from "../../src/routes/recommendations";
import { createAuthService } from "../../src/services/auth";
import { ACCESS_TOKEN_AUDIENCE } from "../../src/services/auth/constants";
import { makeTestAuthConfig } from "../helpers/auth-config";
import { createTestLayerWithSqlite } from "../helpers/db";
// Wrapped factory (trust XFF under app.handle). See helpers/routes.
import { createAuthRoutes } from "../helpers/routes";

// `/passkey/register/complete` runs a real WebAuthn attestation through
// `@simplewebauthn/server`, which no route test can produce. Only the verifier
// is stubbed, so `/begin` still plants a real challenge and the route composition
// under test — principal, caller classification, lift — is untouched.
vi.mock("@simplewebauthn/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@simplewebauthn/server")>();
  return {
    ...actual,
    verifyRegistrationResponse: vi.fn(async () => ({
      verified: true,
      registrationInfo: {
        credential: {
          id: `cred-${Math.random().toString(16).slice(2, 10)}`,
          publicKey: new Uint8Array([1, 2, 3, 4]),
          counter: 0,
          transports: undefined,
        },
        aaguid: "00000000-0000-0000-0000-000000000000",
        credentialBackedUp: false,
        credentialDeviceType: "singleDevice",
      },
    })),
  };
});

/** Matches the route factories' default: no TLS locally, so no `__Host-` prefix. */
const COOKIE_CONFIG = { secure: false } as const;

/** The body `/passkey/register/complete` takes; the attestation is stubbed above. */
const FAKE_ATTESTATION = {
  id: "x",
  rawId: "x",
  response: {},
  type: "public-key",
  clientExtensionResults: {},
};

let config: Awaited<ReturnType<typeof makeTestAuthConfig>>;

beforeAll(async () => {
  config = await makeTestAuthConfig();
});

describe("the osn-recovery audience at the route boundary", () => {
  let layer: ReturnType<typeof createTestLayerWithSqlite>["layer"];
  let db: ReturnType<typeof createTestLayerWithSqlite>["db"];
  let auth: ReturnType<typeof createAuthService>;
  let authApp: ReturnType<typeof createAuthRoutes>;
  let graphApp: ReturnType<typeof createGraphRoutes>;
  let orgApp: ReturnType<typeof createOrganisationRoutes>;
  let recsApp: ReturnType<typeof createRecommendationRoutes>;

  beforeEach(() => {
    const harness = createTestLayerWithSqlite();
    layer = harness.layer;
    db = harness.db;
    auth = createAuthService(config);
    authApp = createAuthRoutes(config, layer);
    graphApp = createGraphRoutes(config, layer);
    orgApp = createOrganisationRoutes(config, layer);
    recsApp = createRecommendationRoutes(config, layer);
  });

  const runWithLayer = <A>(eff: Effect.Effect<A, unknown, Db>): Promise<A> =>
    Effect.runPromise(eff.pipe(Effect.provide(layer)) as Effect.Effect<A, never, never>);

  /** An account holding both kinds of token, so every test has its own control. */
  async function tokensFor(email: string, handle: string) {
    const user = await runWithLayer(auth.registerProfile(email, handle));
    const ordinary = await runWithLayer(
      auth.issueTokens(user.id, user.accountId, user.email, user.handle, user.displayName),
    );
    const restricted = await runWithLayer(
      auth.issueRecoverySession(
        user.id,
        user.accountId,
        user.email,
        user.handle,
        user.displayName,
        "otp",
      ),
    );
    return {
      user,
      ordinary: ordinary.accessToken,
      restricted: restricted.accessToken,
      // The opaque half of the recovery session, for the routes that need the
      // cookie as well as the bearer.
      restrictedRefresh: restricted.refreshToken,
    };
  }

  /** The `Cookie` header a recovery route's `Set-Cookie` produces. */
  const cookieHeaderFor = (refreshToken: string): string =>
    buildSessionCookies(refreshToken, COOKIE_CONFIG)
      .map((c) => c.split(";")[0])
      .join("; ");

  /** Seeds one credential, so the account is past the step-up gate's trigger. */
  const seedPasskey = (accountId: string, id: string, credentialId: string) =>
    runWithLayer(
      Effect.promise(() =>
        db.insert(passkeys).values({
          id,
          accountId,
          credentialId,
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
        }),
      ),
    );

  // ---------------------------------------------------------------------------
  // The three routes that call `verifyAccessToken` directly rather than through
  // `resolveAccessTokenPrincipal`. Each is its own copy of the check, so each
  // is its own way to fail open.
  // ---------------------------------------------------------------------------

  it("graph refuses a recovery bearer", async () => {
    const { ordinary, restricted } = await tokensFor("ra-graph@example.com", "ragraph");
    const url = "http://localhost/graph/connections";

    const refused = await graphApp.handle(
      new Request(url, { headers: { Authorization: `Bearer ${restricted}` } }),
    );
    expect(refused.status).toBe(401);

    const allowed = await graphApp.handle(
      new Request(url, { headers: { Authorization: `Bearer ${ordinary}` } }),
    );
    expect(allowed.status).toBe(200);
  });

  it("organisation refuses a recovery bearer", async () => {
    const { ordinary, restricted } = await tokensFor("ra-org@example.com", "raorg");
    const url = "http://localhost/organisations";

    const refused = await orgApp.handle(
      new Request(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${restricted}`, "Content-Type": "application/json" },
        body: JSON.stringify({ handle: "ra_org_one", name: "Org One" }),
      }),
    );
    expect(refused.status).toBe(401);

    const allowed = await orgApp.handle(
      new Request(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${ordinary}`, "Content-Type": "application/json" },
        body: JSON.stringify({ handle: "ra_org_two", name: "Org Two" }),
      }),
    );
    expect(allowed.status).toBe(201);
  });

  it("recommendations refuses a recovery bearer", async () => {
    const { ordinary, restricted } = await tokensFor("ra-recs@example.com", "rarecs");
    const url = "http://localhost/recommendations/connections";

    const refused = await recsApp.handle(
      new Request(url, { headers: { Authorization: `Bearer ${restricted}` } }),
    );
    expect(refused.status).toBe(401);

    const allowed = await recsApp.handle(
      new Request(url, { headers: { Authorization: `Bearer ${ordinary}` } }),
    );
    expect(allowed.status).toBe(200);
  });

  // ---------------------------------------------------------------------------
  // The two routes that re-mint. These matter most: both turn one credential
  // into another, so accepting the recovery audience at either would launder a
  // restricted session into a full one in a single call.
  // ---------------------------------------------------------------------------

  it("POST /profiles/switch refuses a recovery bearer", async () => {
    // It mints a fresh access token on the ORDINARY audience from whatever
    // token authenticated the call — so this gate is the only thing between a
    // recovery token and a full one.
    const { user, ordinary, restricted } = await tokensFor("ra-switch@example.com", "raswitch");
    const body = JSON.stringify({ profile_id: user.id });

    const refused = await authApp.handle(
      new Request("http://localhost/profiles/switch", {
        method: "POST",
        headers: { Authorization: `Bearer ${restricted}`, "Content-Type": "application/json" },
        body,
      }),
    );
    expect(refused.status).toBe(401);

    const allowed = await authApp.handle(
      new Request("http://localhost/profiles/switch", {
        method: "POST",
        headers: { Authorization: `Bearer ${ordinary}`, "Content-Type": "application/json" },
        body,
      }),
    );
    expect(allowed.status).toBe(200);
  });

  it("POST /login/cross-device/:id/approve refuses a recovery bearer", async () => {
    // The worst of the two. Approval issues a full, unrestricted session for
    // ANOTHER device, so without this gate a restricted session becomes an
    // unrestricted one on hardware of the caller's choosing.
    const { ordinary, restricted } = await tokensFor("ra-cdl@example.com", "racdl");

    const begun = await authApp.handle(
      new Request("http://localhost/login/cross-device/begin", { method: "POST" }),
    );
    // The wire field is `cdlSecret` (it matches the log-redaction deny-list);
    // the approve body calls it `secret`. Reading the wrong one produces a 422
    // from body validation BEFORE the auth check, which would make this test
    // pass for a reason that has nothing to do with the audience.
    const { requestId, cdlSecret } = (await begun.json()) as {
      requestId: string;
      cdlSecret: string;
    };
    expect(typeof cdlSecret).toBe("string");
    const url = `http://localhost/login/cross-device/${requestId}/approve`;
    const secret = cdlSecret;

    const refused = await authApp.handle(
      new Request(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${restricted}`, "Content-Type": "application/json" },
        body: JSON.stringify({ secret }),
      }),
    );
    expect(refused.status).toBe(401);

    const allowed = await authApp.handle(
      new Request(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${ordinary}`, "Content-Type": "application/json" },
        body: JSON.stringify({ secret }),
      }),
    );
    expect(allowed.status).toBe(200);
  });

  // ---------------------------------------------------------------------------
  // The one place the audience IS accepted.
  // ---------------------------------------------------------------------------

  it("/passkey/register/begin takes a recovery bearer past the step-up gate", async () => {
    const { user, ordinary, restricted } = await tokensFor("ra-enrol@example.com", "raenrol");
    // Losing the phone does not delete its passkey row, so the account still
    // holds a credential — the common recovery case, and the one the step-up
    // gate would otherwise make unrecoverable.
    await seedPasskey(user.accountId, "pk_raenrol00001", "ra-enrol-credential");
    const url = "http://localhost/passkey/register/begin";
    const body = JSON.stringify({ profileId: user.id });

    // An ordinary token with no step-up token is refused: "Step-up required" is
    // an AuthError, which `publicError` maps to 400 invalid_request.
    const refused = await authApp.handle(
      new Request(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${ordinary}`, "Content-Type": "application/json" },
        body,
      }),
    );
    expect(refused.status).toBe(400);

    const allowed = await authApp.handle(
      new Request(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${restricted}`, "Content-Type": "application/json" },
        body,
      }),
    );
    expect(allowed.status).toBe(200);
    expect((await allowed.json()) as { challenge?: string }).toHaveProperty("challenge");
  });

  it("a recovery bearer still cannot reach the step-up ceremony it bypasses", async () => {
    // The bypass must not be reachable as a general privilege. If a restricted
    // session could mint a step-up token it would reach /recovery/generate,
    // DELETE /account, GET /account/export and /account/email/complete — every
    // route the restriction exists to prevent.
    const { user, ordinary, restricted } = await tokensFor("ra-stepup@example.com", "rastepup");
    // The ceremony needs a credential to challenge, so the control is only a
    // control once the account holds one — otherwise it answers "no passkeys
    // registered" and proves nothing about the audience.
    await seedPasskey(user.accountId, "pk_rastepup0001", "ra-stepup-credential");
    const url = "http://localhost/step-up/passkey/begin";

    const refused = await authApp.handle(
      new Request(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${restricted}`, "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }),
    );
    expect(refused.status).toBe(401);

    const allowed = await authApp.handle(
      new Request(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${ordinary}`, "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }),
    );
    // An exact status, and the ceremony options with it. `not.toBe(401)` also
    // passes on 400, 429 and 500, so it never proved the ordinary token gets a
    // working step-up ceremony — only that it failed differently.
    expect(allowed.status).toBe(200);
    const options = (await allowed.json()) as {
      options?: { challenge?: string; allowCredentials?: { id: string }[] };
    };
    expect(options.options?.challenge).toBeTruthy();
    expect(options.options?.allowCredentials?.map((c) => c.id)).toEqual(["ra-stepup-credential"]);
  });

  // ---------------------------------------------------------------------------
  // `/passkey/register/complete` — the route that lifts the restriction.
  //
  // It composes three things no service test composes: the resolver accepting
  // the recovery audience, `readSessionCookie` + `classifyCallerSession` naming
  // the caller's own restricted session, and the lift firing on the hash that
  // comes back. Break any one and the enrolment still returns 200 or 409 while
  // the restriction is silently never lifted — leaving a user whose session dies
  // fifteen minutes after a successful recovery.
  // ---------------------------------------------------------------------------

  it("/passkey/register/complete lifts the restriction on a recovery caller", async () => {
    const { user, restricted, restrictedRefresh } = await tokensFor(
      "ra-complete@example.com",
      "racomplete",
    );
    await seedPasskey(user.accountId, "pk_racomplete01", "ra-complete-credential");
    const headers = {
      Authorization: `Bearer ${restricted}`,
      "Content-Type": "application/json",
      // Exactly what `POST /login/recovery/complete` sets.
      cookie: cookieHeaderFor(restrictedRefresh),
    };

    const begun = await authApp.handle(
      new Request("http://localhost/passkey/register/begin", {
        method: "POST",
        headers,
        body: JSON.stringify({ profileId: user.id }),
      }),
    );
    expect(begun.status).toBe(200);

    const completed = await authApp.handle(
      new Request("http://localhost/passkey/register/complete", {
        method: "POST",
        headers,
        body: JSON.stringify({ profileId: user.id, attestation: FAKE_ATTESTATION }),
      }),
    );
    expect(completed.status).toBe(200);
    expect((await completed.json()) as { passkeyId?: string }).toHaveProperty("passkeyId");

    // The restriction is gone from the row the caller still holds...
    const rows = await runWithLayer(
      Effect.promise(() =>
        db
          .select()
          .from(sessions)
          .where(eq(sessions.id, auth.hashSessionToken(restrictedRefresh)))
          .limit(1),
      ),
    );
    expect(rows[0]?.restrictedUntil).toBeNull();
    expect(rows[0]?.restrictedAmr).toBeNull();

    // ...and the session it leaves behind is an ordinary one on the wire: the
    // next grant returns a token every verifier accepts.
    const granted = await authApp.handle(
      new Request("http://localhost/token", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          cookie: cookieHeaderFor(restrictedRefresh),
        },
        body: JSON.stringify({ grant_type: "refresh_token" }),
      }),
    );
    expect(granted.status).toBe(200);
    const { access_token } = (await granted.json()) as { access_token: string };
    const claims = JSON.parse(
      Buffer.from(access_token.split(".")[1]!, "base64url").toString("utf8"),
    ) as { aud?: string };
    expect(claims.aud).toBe(ACCESS_TOKEN_AUDIENCE);
  });

  it("/passkey/register/complete answers 409 when it cannot name the caller's session", async () => {
    // A recovery token whose `osn_sid` names no live row: the session expired,
    // was rotated out or was LRU-evicted. Wiping every session on the account
    // is the wrong answer — the caller plainly has a session — and lifting
    // nothing while returning 200 would hide a dead recovery. It fails closed.
    const { user, restricted, restrictedRefresh } = await tokensFor(
      "ra-stale@example.com",
      "rastale",
    );
    const begun = await authApp.handle(
      new Request("http://localhost/passkey/register/begin", {
        method: "POST",
        headers: { Authorization: `Bearer ${restricted}`, "Content-Type": "application/json" },
        body: JSON.stringify({ profileId: user.id }),
      }),
    );
    expect(begun.status).toBe(200);

    await runWithLayer(
      Effect.promise(() =>
        db.delete(sessions).where(eq(sessions.id, auth.hashSessionToken(restrictedRefresh))),
      ),
    );

    const completed = await authApp.handle(
      // No cookie, and the binding now names nothing.
      new Request("http://localhost/passkey/register/complete", {
        method: "POST",
        headers: { Authorization: `Bearer ${restricted}`, "Content-Type": "application/json" },
        body: JSON.stringify({ profileId: user.id, attestation: FAKE_ATTESTATION }),
      }),
    );
    expect(completed.status).toBe(409);
    expect((await completed.json()) as { error?: string }).toMatchObject({
      error: "session_stale",
    });
  });
});
