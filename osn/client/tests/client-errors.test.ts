import { afterEach, describe, expect, it, vi } from "vitest";

import { AccountError, createAccountClient } from "../src/account";
import { OsnApiError } from "../src/api-error";
import { AuthorizeError, createAuthorizeClient } from "../src/authorize";
import { ConnectionsError, createConnectionsClient } from "../src/connections";
import { createEmailLinkClient, EmailLinkError } from "../src/email-link";
import {
  ActiveProfileResetError,
  AuthExpiredError,
  StorageError,
  TokenRefreshError,
} from "../src/errors";
import { createGraphClient, GraphClientError } from "../src/graph";
import { createLoginClient, LoginError } from "../src/login";
import { createOrgClient, OrgClientError } from "../src/organisations";
import { createPasskeysClient, PasskeysError } from "../src/passkeys";
import { createRecommendationClient, RecommendationClientError } from "../src/recommendations";
import { createRecoveryClient, RecoveryError } from "../src/recovery";
import { createRegistrationClient, RegistrationError } from "../src/register";
import type { AuthFetch } from "../src/runtime";
import { createSecurityEventsClient, SecurityEventsError } from "../src/security-events";
import { createSessionsClient, SessionsError } from "../src/sessions";
import { createStepUpClient, StepUpError } from "../src/step-up";
import { createTotpClient, TotpError } from "../src/totp";

const config = { issuerUrl: "https://osn.example.com" };
const TOKEN = "acc_token";

/**
 * Stands in for the page runtime's `authFetch`: it sends through the stubbed
 * global `fetch`, so each case below reaches the client's own error handling.
 * P9 swaps in a rejection the runtime gives.
 */
const sendThroughFetch: AuthFetch = (input, init) => fetch(input, init);
let sendThrough: AuthFetch = sendThroughFetch;
const authFetch: AuthFetch = (input, init) => sendThrough(input, init);
const authed = { ...config, authFetch };

const login = createLoginClient(config);
const stepUp = createStepUpClient(authed);
const passkeys = createPasskeysClient(authed);
const account = createAccountClient(authed);
const register = createRegistrationClient(config);
const emailLink = createEmailLinkClient(config);
const recovery = createRecoveryClient(authed);
const events = createSecurityEventsClient(authed);
const connections = createConnectionsClient(authed);
const totp = createTotpClient(authed);
const sessions = createSessionsClient(authed);
const graph = createGraphClient(authed);
const orgs = createOrgClient(authed);
const recs = createRecommendationClient(authed);

interface Site {
  name: string;
  ErrorClass: abstract new (...args: never[]) => OsnApiError;
  call: () => Promise<unknown>;
  /** False for the calls that read no body on success, so a non-JSON 2xx resolves. */
  readsBody: boolean;
}

const site = (
  name: string,
  ErrorClass: Site["ErrorClass"],
  call: () => Promise<unknown>,
  readsBody = true,
): Site => ({ name, ErrorClass, call, readsBody });

/**
 * One entry per client method that can throw, except in the three modules
 * built on `createAuthFetchers` (graph, organisations, recommendations),
 * which share one throw site per helper: there, one method per helper.
 */
const SITES: Site[] = [
  site("login.passkeyBegin", LoginError, () => login.passkeyBegin("alice")),
  site("login.passkeyComplete", LoginError, () =>
    login.passkeyComplete({ identifier: "alice", assertion: {} }),
  ),
  site("stepUp.passkeyBegin", StepUpError, () => stepUp.passkeyBegin()),
  site("stepUp.passkeyComplete", StepUpError, () => stepUp.passkeyComplete({ assertion: {} })),
  site("stepUp.emailBegin", StepUpError, () => stepUp.emailBegin({ purpose: "account_export" })),
  site("stepUp.totpComplete", StepUpError, () => stepUp.totpComplete({ code: "123456" })),
  site("passkeys.list", PasskeysError, () => passkeys.list()),
  site("passkeys.rename", PasskeysError, () =>
    passkeys.rename({ id: "pk_1", label: "Laptop", stepUpToken: "su" }),
  ),
  site("passkeys.delete", PasskeysError, () => passkeys.delete({ id: "pk_1", stepUpToken: "su" })),
  site("passkeys.registerBegin", PasskeysError, () =>
    passkeys.registerBegin({ profileId: "usr_1", stepUpToken: "su" }),
  ),
  site("passkeys.registerComplete", PasskeysError, () =>
    passkeys.registerComplete({ profileId: "usr_1", attestation: {} }),
  ),
  site("account.changeEmailBegin", AccountError, () =>
    account.changeEmailBegin({ newEmail: "b@example.com" }),
  ),
  site("account.changeEmailComplete", AccountError, () =>
    account.changeEmailComplete({
      requestId: "emailchange_0123456789ab",
      claimSecret: "c",
      stepUpToken: "su",
    }),
  ),
  site("account.deleteAccount", AccountError, () =>
    account.deleteAccount({ confirmHandle: "alice", stepUpToken: "su" }),
  ),
  site("account.cancelAccountDeletion", AccountError, () => account.cancelAccountDeletion()),
  site("account.getAccountDeletionStatus", AccountError, () => account.getAccountDeletionStatus()),
  site("register.checkHandle", RegistrationError, () => register.checkHandle("alice")),
  site("register.beginRegistration", RegistrationError, () =>
    register.beginRegistration({
      email: "a@example.com",
      handle: "alice",
      birthdate: "1990-01-01",
    }),
  ),
  site("register.resendRegistrationLink", RegistrationError, () =>
    register.resendRegistrationLink({ requestId: "signup_0123456789ab", claimSecret: "c" }),
  ),
  site("register.passkeyRegisterBegin", RegistrationError, () =>
    register.passkeyRegisterBegin({ profileId: "usr_1", accessToken: TOKEN }),
  ),
  site("register.passkeyRegisterComplete", RegistrationError, () =>
    register.passkeyRegisterComplete({ profileId: "usr_1", accessToken: TOKEN, attestation: {} }),
  ),
  site("recovery.generateRecoveryCodes", RecoveryError, () =>
    recovery.generateRecoveryCodes({ stepUpToken: "su" }),
  ),
  site("recovery.getRecoveryCodesStatus", RecoveryError, () => recovery.getRecoveryCodesStatus()),
  site("recovery.loginWithRecoveryCode", RecoveryError, () =>
    recovery.loginWithRecoveryCode({ identifier: "alice", code: "abcd-efgh" }),
  ),
  site("recovery.emailRecoveryBegin", RecoveryError, () =>
    recovery.emailRecoveryBegin({ identifier: "a@example.com" }),
  ),
  site("recovery.emailRecoveryResend", RecoveryError, () =>
    recovery.emailRecoveryResend({ requestId: "recovery_0123456789ab", claimSecret: "c" }),
  ),
  site("recovery.totpRecoveryComplete", RecoveryError, () =>
    recovery.totpRecoveryComplete({ identifier: "alice", code: "123456" }),
  ),
  site("recovery.disown", RecoveryError, () => recovery.disown({ token: "tok" }), false),
  site("events.list", SecurityEventsError, () => events.list()),
  site("events.acknowledge", SecurityEventsError, () =>
    events.acknowledge({ id: "ev_1", stepUpToken: "su" }),
  ),
  site("events.acknowledgeAll", SecurityEventsError, () =>
    events.acknowledgeAll({ stepUpToken: "su" }),
  ),
  site("connections.list", ConnectionsError, () => connections.list()),
  site("connections.revoke", ConnectionsError, () => connections.revoke({ clientId: "app" })),
  site("totp.enrollBegin", TotpError, () => totp.enrollBegin({ stepUpToken: "su" })),
  site("totp.enrollComplete", TotpError, () => totp.enrollComplete({ code: "123456" })),
  site("totp.disable", TotpError, () => totp.disable({ stepUpToken: "su" })),
  site("totp.status", TotpError, () => totp.status()),
  site("sessions.list", SessionsError, () => sessions.list()),
  site("sessions.revoke", SessionsError, () => sessions.revoke({ id: "s1" })),
  site("sessions.revokeAllOther", SessionsError, () => sessions.revokeAllOther()),
  site("graph.listConnections", GraphClientError, () => graph.listConnections()),
  site("graph.removeConnection", GraphClientError, () => graph.removeConnection("bob")),
  site("orgs.getOrg", OrgClientError, () => orgs.getOrg("acme")),
  site("orgs.createOrg", OrgClientError, () => orgs.createOrg({ handle: "acme", name: "Acme" })),
  site("orgs.updateOrg", OrgClientError, () => orgs.updateOrg("acme", { name: "Acme" })),
  site("orgs.deleteOrg", OrgClientError, () => orgs.deleteOrg("acme"), false),
  site("recs.search", RecommendationClientError, () => recs.search("ali")),
];

function stubFetch(respond: () => Response | Promise<Response>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => respond()),
  );
}

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

/** The rejection of `call`, failing the test if it resolves. */
async function rejectionOf(call: () => Promise<unknown>): Promise<unknown> {
  try {
    await call();
  } catch (err) {
    return err;
  }
  throw new Error("expected the call to reject, and it resolved");
}

afterEach(() => {
  vi.unstubAllGlobals();
  sendThrough = sendThroughFetch;
});

describe("every client error carries the response's status and the server's code", () => {
  it.each(SITES.map((s) => [s.name, s] as const))(
    "P1 %s: a refusal keeps its status and code",
    async (_name, s) => {
      stubFetch(() => json({ error: "invalid_request" }, 400));
      const err = await rejectionOf(s.call);
      expect(err).toBeInstanceOf(s.ErrorClass);
      expect(err).toBeInstanceOf(OsnApiError);
      expect(err).toMatchObject({ status: 400, code: "invalid_request" });
    },
  );

  it.each(SITES.map((s) => [s.name, s] as const))(
    "P2 %s: a non-JSON error page keeps its status, with no code",
    async (_name, s) => {
      stubFetch(() => new Response("<html>Bad gateway</html>", { status: 502 }));
      const err = await rejectionOf(s.call);
      expect(err).toBeInstanceOf(s.ErrorClass);
      expect(err).toMatchObject({ status: 502, code: undefined });
    },
  );

  const HOSTILE: ReadonlyArray<readonly [string, unknown]> = [
    ["an object", { x: 1 }],
    ["an error's printout", "AuthError: Invalid handle"],
    ["a 65-character string", "a".repeat(65)],
    ["a prototype key", "__proto__"],
    ["a number", 400],
  ];
  it.each(
    SITES.flatMap((s) => HOSTILE.map(([label, value]) => [s.name, label, s, value] as const)),
  )("P3 %s: %s in `error` is not a code", async (_name, _label, s, value) => {
    stubFetch(() => json({ error: value }, 400));
    const err = await rejectionOf(s.call);
    expect(err).toBeInstanceOf(s.ErrorClass);
    expect(err).toMatchObject({ status: 400, code: undefined });
  });

  it.each([
    ["one letter", "a"],
    ["64 characters, the longest code", "a".repeat(64)],
  ] as const)("P3: a code of %s is kept", async (_label, value) => {
    stubFetch(() => json({ error: value }, 400));
    const err = await rejectionOf(() => login.passkeyBegin("alice"));
    expect(err).toBeInstanceOf(LoginError);
    expect(err).toMatchObject({ status: 400, code: value });
  });

  it.each(SITES.map((s) => [s.name, s] as const))(
    "P3 %s: a long server message is capped",
    async (_name, s) => {
      stubFetch(() => json({ error: "x".repeat(300) }, 400));
      const err = (await rejectionOf(s.call)) as Error;
      expect(err.message).toBe(`${"x".repeat(200)}…`);
    },
  );

  it.each(SITES.filter((s) => s.readsBody).map((s) => [s.name, s] as const))(
    "P5 %s: a 2xx whose body is not JSON rejects with its status, with no code",
    async (_name, s) => {
      stubFetch(() => new Response("<html>Sign in to the Wi-Fi</html>", { status: 200 }));
      const err = await rejectionOf(s.call);
      expect(err).toBeInstanceOf(s.ErrorClass);
      expect(err).toMatchObject({ status: 200, code: undefined });
    },
  );

  /**
   * A 2xx body of the wrong shape: a site with a shape check rejects, one
   * without returns the body as sent, and `login.passkeyComplete` fails
   * decoding the session. None may read the body's `error` field as a code.
   */
  const settleWrongShape = async (s: Site) => {
    stubFetch(() => json({ error: "rate_limited" }, 200));
    try {
      await s.call();
      return undefined;
    } catch (err) {
      return { err };
    }
  };

  it.each(SITES.filter((s) => s.readsBody).map((s) => [s.name, s] as const))(
    "P5 %s: an `error` field in a 2xx body is never read as a code",
    async (_name, s) => {
      const err = (await settleWrongShape(s))?.err;
      expect((err as { code?: unknown } | undefined)?.code).toBeUndefined();
      // A client error, when it is one, is this site's own at the 2xx status.
      const typed =
        err instanceof OsnApiError
          ? { status: err.status, own: err instanceof s.ErrorClass }
          : undefined;
      expect([undefined, { status: 200, own: true }]).toContainEqual(typed);
    },
  );

  it("P5: some sites refuse a 2xx body of the wrong shape with their own error", async () => {
    const typed = [];
    for (const s of SITES.filter((x) => x.readsBody)) {
      const outcome = await settleWrongShape(s);
      if (outcome?.err instanceof OsnApiError) typed.push(s.name);
    }
    expect(typed.length).toBeGreaterThan(0);
  });

  it.each(SITES.filter((s) => !s.readsBody).map((s) => [s.name, s] as const))(
    "P5 %s: reads no body on success, so an empty or non-JSON 2xx resolves",
    async (name, s) => {
      const status = name === "orgs.deleteOrg" ? 204 : 202;
      stubFetch(() => new Response(null, { status }));
      await expect(s.call()).resolves.toBeUndefined();
      stubFetch(() => new Response("<html>Sign in to the Wi-Fi</html>", { status: 200 }));
      await expect(s.call()).resolves.toBeUndefined();
    },
  );

  it.each(SITES.map((s) => [s.name, s] as const))(
    "P6 %s: a transport failure becomes the client's error at status 0",
    async (_name, s) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(() => Promise.reject(new TypeError("Failed to fetch"))),
      );
      const err = await rejectionOf(s.call);
      expect(err).toBeInstanceOf(s.ErrorClass);
      expect(err).toMatchObject({ status: 0, code: undefined });
    },
  );

  it.each([
    ["register.checkHandle", (signal: AbortSignal) => register.checkHandle("alice", signal)],
    ["recs.search", (signal: AbortSignal) => recs.search("ali", { signal })],
  ] as const)("P7 %s: the caller's own abort passes through untouched", async (_name, call) => {
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init?: RequestInit) =>
        init?.signal?.aborted
          ? Promise.reject(init.signal.reason)
          : Promise.resolve(json({ available: true }, 200)),
      ),
    );
    const controller = new AbortController();
    controller.abort();
    const err = await rejectionOf(() => call(controller.signal));
    expect(err).not.toBeInstanceOf(OsnApiError);
    expect(err).toMatchObject({ name: "AbortError" });
  });
});

/**
 * The calls that answer a refusal instead of throwing it: the sign-up and
 * recovery status polls and the emailed link's two calls read every 4xx but a
 * 429 as `expired`. What they do throw follows every other client's contract.
 */
const ANSWERING_SITES: Site[] = [
  site("register.registrationStatus", RegistrationError, () =>
    register.registrationStatus({ requestId: "signup_0123456789ab", claimSecret: "c" }),
  ),
  site("recovery.emailRecoveryStatus", RecoveryError, () =>
    recovery.emailRecoveryStatus({ requestId: "recovery_0123456789ab", claimSecret: "c" }),
  ),
  site("emailLink.candidates", EmailLinkError, () =>
    emailLink.candidates("signup_0123456789ab", "s"),
  ),
  site("emailLink.confirm", EmailLinkError, () =>
    emailLink.confirm("signup_0123456789ab", { linkSecret: "s", pick: "12" }),
  ),
];

describe("the calls that answer a refusal", () => {
  it.each(ANSWERING_SITES.map((s) => [s.name, s] as const))(
    "%s: a 429 keeps its status and code",
    async (_name, s) => {
      stubFetch(() => json({ error: "rate_limited" }, 429));
      const err = await rejectionOf(s.call);
      expect(err).toBeInstanceOf(s.ErrorClass);
      expect(err).toBeInstanceOf(OsnApiError);
      expect(err).toMatchObject({ status: 429, code: "rate_limited" });
    },
  );

  it.each(ANSWERING_SITES.map((s) => [s.name, s] as const))(
    "%s: a non-JSON error page keeps its status, with no code",
    async (_name, s) => {
      stubFetch(() => new Response("<html>Bad gateway</html>", { status: 502 }));
      const err = await rejectionOf(s.call);
      expect(err).toBeInstanceOf(s.ErrorClass);
      expect(err).toMatchObject({ status: 502, code: undefined });
    },
  );

  it.each(ANSWERING_SITES.map((s) => [s.name, s] as const))(
    "%s: a 2xx whose body is not JSON rejects with its status, with no code",
    async (_name, s) => {
      stubFetch(() => new Response("<html>Sign in to the Wi-Fi</html>", { status: 200 }));
      const err = await rejectionOf(s.call);
      expect(err).toBeInstanceOf(s.ErrorClass);
      expect(err).toMatchObject({ status: 200, code: undefined });
    },
  );

  it.each(ANSWERING_SITES.map((s) => [s.name, s] as const))(
    "%s: a transport failure becomes the client's error at status 0",
    async (_name, s) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(() => Promise.reject(new TypeError("Failed to fetch"))),
      );
      const err = await rejectionOf(s.call);
      expect(err).toBeInstanceOf(s.ErrorClass);
      expect(err).toMatchObject({ status: 0, code: undefined });
    },
  );
});

/** The sites that send without the page's `authFetch`. */
const SENDS_WITHOUT_AUTH_FETCH = new Set([
  "recovery.loginWithRecoveryCode",
  "recovery.emailRecoveryBegin",
  "recovery.emailRecoveryResend",
  "recovery.totpRecoveryComplete",
  "recovery.disown",
]);
/**
 * The emailed-link polls and Resends of step-up and email change. They answer
 * a refusal as `expired` rather than throwing it, so they are not in `SITES`;
 * they go through `authFetch` all the same.
 */
const LINK_POLL_SITES: Site[] = [
  site("stepUp.emailStatus", StepUpError, () =>
    stepUp.emailStatus({ requestId: "stepup_0123456789ab", claimSecret: "c" }),
  ),
  site("stepUp.emailResend", StepUpError, () =>
    stepUp.emailResend({ requestId: "stepup_0123456789ab", claimSecret: "c" }),
  ),
  site("account.changeEmailStatus", AccountError, () =>
    account.changeEmailStatus({ requestId: "emailchange_0123456789ab", claimSecret: "c" }),
  ),
  site("account.changeEmailResend", AccountError, () =>
    account.changeEmailResend({ requestId: "emailchange_0123456789ab", claimSecret: "c" }),
  ),
];

const AUTH_FETCH_SITES = [
  ...SITES.filter(
    (s) => !/^(login|register)\./.test(s.name) && !SENDS_WITHOUT_AUTH_FETCH.has(s.name),
  ),
  ...LINK_POLL_SITES,
];

/**
 * What `authFetch` rejects with when the session, not the network, is the
 * problem. A client that wrapped one as its own error at status 0 would hide
 * a sign-out from `isAuthExpiredError` and show the connection sentence.
 */
const SESSION_REJECTIONS = [
  new AuthExpiredError({ cause: "refused" }),
  new TokenRefreshError({ cause: "unreachable" }),
  new ActiveProfileResetError({ profileId: "usr_1", message: "reset" }),
  new StorageError({ cause: "quota" }),
] as const;

describe("a session rejection from authFetch", () => {
  it("P9: covers every authenticated client method", () => {
    expect(AUTH_FETCH_SITES).toHaveLength(39);
  });

  it.each(
    AUTH_FETCH_SITES.flatMap((s) =>
      SESSION_REJECTIONS.map((rejection) => [s.name, rejection._tag, s, rejection] as const),
    ),
  )("P9 %s: %s reaches the caller as it is", async (_name, _tag, s, rejection) => {
    sendThrough = () => Promise.reject(rejection);
    const err = await rejectionOf(s.call);
    expect(err).toBe(rejection);
  });
});

describe("AuthorizeError in the hierarchy", () => {
  const authorize = createAuthorizeClient(config);

  it("P8: a refusal built by toError keeps its status, code and getters", async () => {
    stubFetch(() => json({ error: "invalid_request" }, 404));
    const err = await rejectionOf(() => authorize.getContext("req_1"));
    expect(err).toBeInstanceOf(AuthorizeError);
    expect(err).toBeInstanceOf(OsnApiError);
    expect(err).toMatchObject({ name: "AuthorizeError", status: 404, code: "invalid_request" });
    expect((err as AuthorizeError).terminal).toBe(true);
  });

  it("P8: a 429 keeps status 429 and code rate_limited", async () => {
    stubFetch(() => json({ error: "rate_limited" }, 429));
    const err = await rejectionOf(() => authorize.getContext("req_1"));
    expect(err).toBeInstanceOf(OsnApiError);
    expect(err).toMatchObject({ status: 429, code: "rate_limited" });
  });

  it("P8: a transport failure is status 0, code unknown", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new TypeError("Failed to fetch"))),
    );
    const err = await rejectionOf(() => authorize.getContext("req_1"));
    expect(err).toBeInstanceOf(OsnApiError);
    expect(err).toMatchObject({ status: 0, code: "unknown" });
    expect((err as AuthorizeError).needsSignIn).toBe(false);
  });

  it("P8: the constructor's own arguments land on the fields", () => {
    const err = new AuthorizeError("login_required", 400, "Sign in again");
    expect(err).toBeInstanceOf(OsnApiError);
    expect(err).toMatchObject({ status: 400, code: "login_required", message: "Sign in again" });
    expect(err.needsSignIn).toBe(true);
  });
});
