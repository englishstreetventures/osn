/**
 * The session of an account whose deletion is pending (`accounts.deleted_at`
 * set): every access token minted for it carries the `osn-pending-deletion`
 * audience, so it reaches the deletion status, the export, the restore and the
 * step-ups those need, and nothing else.
 *
 * Accounts are tombstoned here by writing `accounts.deleted_at` (and a
 * `deletion_jobs` row) directly, as the soft delete leaves them, so these tests
 * do not depend on the erasure service. Each refusal carries a control on the
 * same route, because a 401 is also what a broken harness returns.
 *
 * See `wiki/osn/sessions.md`.
 */

import { passkeys, accounts } from "@osn/db/schema";
import { base32Decode, deriveTotpCode } from "@shared/crypto/totp";
import { eq } from "drizzle-orm";
import { Effect, Layer } from "effect";
import { beforeAll, describe, expect, it, vi } from "vitest";

// No route test can produce a real WebAuthn attestation or assertion, so only
// the two verifiers are stubbed: `generate*Options` still plant real
// challenges, and everything around the verifiers runs for real.
vi.mock("@simplewebauthn/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@simplewebauthn/server")>();
  return {
    ...actual,
    verifyRegistrationResponse: vi.fn(async () => ({
      verified: true,
      registrationInfo: {
        credential: {
          id: `pd-cred-${Math.random().toString(16).slice(2, 12)}`,
          publicKey: new Uint8Array([1, 2, 3, 4]),
          counter: 0,
          transports: undefined,
        },
        aaguid: "00000000-0000-0000-0000-000000000000",
        credentialBackedUp: false,
        credentialDeviceType: "singleDevice",
      },
    })),
    // A counterless authenticator: every assertion carries 0.
    verifyAuthenticationResponse: vi.fn(async () => ({
      verified: true,
      authenticationInfo: { newCounter: 0 },
    })),
  };
});

const { buildSessionCookies } = await import("../../src/lib/cookie-session");
const { createAccountErasureRoutes } = await import("../../src/routes/account-erasure");
const { createAccountExportRoutes } = await import("../../src/routes/account-export");
const { createGraphRoutes } = await import("../../src/routes/graph");
const { createAuthService } = await import("../../src/services/auth");
const { ACCESS_TOKEN_AUDIENCE, PENDING_DELETION_TOKEN_AUDIENCE, isReservedOidcClientId } =
  await import("../../src/services/auth/constants");
const { makeTestAuthConfig } = await import("../helpers/auth-config");
const { createTestLayerWithSqlite } = await import("../helpers/db");
const { recoveredResponse } = await import("../helpers/recovery-link");
const { createAuthRoutes } = await import("../helpers/routes");
const { mintStepUpToken } = await import("../helpers/step-up-session");
const {
  beginStepUpThroughRoutes,
  confirmLinkThroughRoutes,
  linkForRequest,
  stepUpStatusThroughRoutes,
  stepUpThroughRoutes,
} = await import("../helpers/step-up-link");
const { settledHandle } = await import("../helpers/background");

type AuthConfig = Awaited<ReturnType<typeof makeTestAuthConfig>>;

let config: AuthConfig;

beforeAll(async () => {
  config = await makeTestAuthConfig();
});

/** The route factories' default: no TLS locally, so no `__Host-` prefix. */
const COOKIE_CONFIG = { secure: false } as const;

/** The export and erasure routes trust one XFF hop here; this is that hop. */
const IP_HEADERS = { "x-forwarded-for": "1.2.3.4" };

const STEP_SECONDS = 30;
const SEVEN_DAYS = 7 * 24 * 60 * 60;

const audOf = (jwt: string): unknown =>
  (JSON.parse(Buffer.from(jwt.split(".")[1]!, "base64url").toString("utf8")) as { aud?: unknown })
    .aud;

const base64url = (text: string) => Buffer.from(text, "utf8").toString("base64url");

const fakeAttestation = () =>
  ({ id: "x", rawId: "x", response: {}, type: "public-key", clientExtensionResults: {} }) as never;

const fakeAssertion = (credentialId: string) => ({
  id: credentialId,
  rawId: credentialId,
  response: {},
  type: "public-key",
  clientExtensionResults: {},
});

/** An assertion whose `clientDataJSON` carries `challenge`, from the account `userId` names. */
const discoverableAssertion = (credentialId: string, challenge: string, userId: string) => ({
  id: credentialId,
  rawId: credentialId,
  response: {
    clientDataJSON: base64url(
      JSON.stringify({ type: "webauthn.get", challenge, origin: "http://localhost:5173" }),
    ),
    userHandle: base64url(userId),
  },
  type: "public-key",
  clientExtensionResults: {},
});

/** The `Cookie` header a session's `Set-Cookie` produces. */
const cookieHeaderFor = (refreshToken: string): string =>
  buildSessionCookies(refreshToken, COOKIE_CONFIG)
    .map((c) => c.split(";")[0])
    .join("; ");

/** The session cookie a response set, as a `Cookie` header. */
const sessionCookieOf = (res: Response): string => {
  const set = res.headers.getSetCookie().find((c) => c.startsWith("osn_session="));
  if (!set) throw new Error("no session cookie set");
  return set.split(";")[0]!;
};

function harness() {
  const { layer, db, sqlite, email } = createTestLayerWithSqlite();
  const auth = createAuthService(config);
  const authApp = createAuthRoutes(config, layer);
  const graphApp = createGraphRoutes(config, layer);
  const exportApp = createAccountExportRoutes(
    config,
    COOKIE_CONFIG,
    layer,
    Layer.empty,
    undefined,
    undefined,
    { trustedProxyCount: 1 },
    undefined,
    [],
  );
  const erasureApp = createAccountErasureRoutes(
    config,
    layer,
    undefined,
    undefined,
    COOKIE_CONFIG,
    { trustedProxyCount: 1 },
  );
  const svc = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.runPromise(effect.pipe(Effect.provide(layer)) as Effect.Effect<A, E, never>);
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    authApp.handle(
      new Request(`http://localhost${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      }),
    );
  return { layer, db, sqlite, auth, authApp, graphApp, exportApp, erasureApp, svc, post, email };
}

type Harness = ReturnType<typeof harness>;

/** A live account with an ordinary session. */
async function liveAccount(h: Harness, handle: string, displayName = "Pending Person") {
  const profile = await h.svc(h.auth.registerProfile(`${handle}@example.com`, handle, displayName));
  const session = await h.svc(
    h.auth.issueTokens(
      profile.id,
      profile.accountId,
      profile.email,
      profile.handle,
      profile.displayName,
    ),
  );
  return { profile, session };
}

/**
 * What the soft delete leaves: the account tombstoned, its job written with
 * `restore`, and its profiles renamed to `deleted_<id>` with no display name or
 * avatar.
 */
function tombstone(h: Harness, accountId: string, restore: unknown = null): void {
  const now = Math.floor(Date.now() / 1000);
  h.sqlite.run("UPDATE accounts SET deleted_at = ? WHERE id = ?", [now, accountId]);
  h.sqlite.run(
    "INSERT INTO deletion_jobs (account_id, soft_deleted_at, hard_delete_at, restore) VALUES (?, ?, ?, ?)",
    [accountId, now, now + SEVEN_DAYS, restore === null ? null : JSON.stringify(restore)],
  );
  h.sqlite.run(
    "UPDATE users SET handle = 'deleted_' || replace(id, 'usr_', ''), display_name = NULL, avatar_url = NULL WHERE account_id = ?",
    [accountId],
  );
}

/** What a cancel leaves, as far as the audience is concerned. */
function untombstone(h: Harness, accountId: string): void {
  h.sqlite.run("UPDATE accounts SET deleted_at = NULL WHERE id = ?", [accountId]);
  h.sqlite.run("DELETE FROM deletion_jobs WHERE account_id = ?", [accountId]);
}

/** `POST /token` with a session cookie. */
async function refresh(h: Harness, cookie: string) {
  const res = await h.post("/token", { grant_type: "refresh_token" }, { cookie });
  expect(res.status).toBe(200);
  const { access_token } = (await res.clone().json()) as { access_token: string };
  return { accessToken: access_token, cookie: sessionCookieOf(res) };
}

/**
 * An account whose deletion is pending, signed in on the device the deletion
 * spared: its live session's next refresh hands back the pending-deletion
 * token. Answers that token and the live one minted before the tombstone.
 */
async function pendingDeletionAccount(
  h: Harness,
  handle: string,
  opts: {
    displayName?: string;
    /** The job's `restore` record, built from the profile as it stood. */
    restore?: (profile: { id: string; handle: string; displayName: string | null }) => unknown;
    beforeTombstone?: (live: string, accountId: string) => Promise<void>;
  } = {},
) {
  const { profile, session } = await liveAccount(h, handle, opts.displayName);
  await opts.beforeTombstone?.(session.accessToken, profile.accountId);
  tombstone(h, profile.accountId, opts.restore?.(profile) ?? null);
  const refreshed = await refresh(h, cookieHeaderFor(session.refreshToken));
  expect(audOf(refreshed.accessToken)).toBe(PENDING_DELETION_TOKEN_AUDIENCE);
  return { profile, live: session.accessToken, pending: refreshed.accessToken, ...refreshed };
}

/** Enrols one passkey through the service; answers its credential id and user handle. */
async function enrolPasskey(h: Harness, accountId: string) {
  await h.svc(h.auth.beginPasskeyRegistration(accountId));
  const { passkeyId } = await h.svc(
    h.auth.completePasskeyRegistration(accountId, fakeAttestation(), null),
  );
  const rows = await h.db
    .select({ credentialId: passkeys.credentialId, userId: accounts.passkeyUserId })
    .from(passkeys)
    .innerJoin(accounts, eq(accounts.id, passkeys.accountId))
    .where(eq(passkeys.id, passkeyId));
  return { credentialId: rows[0]!.credentialId, userId: rows[0]!.userId };
}

/** Enrols a confirmed authenticator through the routes; answers its secret. */
async function enrolTotp(h: Harness, accountId: string, accessToken: string) {
  const stepUp = await h.svc(mintStepUpToken(h.auth, accountId, "passkey", "totp_enroll"));
  const begun = (await (
    await h.post(
      "/totp/enroll/begin",
      { step_up_token: stepUp },
      { authorization: `Bearer ${accessToken}` },
    )
  ).json()) as { totpSecret: string };
  const secret = base32Decode(begun.totpSecret);
  const done = await h.post(
    "/totp/enroll/complete",
    { code: await deriveTotpCode(secret, Math.floor(Date.now() / 1000 / STEP_SECONDS)) },
    { authorization: `Bearer ${accessToken}` },
  );
  expect(done.status).toBe(200);
  return secret;
}

/** A TOTP code one step ahead, so it is not the step enrolment just used. */
const nextCode = (secret: Uint8Array) =>
  deriveTotpCode(secret, Math.floor(Date.now() / 1000 / STEP_SECONDS) + 1);

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

/** The two purposes a pending-deletion caller may mint a step-up for. */
const WINDOW_PURPOSES = ["account_export", "account_restore"] as const;

type WindowPurpose = (typeof WINDOW_PURPOSES)[number];

/** What a route answered: its status, and the body where the test reads one. */
type Spent = { status: number; body?: unknown };

/**
 * Spends a pending-deletion caller's step-up token at the route its purpose
 * is for, and answers what that route said.
 */
const SPEND_AT: Record<
  WindowPurpose,
  (h: Harness, pending: string, stepUp: string) => Promise<Spent>
> = {
  account_export: async (h, pending, stepUp) => {
    const exported = await h.exportApp.handle(
      new Request("http://localhost/account/export", {
        headers: { ...IP_HEADERS, ...bearer(pending), "x-step-up-token": stepUp },
      }),
    );
    await exported.text();
    return { status: exported.status };
  },
  account_restore: async (h, pending, stepUp) => {
    const restored = await h.erasureApp.handle(
      new Request("http://localhost/account/restore", {
        method: "POST",
        headers: { ...IP_HEADERS, ...bearer(pending), "content-type": "application/json" },
        body: JSON.stringify({ step_up_token: stepUp }),
      }),
    );
    return { status: restored.status, body: await restored.json() };
  },
};

/** What each route answers a token it accepts: the export, and the cancel. */
const SPENT: Record<WindowPurpose, Spent> = {
  account_export: { status: 200 },
  account_restore: { status: 200, body: { cancelled: true } },
};

// ---------------------------------------------------------------------------
// Minting
// ---------------------------------------------------------------------------

describe("sign-in and refresh of an account whose deletion is pending", () => {
  it("recovery-code sign-in by email mints a pending-deletion token", async () => {
    const h = harness();
    const { profile } = await liveAccount(h, "pdcode");
    const { recoveryCodes } = await h.svc(
      h.auth.generateRecoveryCodesForAccount(profile.accountId),
    );
    tombstone(h, profile.accountId);

    const res = await h.post("/login/recovery/complete", {
      identifier: "pdcode@example.com",
      code: recoveryCodes[0],
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { session: { access_token: string } };
    expect(audOf(body.session.access_token)).toBe(PENDING_DELETION_TOKEN_AUDIENCE);
  });

  it("discoverable passkey sign-in mints a pending-deletion token", async () => {
    const h = harness();
    const { profile } = await liveAccount(h, "pdpasskey");
    const { credentialId, userId } = await enrolPasskey(h, profile.accountId);
    tombstone(h, profile.accountId);

    const begun = await h.post("/login/passkey/begin", {});
    expect(begun.status).toBe(200);
    const { challengeId } = (await begun.json()) as { challengeId: string };
    const res = await h.post("/login/passkey/complete", {
      challengeId,
      assertion: discoverableAssertion(credentialId, challengeId, userId),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { session: { access_token: string } };
    expect(audOf(body.session.access_token)).toBe(PENDING_DELETION_TOKEN_AUDIENCE);
  });

  it("refresh mints a pending-deletion token, and osn-access once the deletion is cancelled", async () => {
    const h = harness();
    const { profile, session } = await liveAccount(h, "pdrefresh");
    tombstone(h, profile.accountId);

    const pending = await refresh(h, cookieHeaderFor(session.refreshToken));
    expect(audOf(pending.accessToken)).toBe(PENDING_DELETION_TOKEN_AUDIENCE);

    untombstone(h, profile.accountId);
    const restored = await refresh(h, pending.cookie);
    expect(audOf(restored.accessToken)).toBe(ACCESS_TOKEN_AUDIENCE);
  });

  it("no relying party may be registered under the pending-deletion audience", () => {
    expect(isReservedOidcClientId(PENDING_DELETION_TOKEN_AUDIENCE)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// What the token cannot reach
// ---------------------------------------------------------------------------

describe("routes a pending-deletion token cannot reach", () => {
  it("GET /sessions refuses it", async () => {
    const h = harness();
    const { pending } = await pendingDeletionAccount(h, "pdsessions");
    const { session } = await liveAccount(h, "pdsessionsok");

    const refused = await h.authApp.handle(
      new Request("http://localhost/sessions", { headers: bearer(pending) }),
    );
    expect(refused.status).toBe(401);

    const allowed = await h.authApp.handle(
      new Request("http://localhost/sessions", { headers: bearer(session.accessToken) }),
    );
    expect(allowed.status).toBe(200);
  });

  it("a graph route, which reads only the token's claims, refuses it", async () => {
    const h = harness();
    const { pending } = await pendingDeletionAccount(h, "pdgraph");
    const { session } = await liveAccount(h, "pdgraphok");
    const url = "http://localhost/graph/connections";

    const refused = await h.graphApp.handle(new Request(url, { headers: bearer(pending) }));
    expect(refused.status).toBe(401);

    const allowed = await h.graphApp.handle(
      new Request(url, { headers: bearer(session.accessToken) }),
    );
    expect(allowed.status).toBe(200);
  });

  // Each admitted purpose on a fresh account whose deletion is pending, its
  // token spent where that purpose is for: the restore case is the only way
  // a person signed in during the window can cancel.
  it.each(WINDOW_PURPOSES)(
    "passkey step-up mints for it only for export or restore (%s)",
    async (purpose) => {
      const h = harness();
      // Enrolled before the session: a service enrolment with no caller session
      // ends every session of the account.
      const profile = await h.svc(h.auth.registerProfile("pdstepkey@example.com", "pdstepkey"));
      const { credentialId } = await enrolPasskey(h, profile.accountId);
      const session = await h.svc(
        h.auth.issueTokens(profile.id, profile.accountId, profile.email, profile.handle, null),
      );
      tombstone(h, profile.accountId);
      const { accessToken: pending } = await refresh(h, cookieHeaderFor(session.refreshToken));

      const begun = await h.post("/step-up/passkey/begin", {}, bearer(pending));
      expect(begun.status).toBe(200);

      const assertion = fakeAssertion(credentialId);
      const noPurpose = await h.post("/step-up/passkey/complete", { assertion }, bearer(pending));
      expect(noPurpose.status).toBe(401);
      const otherPurpose = await h.post(
        "/step-up/passkey/complete",
        { assertion, purpose: "account_delete" },
        bearer(pending),
      );
      expect(otherPurpose.status).toBe(401);

      const allowed = await h.post(
        "/step-up/passkey/complete",
        { assertion, purpose },
        bearer(pending),
      );
      expect(allowed.status).toBe(200);
      const { step_up_token } = (await allowed.json()) as { step_up_token: string };
      expect(await SPEND_AT[purpose](h, pending, step_up_token)).toEqual(SPENT[purpose]);
    },
  );

  it.each(WINDOW_PURPOSES)(
    "authenticator step-up mints for it only for export or restore (%s)",
    async (purpose) => {
      const h = harness();
      let secret: Uint8Array = new Uint8Array();
      const { pending } = await pendingDeletionAccount(h, "pdsteptotp", {
        beforeTombstone: async (live, accountId) => {
          secret = await enrolTotp(h, accountId, live);
        },
      });
      const code = await nextCode(secret);

      const noPurpose = await h.post("/step-up/totp/complete", { code }, bearer(pending));
      expect(noPurpose.status).toBe(401);
      const otherPurpose = await h.post(
        "/step-up/totp/complete",
        { code, purpose: "account_delete" },
        bearer(pending),
      );
      expect(otherPurpose.status).toBe(401);

      const allowed = await h.post("/step-up/totp/complete", { code, purpose }, bearer(pending));
      expect(allowed.status).toBe(200);
      const { step_up_token } = (await allowed.json()) as { step_up_token: string };
      expect(await SPEND_AT[purpose](h, pending, step_up_token)).toEqual(SPENT[purpose]);
    },
  );

  it.each(WINDOW_PURPOSES)(
    "step-up by emailed link begins for it only for export or restore (%s)",
    async (purpose) => {
      const h = harness();
      const { pending } = await pendingDeletionAccount(h, "pdsteplink");

      const refused = await beginStepUpThroughRoutes(h.authApp, pending, "account_delete");
      expect(refused.res.status).toBe(401);

      // Begin, confirm from the mailed link, then poll, as the tab does.
      const stepUp = await stepUpThroughRoutes(
        h.authApp,
        pending,
        () => h.email.recorded(),
        purpose,
      );
      expect(await SPEND_AT[purpose](h, pending, stepUp)).toEqual(SPENT[purpose]);
    },
  );

  it("a link begun before the deletion for another purpose cannot be polled or resent into a token", async () => {
    // A link begun while the account was live, for `pulse_app_delete`, and
    // confirmed: the status poll would mint whatever purpose begin stored.
    const h = harness();
    const begunLinks: Record<string, { requestId: string; claimSecret: string }> = {};
    const { pending } = await pendingDeletionAccount(h, "pdstale", {
      beforeTombstone: async (live) => {
        for (const purpose of ["pulse_app_delete", "account_export"] as const) {
          const { res, body } = await beginStepUpThroughRoutes(h.authApp, live, purpose);
          expect(res.status).toBe(200);
          const link = linkForRequest(h.email.recorded(), body.requestId)!;
          const confirmed = await confirmLinkThroughRoutes(
            h.authApp,
            body.requestId,
            link.linkSecret,
            body.pairingCode,
          );
          expect(confirmed.status).toBe(200);
          begunLinks[purpose] = body;
        }
        const { res, body } = await beginStepUpThroughRoutes(h.authApp, live, "pulse_app_delete");
        expect(res.status).toBe(200);
        begunLinks["unconfirmed"] = body;
      },
    });

    const stale = begunLinks["pulse_app_delete"]!;
    const refused = await stepUpStatusThroughRoutes(
      h.authApp,
      pending,
      stale.requestId,
      stale.claimSecret,
    );
    expect(await refused.json()).toEqual({ status: "expired" });

    const mailsBefore = h.email.recorded().length;
    const unconfirmed = begunLinks["unconfirmed"]!;
    const resent = await settledHandle(
      h.authApp,
      new Request(`http://localhost/step-up/email/${unconfirmed.requestId}/resend`, {
        method: "POST",
        headers: { "content-type": "application/json", ...bearer(pending) },
        body: JSON.stringify({ claimSecret: unconfirmed.claimSecret }),
      }),
    );
    expect(await resent.json()).toEqual({ status: "expired" });
    expect(h.email.recorded().length).toBe(mailsBefore);

    const control = begunLinks["account_export"]!;
    const allowed = await stepUpStatusThroughRoutes(
      h.authApp,
      pending,
      control.requestId,
      control.claimSecret,
    );
    expect((await allowed.json()) as { status?: string }).toMatchObject({ status: "complete" });
  });
});

// ---------------------------------------------------------------------------
// What it reaches
// ---------------------------------------------------------------------------

describe("the export and status a pending-deletion token reaches", () => {
  const exportRequest = (token: string, stepUp: string) =>
    new Request("http://localhost/account/export", {
      headers: { ...IP_HEADERS, ...bearer(token), "x-step-up-token": stepUp },
    });

  const profileLines = async (res: Response) =>
    (await res.text())
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l) as { section?: string; record?: Record<string, unknown> })
      .filter((l) => l.section === "profiles")
      .map((l) => l.record!);

  it("exports with an account_export step-up, showing each profile as the deletion held it", async () => {
    const h = harness();
    const { profile, pending } = await pendingDeletionAccount(h, "pdheld", {
      displayName: "Held Name",
      restore: (p) => ({
        profiles: [
          {
            id: p.id,
            handle: p.handle,
            displayName: p.displayName,
            avatarUrl: "https://cdn.example.com/held.png",
          },
        ],
        enrollments: [],
      }),
    });
    const stepUp = await h.svc(mintStepUpToken(h.auth, profile.accountId, "otp", "account_export"));

    const res = await h.exportApp.handle(exportRequest(pending, stepUp));
    expect(res.status).toBe(200);
    const profiles = await profileLines(res);
    expect(profiles).toHaveLength(1);
    expect(profiles[0]).toMatchObject({
      id: profile.id,
      handle: "pdheld",
      displayName: "Held Name",
      avatarUrl: "https://cdn.example.com/held.png",
    });

    const status = await h.erasureApp.handle(
      new Request("http://localhost/account/deletion-status", {
        headers: { ...IP_HEADERS, ...bearer(pending) },
      }),
    );
    expect(status.status).toBe(200);
    expect((await status.json()) as { scheduled?: boolean }).toMatchObject({ scheduled: true });
  });

  it("a job with no restore record exports the profiles as they stand", async () => {
    const h = harness();
    const { profile, pending } = await pendingDeletionAccount(h, "pdnorestore");
    const stepUp = await h.svc(mintStepUpToken(h.auth, profile.accountId, "otp", "account_export"));

    const res = await h.exportApp.handle(exportRequest(pending, stepUp));
    expect(res.status).toBe(200);
    const profiles = await profileLines(res);
    expect(profiles).toHaveLength(1);
    expect(profiles[0]!["handle"]).toBe(`deleted_${profile.id.replace("usr_", "")}`);
  });

  it("reads the authenticator status, which the step-up sheet asks before offering it, and still cannot enrol or remove one", async () => {
    // Red on resolving the status caller as an ordinary session only: the
    // sheet never offers the authenticator to a person cancelling their
    // deletion, and the client's renew-then-401 ends the session.
    const h = harness();
    const { pending, profile } = await pendingDeletionAccount(h, "pdtotpstatus", {
      beforeTombstone: async (live, accountId) => {
        await enrolTotp(h, accountId, live);
      },
    });

    const status = await h.authApp.handle(
      new Request("http://localhost/totp/status", { headers: bearer(pending) }),
    );
    expect(status.status).toBe(200);
    expect((await status.json()) as { enrolled?: boolean }).toMatchObject({ enrolled: true });

    const stepUp = await h.svc(
      h.auth.issueStepUpToken(profile.accountId, "passkey", "totp_enroll"),
    );
    const enrol = await h.post("/totp/enroll/begin", { step_up_token: stepUp }, bearer(pending));
    expect(enrol.status).toBe(401);
    const removal = await h.authApp.handle(
      new Request("http://localhost/totp", {
        method: "DELETE",
        headers: { "content-type": "application/json", ...bearer(pending) },
        body: JSON.stringify({ step_up_token: stepUp }),
      }),
    );
    expect(removal.status).toBe(401);

    untombstone(h, profile.accountId);
    const stale = await h.authApp.handle(
      new Request("http://localhost/totp/status", { headers: bearer(pending) }),
    );
    expect(stale.status).toBe(401);
  });

  it("refuses a pending-deletion token once the account is no longer pending deletion", async () => {
    const h = harness();
    const { profile, pending } = await pendingDeletionAccount(h, "pdstaletoken");
    untombstone(h, profile.accountId);
    const stepUp = await h.svc(mintStepUpToken(h.auth, profile.accountId, "otp", "account_export"));

    const exported = await h.exportApp.handle(exportRequest(pending, stepUp));
    expect(exported.status).toBe(401);

    const status = await h.erasureApp.handle(
      new Request("http://localhost/account/deletion-status", {
        headers: { ...IP_HEADERS, ...bearer(pending) },
      }),
    );
    expect(status.status).toBe(401);
  });
});

describe("the restore and the repeat deletion a pending-deletion token reaches", () => {
  const erasure = (h: Harness, method: string, path: string, token: string, body?: unknown) =>
    h.erasureApp.handle(
      new Request(`http://localhost${path}`, {
        method,
        headers: {
          ...IP_HEADERS,
          ...bearer(token),
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );

  it("cancels with an account_restore step-up, putting the profile back", async () => {
    const h = harness();
    const { profile, pending } = await pendingDeletionAccount(h, "pdrestore", {
      displayName: "Restore Me",
      restore: (p) => ({
        profiles: [{ id: p.id, handle: p.handle, displayName: p.displayName, avatarUrl: null }],
        enrollments: [],
      }),
    });

    const refused = await erasure(h, "POST", "/account/restore", pending, {});
    expect(refused.status).toBe(403);

    const stepUp = await h.svc(
      mintStepUpToken(h.auth, profile.accountId, "otp", "account_restore"),
    );
    const res = await erasure(h, "POST", "/account/restore", pending, { step_up_token: stepUp });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ cancelled: true });
    expect(await h.svc(h.auth.findProfileById(profile.id))).toMatchObject({
      handle: "pdrestore",
      displayName: "Restore Me",
    });
  });

  it("refuses at restore once the account is no longer pending deletion", async () => {
    const h = harness();
    const { profile, pending, cookie } = await pendingDeletionAccount(h, "pdrestorestale");
    untombstone(h, profile.accountId);
    const stepUp = await h.svc(
      mintStepUpToken(h.auth, profile.accountId, "otp", "account_restore"),
    );

    const refused = await erasure(h, "POST", "/account/restore", pending, {
      step_up_token: stepUp,
    });
    expect(refused.status).toBe(401);

    // Control: the ordinary token the session renews into reaches it, and
    // finds nothing to cancel.
    const { accessToken } = await refresh(h, cookie);
    const allowed = await erasure(h, "POST", "/account/restore", accessToken, {});
    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toEqual({ cancelled: false });
  });

  it("a repeat deletion answers that it is already pending, and nothing once it is not", async () => {
    const h = harness();
    const { profile, pending } = await pendingDeletionAccount(h, "pdrepeat");

    const repeat = await erasure(h, "DELETE", "/account", pending, { confirm_handle: "anything" });
    expect(repeat.status).toBe(202);
    expect(await repeat.json()).toMatchObject({ already_pending: true });

    untombstone(h, profile.accountId);
    const refused = await erasure(h, "DELETE", "/account", pending, { confirm_handle: "pdrepeat" });
    expect(refused.status).toBe(401);
  });

  it("the deletion preview refuses it", async () => {
    const h = harness();
    const { pending } = await pendingDeletionAccount(h, "pdpreview");
    const { session } = await liveAccount(h, "pdpreviewok");
    const preview = (token: string) =>
      h.erasureApp.handle(
        new Request("http://localhost/account/deletion-preview", {
          headers: { ...IP_HEADERS, ...bearer(token) },
        }),
      );

    expect((await preview(pending)).status).toBe(401);
    expect((await preview(session.accessToken)).status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Recovery during the window
// ---------------------------------------------------------------------------

describe("recovery of an account whose deletion is pending", () => {
  it.each(["email", "totp"] as const)(
    "%s recovery ends in a passkey enrolment, the next refresh is pending-deletion, and that passkey cancels the deletion",
    async (factor) => {
      const h = harness();
      const { profile, session } = await liveAccount(h, `pdrec${factor}`);
      const email = profile.email;
      const secret =
        factor === "totp" ? await enrolTotp(h, profile.accountId, session.accessToken) : null;
      // The lost device's passkey row is still there.
      const lost = await enrolPasskey(h, profile.accountId);
      tombstone(h, profile.accountId);

      // Handles are redacted, so recovery names the account by its email.
      const recovered =
        factor === "email"
          ? await recoveredResponse(h.authApp, () => h.email.recorded(), email)
          : await h.post("/login/recovery/totp/complete", {
              identifier: email,
              code: await nextCode(secret!),
            });
      expect([200, 201]).toContain(recovered.status);
      const restricted = ((await recovered.clone().json()) as { session: { access_token: string } })
        .session.access_token;
      const headers = { ...bearer(restricted), cookie: sessionCookieOf(recovered) };

      const begun = await h.post("/passkey/register/begin", { profileId: profile.id }, headers);
      expect(begun.status).toBe(200);
      // The authenticator shows the account's email, never `@deleted_…`.
      const options = (await begun.json()) as { user: { name: string; displayName: string } };
      expect(options.user.name).toBe(email);
      expect(options.user.displayName).toBe(email);

      const completed = await h.post(
        "/passkey/register/complete",
        { profileId: profile.id, attestation: fakeAttestation() },
        headers,
      );
      expect(completed.status).toBe(200);

      const next = await refresh(h, headers.cookie);
      expect(audOf(next.accessToken)).toBe(PENDING_DELETION_TOKEN_AUDIENCE);

      // The passkey just enrolled answers an account_restore step-up, and
      // its token cancels the deletion.
      const enrolled = (
        await h.db
          .select({ credentialId: passkeys.credentialId })
          .from(passkeys)
          .where(eq(passkeys.accountId, profile.accountId))
      )
        .map((row) => row.credentialId)
        .filter((id) => id !== lost.credentialId);
      expect(enrolled).toHaveLength(1);
      const stepUpBegun = await h.post("/step-up/passkey/begin", {}, bearer(next.accessToken));
      expect(stepUpBegun.status).toBe(200);
      const stepUp = await h.post(
        "/step-up/passkey/complete",
        { assertion: fakeAssertion(enrolled[0]!), purpose: "account_restore" },
        bearer(next.accessToken),
      );
      expect(stepUp.status).toBe(200);
      const { step_up_token } = (await stepUp.json()) as { step_up_token: string };
      expect(await SPEND_AT.account_restore(h, next.accessToken, step_up_token)).toEqual(
        SPENT.account_restore,
      );

      // Cancelled: the same session now renews into an ordinary token.
      const restored = await refresh(h, next.cookie);
      expect(audOf(restored.accessToken)).toBe(ACCESS_TOKEN_AUDIENCE);
    },
  );

  it("an osn-access token of an account whose deletion is pending cannot enrol", async () => {
    const h = harness();
    const { profile, session } = await liveAccount(h, "pdenrolaccess");
    tombstone(h, profile.accountId);

    const refused = await h.post(
      "/passkey/register/begin",
      { profileId: profile.id },
      bearer(session.accessToken),
    );
    expect(refused.status).toBe(401);
  });
});
