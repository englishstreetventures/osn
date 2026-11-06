import { afterEach, describe, expect, it, vi } from "vitest";

import { AccountError, createAccountClient } from "../src/account";
import { OsnApiError } from "../src/api-error";
import { AuthorizeError, createAuthorizeClient } from "../src/authorize";
import { ConnectionsError, createConnectionsClient } from "../src/connections";
import { createGraphClient, GraphClientError } from "../src/graph";
import { createLoginClient, LoginError } from "../src/login";
import { createOrgClient, OrgClientError } from "../src/organisations";
import { createPasskeysClient, PasskeysError } from "../src/passkeys";
import { createRecommendationClient, RecommendationClientError } from "../src/recommendations";
import { createRecoveryClient, RecoveryError } from "../src/recovery";
import { createRegistrationClient, RegistrationError } from "../src/register";
import { createSecurityEventsClient, SecurityEventsError } from "../src/security-events";
import { createSessionsClient, SessionsError } from "../src/sessions";
import { createStepUpClient, StepUpError } from "../src/step-up";
import { createTotpClient, TotpError } from "../src/totp";

const config = { issuerUrl: "https://osn.example.com" };
const TOKEN = "acc_token";

const login = createLoginClient(config);
const stepUp = createStepUpClient(config);
const passkeys = createPasskeysClient(config);
const account = createAccountClient(config);
const register = createRegistrationClient(config);
const recovery = createRecoveryClient(config);
const events = createSecurityEventsClient(config);
const connections = createConnectionsClient(config);
const totp = createTotpClient(config);
const sessions = createSessionsClient(config);
const graph = createGraphClient(config);
const orgs = createOrgClient(config);
const recs = createRecommendationClient(config);

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

/** One entry per client method that can throw: every throw site in the package. */
const SITES: Site[] = [
  site("login.passkeyBegin", LoginError, () => login.passkeyBegin("alice")),
  site("login.passkeyComplete", LoginError, () =>
    login.passkeyComplete({ identifier: "alice", assertion: {} }),
  ),
  site("stepUp.passkeyBegin", StepUpError, () => stepUp.passkeyBegin({ accessToken: TOKEN })),
  site("stepUp.passkeyComplete", StepUpError, () =>
    stepUp.passkeyComplete({ accessToken: TOKEN, assertion: {} }),
  ),
  site("stepUp.otpBegin", StepUpError, () => stepUp.otpBegin({ accessToken: TOKEN })),
  site("stepUp.otpComplete", StepUpError, () =>
    stepUp.otpComplete({ accessToken: TOKEN, code: "123456" }),
  ),
  site("stepUp.totpComplete", StepUpError, () =>
    stepUp.totpComplete({ accessToken: TOKEN, code: "123456" }),
  ),
  site("passkeys.list", PasskeysError, () => passkeys.list({ accessToken: TOKEN })),
  site("passkeys.rename", PasskeysError, () =>
    passkeys.rename({ accessToken: TOKEN, id: "pk_1", label: "Laptop", stepUpToken: "su" }),
  ),
  site("passkeys.delete", PasskeysError, () =>
    passkeys.delete({ accessToken: TOKEN, id: "pk_1", stepUpToken: "su" }),
  ),
  site("passkeys.registerBegin", PasskeysError, () =>
    passkeys.registerBegin({ accessToken: TOKEN, profileId: "usr_1", stepUpToken: "su" }),
  ),
  site("passkeys.registerComplete", PasskeysError, () =>
    passkeys.registerComplete({ accessToken: TOKEN, profileId: "usr_1", attestation: {} }),
  ),
  site("account.changeEmailBegin", AccountError, () =>
    account.changeEmailBegin({ accessToken: TOKEN, newEmail: "b@example.com" }),
  ),
  site("account.changeEmailComplete", AccountError, () =>
    account.changeEmailComplete({ accessToken: TOKEN, code: "123456", stepUpToken: "su" }),
  ),
  site("account.deleteAccount", AccountError, () =>
    account.deleteAccount({ accessToken: TOKEN, confirmHandle: "alice", stepUpToken: "su" }),
  ),
  site("account.cancelAccountDeletion", AccountError, () =>
    account.cancelAccountDeletion({ accessToken: TOKEN }),
  ),
  site("account.getAccountDeletionStatus", AccountError, () =>
    account.getAccountDeletionStatus({ accessToken: TOKEN }),
  ),
  site("register.checkHandle", RegistrationError, () => register.checkHandle("alice")),
  site("register.beginRegistration", RegistrationError, () =>
    register.beginRegistration({
      email: "a@example.com",
      handle: "alice",
      birthdate: "1990-01-01",
    }),
  ),
  site("register.completeRegistration", RegistrationError, () =>
    register.completeRegistration({ email: "a@example.com", code: "123456" }),
  ),
  site("register.passkeyRegisterBegin", RegistrationError, () =>
    register.passkeyRegisterBegin({ profileId: "usr_1", accessToken: TOKEN }),
  ),
  site("register.passkeyRegisterComplete", RegistrationError, () =>
    register.passkeyRegisterComplete({ profileId: "usr_1", accessToken: TOKEN, attestation: {} }),
  ),
  site("recovery.generateRecoveryCodes", RecoveryError, () =>
    recovery.generateRecoveryCodes({ accessToken: TOKEN, stepUpToken: "su" }),
  ),
  site("recovery.getRecoveryCodesStatus", RecoveryError, () =>
    recovery.getRecoveryCodesStatus({ accessToken: TOKEN }),
  ),
  site("recovery.loginWithRecoveryCode", RecoveryError, () =>
    recovery.loginWithRecoveryCode({ identifier: "alice", code: "abcd-efgh" }),
  ),
  site(
    "recovery.emailRecoveryBegin",
    RecoveryError,
    () => recovery.emailRecoveryBegin({ identifier: "a@example.com" }),
    false,
  ),
  site("recovery.emailRecoveryComplete", RecoveryError, () =>
    recovery.emailRecoveryComplete({ identifier: "a@example.com", code: "123456" }),
  ),
  site("recovery.totpRecoveryComplete", RecoveryError, () =>
    recovery.totpRecoveryComplete({ identifier: "alice", code: "123456" }),
  ),
  site("recovery.disown", RecoveryError, () => recovery.disown({ token: "tok" }), false),
  site("events.list", SecurityEventsError, () => events.list({ accessToken: TOKEN })),
  site("events.acknowledge", SecurityEventsError, () =>
    events.acknowledge({ accessToken: TOKEN, id: "ev_1", stepUpToken: "su" }),
  ),
  site("events.acknowledgeAll", SecurityEventsError, () =>
    events.acknowledgeAll({ accessToken: TOKEN, stepUpToken: "su" }),
  ),
  site("connections.list", ConnectionsError, () => connections.list({ accessToken: TOKEN })),
  site("connections.revoke", ConnectionsError, () =>
    connections.revoke({ accessToken: TOKEN, clientId: "app" }),
  ),
  site("totp.enrollBegin", TotpError, () =>
    totp.enrollBegin({ accessToken: TOKEN, stepUpToken: "su" }),
  ),
  site("totp.enrollComplete", TotpError, () =>
    totp.enrollComplete({ accessToken: TOKEN, code: "123456" }),
  ),
  site("totp.disable", TotpError, () => totp.disable({ accessToken: TOKEN, stepUpToken: "su" })),
  site("totp.status", TotpError, () => totp.status({ accessToken: TOKEN })),
  site("sessions.list", SessionsError, () => sessions.list({ accessToken: TOKEN })),
  site("sessions.revoke", SessionsError, () => sessions.revoke({ accessToken: TOKEN, id: "s1" })),
  site("sessions.revokeAllOther", SessionsError, () =>
    sessions.revokeAllOther({ accessToken: TOKEN }),
  ),
  site("graph.listConnections", GraphClientError, () => graph.listConnections(TOKEN)),
  site("orgs.getOrg", OrgClientError, () => orgs.getOrg(TOKEN, "acme")),
  site("orgs.deleteOrg", OrgClientError, () => orgs.deleteOrg(TOKEN, "acme"), false),
  site("recs.search", RecommendationClientError, () => recs.search(TOKEN, "ali")),
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

afterEach(() => vi.unstubAllGlobals());

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
    ["recs.search", (signal: AbortSignal) => recs.search(TOKEN, "ali", { signal })],
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
