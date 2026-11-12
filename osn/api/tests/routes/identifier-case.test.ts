/**
 * Sign-in and recovery find an account by its email address or handle however
 * the caller cases it, and an identifier that names nobody answers exactly as
 * one in lower case does.
 *
 * Phones capitalise the first letter of a text field, so `Alice@X.com` and
 * `@Alice` are what a user sends without meaning to. Every route that takes an
 * identifier folds it in one place, `normaliseIdentifier`, before it resolves
 * the account or derives a store key from it, so a ceremony begun in one case
 * and finished in another still meets its own challenge.
 *
 * The passkey, recovery-code, email-recovery, authenticator-recovery and
 * several-profiles blocks go red when `normaliseIdentifier` stops lower-casing;
 * the test that sends spaces goes red when it stops trimming. The block on
 * accounts stored with capitals pins the match on the address as typed, and the
 * account binding a shared challenge key leans on. The last block pins the
 * refusals: an unknown identifier in any case, and a wrong code for a known
 * one typed in capitals, answer the one failure every refusal shares.
 */

import { Database } from "bun:sqlite";

import { passkeys } from "@osn/db/schema";
import { Db } from "@osn/db/service";
import { applySchema } from "@osn/db/testing";
import { base32Decode, deriveTotpCode } from "@shared/crypto/totp";
import { makeLogEmailLive } from "@shared/email";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { Effect, Layer } from "effect";
import { beforeAll, describe, expect, it, vi } from "vitest";

// No unit test can produce a real WebAuthn attestation or assertion, so only
// the two verifiers are stubbed: `generate*Options` still plant real
// challenges, and the challenge lookup this file is about runs for real.
vi.mock("@simplewebauthn/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@simplewebauthn/server")>();
  let seq = 0;
  return {
    ...actual,
    verifyRegistrationResponse: vi.fn(async () => {
      seq += 1;
      return {
        verified: true,
        registrationInfo: {
          credential: {
            id: `ic-cred-${seq}-${Math.random().toString(16).slice(2, 10)}`,
            publicKey: new Uint8Array([1, 2, 3, 4]),
            counter: 0,
            transports: undefined,
          },
          aaguid: "00000000-0000-0000-0000-000000000000",
          credentialBackedUp: false,
          credentialDeviceType: "singleDevice",
        },
      };
    }),
    // A counterless authenticator: every assertion carries 0, which the
    // counter rule accepts each time.
    verifyAuthenticationResponse: vi.fn(async () => ({
      verified: true,
      authenticationInfo: { newCounter: 0 },
    })),
  };
});

const { createAuthService } = await import("../../src/services/auth");
const { makeTestAuthConfig } = await import("../helpers/auth-config");
const { createAuthRoutes } = await import("../helpers/routes");
const { beginRecoveryThroughRoutes, latestRecoveryLinkTo, recoveryStatusThroughRoutes } =
  await import("../helpers/recovery-link");

type AuthConfig = Awaited<ReturnType<typeof makeTestAuthConfig>>;

let config: AuthConfig;
beforeAll(async () => {
  config = await makeTestAuthConfig();
});

const STEP_SECONDS = 30;

/** A route app and a service over one in-memory database. */
function makeApp() {
  const sqlite = new Database(":memory:");
  applySchema(sqlite);
  const db = drizzle({ client: sqlite });
  const recorder = makeLogEmailLive();
  const layer = Layer.merge(Layer.succeed(Db, { db }), recorder.layer);
  const app = createAuthRoutes(config, layer);
  const auth = createAuthService(config);
  const svc = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.runPromise(effect.pipe(Effect.provide(layer)) as Effect.Effect<A, E, never>);
  const post = (path: string, body: unknown) =>
    app.handle(
      new Request(`http://localhost${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  return { app, auth, db, sqlite, svc, post, recorded: recorder.recorded };
}

type Harness = ReturnType<typeof makeApp>;

const fakeAttestation = () =>
  ({ id: "x", rawId: "x", response: {}, type: "public-key", clientExtensionResults: {} }) as never;

const fakeAssertion = (credentialId: string) => ({
  id: credentialId,
  rawId: credentialId,
  response: {},
  type: "public-key",
  clientExtensionResults: {},
});

/** Enrols one passkey on an account; returns its credential id. */
async function enrolPasskey(h: Harness, accountId: string): Promise<string> {
  await h.svc(h.auth.beginPasskeyRegistration(accountId));
  await h.svc(h.auth.completePasskeyRegistration(accountId, fakeAttestation(), null));
  const [row] = await h.db
    .select({ credentialId: passkeys.credentialId })
    .from(passkeys)
    .where(eq(passkeys.accountId, accountId));
  return row!.credentialId;
}

/** An account stored in lower case, with one passkey; returns its credential id. */
async function withPasskey(h: Harness, email: string, handle: string): Promise<string> {
  const profile = await h.svc(h.auth.registerProfile(email, handle));
  return enrolPasskey(h, profile.accountId);
}

/** Adds a profile to an account, bypassing the profile service's checks. */
function addProfile(h: Harness, accountId: string, handle: string, isDefault: boolean): void {
  h.sqlite
    .query(
      "INSERT INTO users (id, account_id, handle, is_default, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 1)",
    )
    .run(`usr_${handle}`, accountId, handle, isDefault ? 1 : 0);
}

/**
 * An account whose email holds capitals, as a row stored before the database
 * refused them: the insert trigger is dropped on this test database only, so
 * the row can be planted. Returns its passkey's credential id.
 */
async function withStoredCapitals(h: Harness, id: string, email: string): Promise<string> {
  h.sqlite.run("DROP TRIGGER IF EXISTS accounts_email_lower_case");
  h.sqlite
    .query(
      "INSERT INTO accounts (id, email, passkey_user_id, created_at, updated_at) VALUES (?, ?, ?, 1, 1)",
    )
    .run(id, email, `pku_${id}`);
  h.sqlite
    .query(
      "INSERT INTO users (id, account_id, handle, is_default, created_at, updated_at) VALUES (?, ?, ?, 1, 1, 1)",
    )
    .run(`usr_${id}`, id, id);
  return enrolPasskey(h, id);
}

type BeginBody = { options: { allowCredentials: { id: string }[] } };

const offered = async (h: Harness, identifier: string): Promise<string[]> => {
  const res = await h.post("/login/passkey/begin", { identifier });
  expect(res.status).toBe(200);
  return ((await res.json()) as BeginBody).options.allowCredentials.map((c) => c.id);
};

/** An account with a confirmed authenticator; returns its secret. */
async function withTotp(h: Harness, email: string, handle: string): Promise<Uint8Array> {
  const profile = await h.svc(h.auth.registerProfile(email, handle));
  const tokens = await h.svc(
    h.auth.issueTokens(
      profile.id,
      profile.accountId,
      profile.email,
      profile.handle,
      profile.displayName,
    ),
  );
  const authorization = `Bearer ${tokens.accessToken}`;
  const stepUp = await h.svc(h.auth.issueStepUpToken(profile.accountId, "passkey", "totp_enroll"));
  const begun = await h.app.handle(
    new Request("http://localhost/totp/enroll/begin", {
      method: "POST",
      headers: { "content-type": "application/json", authorization },
      body: JSON.stringify({ step_up_token: stepUp }),
    }),
  );
  const secret = base32Decode(((await begun.json()) as { totpSecret: string }).totpSecret);
  const confirmed = await h.app.handle(
    new Request("http://localhost/totp/enroll/complete", {
      method: "POST",
      headers: { "content-type": "application/json", authorization },
      body: JSON.stringify({
        code: await deriveTotpCode(secret, Math.floor(Date.now() / 1000 / STEP_SECONDS)),
      }),
    }),
  );
  expect(confirmed.status).toBe(200);
  return secret;
}

/** A code for the next time step: the enrolment spent the current one. */
const nextTotpCode = (secret: Uint8Array) =>
  deriveTotpCode(secret, Math.floor(Date.now() / 1000 / STEP_SECONDS) + 1);

const handleOf = async (res: Response) =>
  ((await res.json()) as { profile: { handle: string } }).profile.handle;

describe("passkey sign-in", () => {
  it("offers the account's passkey for its email address in capitals", async () => {
    const h = makeApp();
    const credentialId = await withPasskey(h, "pk-mail@example.com", "pkmail");

    expect(await offered(h, "PK-Mail@Example.COM")).toEqual([credentialId]);
  });

  it("offers the account's passkey for `@` and its handle in capitals", async () => {
    const h = makeApp();
    const credentialId = await withPasskey(h, "pk-handle@example.com", "pkhandle");

    expect(await offered(h, "@PKHandle")).toEqual([credentialId]);
  });

  it("offers the account's passkey for its handle behind more than one `@`", async () => {
    // Strips every leading sigil, as the people search does. Goes red on
    // stripping only one.
    const h = makeApp();
    const credentialId = await withPasskey(h, "pk-sigils@example.com", "pksigils");

    expect(await offered(h, "@@PKSigils")).toEqual([credentialId]);
  });

  it("signs in when begun in one case and completed in another", async () => {
    // The challenge is parked under the folded identifier and read back under
    // it. Goes red on folding inside the lookup alone: begin would then park
    // the challenge under `PK-Both@Example.COM` and complete would find none.
    const h = makeApp();
    const credentialId = await withPasskey(h, "pk-both@example.com", "pkboth");

    expect(await offered(h, "PK-Both@Example.COM")).toEqual([credentialId]);
    const byEmail = await h.post("/login/passkey/complete", {
      identifier: "pk-both@example.com",
      assertion: fakeAssertion(credentialId),
    });
    expect(byEmail.status).toBe(200);
    expect(await handleOf(byEmail)).toBe("pkboth");

    expect(await offered(h, "pkboth")).toEqual([credentialId]);
    const byHandle = await h.post("/login/passkey/complete", {
      identifier: "@PKBOTH",
      assertion: fakeAssertion(credentialId),
    });
    expect(byHandle.status).toBe(200);
    expect(await handleOf(byHandle)).toBe("pkboth");
  });
});

describe("recovery-code sign-in", () => {
  it("signs in with the email address in capitals, and with `@` and the handle", async () => {
    const h = makeApp();
    const profile = await h.svc(h.auth.registerProfile("rc-case@example.com", "rccase"));
    const { recoveryCodes: codes } = await h.svc(
      h.auth.generateRecoveryCodesForAccount(profile.accountId),
    );

    const byEmail = await h.post("/login/recovery/complete", {
      identifier: "RC-Case@Example.com",
      code: codes[0],
    });
    expect(byEmail.status).toBe(200);
    expect(await handleOf(byEmail)).toBe("rccase");

    const byHandle = await h.post("/login/recovery/complete", {
      identifier: "@RCCase",
      code: codes[1],
    });
    expect(byHandle.status).toBe(200);
    expect(await handleOf(byHandle)).toBe("rccase");
  });
});

describe("email recovery", () => {
  it.each([
    // Goes red on taking the fold out of `normaliseIdentifier`.
    ["the address in capitals", "ER-Case@Example.com", "er-case@example.com", "ercase"],
    // Goes red on taking the trim out of `normaliseIdentifier`.
    ["spaces around the address", "  er-trim@example.com ", "er-trim@example.com", "ertrim"],
  ])("gets back in when begun with %s", async (_, typed, stored, handle) => {
    const h = makeApp();
    await h.svc(h.auth.registerProfile(stored, handle));
    const { res, body } = await beginRecoveryThroughRoutes(h.app, typed);
    expect(res.status).toBe(202);
    const link = latestRecoveryLinkTo(h.recorded(), stored);
    expect(link?.requestId).toBe(body.requestId);

    const confirmed = await h.post(`/email-link/${link!.requestId}/confirm`, {
      linkSecret: link!.linkSecret,
      pairingPick: body.pairingCode,
    });
    expect(await confirmed.json()).toEqual({ status: "confirmed" });
    const done = await recoveryStatusThroughRoutes(h.app, body.requestId, body.claimSecret);
    expect(done.status).toBe(201);
    expect(await handleOf(done)).toBe(handle);
  });
});

describe("authenticator-code recovery", () => {
  // A completed email or authenticator recovery refuses a second one for 72
  // hours, so each identifier form gets its own account.
  it("signs in with `@` and the handle in capitals", async () => {
    const h = makeApp();
    const secret = await withTotp(h, "rt-handle@example.com", "rthandle");

    const res = await h.post("/login/recovery/totp/complete", {
      identifier: "@RTHandle",
      code: await nextTotpCode(secret),
    });
    expect(res.status).toBe(200);
    expect(await handleOf(res)).toBe("rthandle");
  });

  it("signs in with the email address in capitals", async () => {
    const h = makeApp();
    const secret = await withTotp(h, "rt-mail@example.com", "rtmail");

    const res = await h.post("/login/recovery/totp/complete", {
      identifier: "RT-Mail@Example.COM",
      code: await nextTotpCode(secret),
    });
    expect(res.status).toBe(200);
    expect(await handleOf(res)).toBe("rtmail");
  });
});

describe("an account stored with capitals before the database refused them", () => {
  // Such a row signs in as it did before: by the address exactly as stored.
  // The lookup matches the address as typed as well as lower-cased, and
  // prefers the row stored exactly as typed. Each test goes red on matching
  // the lower-cased form alone.
  it("is found by its address typed exactly as stored", async () => {
    const h = makeApp();
    const credentialId = await withStoredCapitals(h, "acc_legacy", "Legacy.Case@Example.com");

    expect(await offered(h, "Legacy.Case@Example.com")).toEqual([credentialId]);
    const res = await h.post("/login/passkey/complete", {
      identifier: "Legacy.Case@Example.com",
      assertion: fakeAssertion(credentialId),
    });
    expect(res.status).toBe(200);
    expect(await handleOf(res)).toBe("acc_legacy");
  });

  it("is told apart from an account whose address differs only in case", async () => {
    // Typed exactly, each address reaches its own account; typed in a third
    // case, the lower-case one. Goes red on taking the first row the
    // statement returns rather than the one stored as typed.
    const h = makeApp();
    const lower = await withPasskey(h, "pair@example.com", "pairlower");
    const upper = await withStoredCapitals(h, "acc_pair", "Pair@example.com");

    expect(await offered(h, "Pair@example.com")).toEqual([upper]);
    expect(await offered(h, "pair@example.com")).toEqual([lower]);
    expect(await offered(h, "PAIR@Example.com")).toEqual([lower]);
  });

  it("signs neither twin in with the other's passkey, though they share a challenge key", async () => {
    // Both twins' begins park their challenge under the lower-cased address,
    // so the only thing stopping one twin's passkey from completing as the
    // other is the check that the credential belongs to the account the
    // identifier resolves. Goes red on removing that check.
    const h = makeApp();
    await withPasskey(h, "pair@example.com", "pairlower");
    const upper = await withStoredCapitals(h, "acc_pair", "Pair@example.com");

    expect(await offered(h, "Pair@example.com")).toEqual([upper]);
    const crossed = await h.post("/login/passkey/complete", {
      identifier: "pair@example.com",
      assertion: fakeAssertion(upper),
    });
    expect(crossed.status).toBe(400);
    expect(await crossed.json()).toEqual({ error: "invalid_request" });
    expect(crossed.headers.get("set-cookie")).toBeNull();

    expect(await offered(h, "Pair@example.com")).toEqual([upper]);
    const own = await h.post("/login/passkey/complete", {
      identifier: "Pair@example.com",
      assertion: fakeAssertion(upper),
    });
    expect(own.status).toBe(200);
    expect(await handleOf(own)).toBe("acc_pair");
  });

  it("is told apart from a twin with several profiles whose address sorts first", async () => {
    // The lookup joins a row per profile. A Georgian capital (U+1C90) sorts
    // after its lower-case letter (U+10D0), so the lower-case twin's rows come
    // back first; with two profiles they fill any LIMIT 2. Goes red on picking
    // the typed row from the first rows returned instead of ordering by it.
    const h = makeApp();
    const twin = await h.svc(h.auth.registerProfile("\u10D0@example.com", "geotwin"));
    const lower = await enrolPasskey(h, twin.accountId);
    addProfile(h, twin.accountId, "geotwin2", false);
    const upper = await withStoredCapitals(h, "acc_geo", "\u1C90@example.com");

    expect(await offered(h, "\u1C90@example.com")).toEqual([upper]);
    expect(await offered(h, "\u10D0@example.com")).toEqual([lower]);
  });
});

describe("an account with several profiles", () => {
  it("signs in by its email to its default profile", async () => {
    // Goes red on dropping the default-first order: the join then yields the
    // profiles in the order they were made.
    const h = makeApp();
    const first = await h.svc(h.auth.registerProfile("multi@example.com", "multione"));
    const credentialId = await enrolPasskey(h, first.accountId);
    h.sqlite.query("UPDATE users SET is_default = 0 WHERE id = ?").run(first.id);
    addProfile(h, first.accountId, "multitwo", true);

    expect(await offered(h, "Multi@Example.com")).toEqual([credentialId]);
    const res = await h.post("/login/passkey/complete", {
      identifier: "Multi@Example.com",
      assertion: fakeAssertion(credentialId),
    });
    expect(res.status).toBe(200);
    expect(await handleOf(res)).toBe("multitwo");
  });
});

describe("refusals answer the same, whatever the case", () => {
  /** Status and body, the whole of what a caller can read. */
  const answer = async (res: Response) => ({ status: res.status, body: await res.json() });

  it("passkey sign-in offers one made-up credential for an unknown identifier in any case", async () => {
    const h = makeApp();
    const stored = await withPasskey(h, "pk-real@example.com", "pkreal");

    for (const identifier of ["nobody@example.com", "Nobody@Example.COM", "@NoBody", " nobody "]) {
      const ids = await offered(h, identifier);
      expect(ids).toHaveLength(1);
      expect(ids[0]).not.toBe(stored);
    }
  });

  it("each recovery route answers an unknown identifier in capitals as one in lower case, and as a wrong code", async () => {
    const h = makeApp();
    const known = await h.svc(h.auth.registerProfile("known@example.com", "known"));
    await h.svc(h.auth.generateRecoveryCodesForAccount(known.accountId));

    for (const path of ["/login/recovery/complete", "/login/recovery/totp/complete"]) {
      const code = path === "/login/recovery/complete" ? "dead-beef-cafe-0000" : "000000";
      const lower = await answer(await h.post(path, { identifier: "nobody@example.com", code }));
      const upper = await answer(await h.post(path, { identifier: "Nobody@Example.COM", code }));
      const wrong = await answer(await h.post(path, { identifier: "KNOWN@Example.com", code }));
      expect(lower.status).toBeGreaterThanOrEqual(400);
      expect(upper).toEqual(lower);
      expect(wrong).toEqual(lower);
    }
  });
});
