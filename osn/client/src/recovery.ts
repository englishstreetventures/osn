import { sessionFetch } from "./session-fetch";
import { parseTokenResponse, type Session } from "./tokens";

/**
 * Plain-fetch helpers for Copenhagen Book M2 — recovery codes.
 *
 *  1. `generateRecoveryCodes({ accessToken, stepUpToken })` — authenticated
 *     and step-up gated. Returns the fresh set once; replaces any existing
 *     set on the server.
 *  2. `getRecoveryCodesStatus({ accessToken })` — authenticated. Counts only,
 *     so a settings panel can say "you have none" without a ceremony.
 *  3. `loginWithRecoveryCode({ identifier, code })` — unauthenticated. Burns
 *     the supplied code and establishes a full session + profile. All other
 *     existing sessions for the account are revoked server-side.
 *  4. `emailRecoveryBegin` / `emailRecoveryComplete` / `totpRecoveryComplete` —
 *     unauthenticated account recovery by a factor that is neither a passkey
 *     nor a recovery code. Unlike (3) these establish a RESTRICTED session that
 *     can only enrol a passkey and expires in 15 minutes; a UI must send the
 *     user straight into passkey enrolment. See
 *     `wiki/architecture/account-recovery-factors.md`.
 *
 * Kept in its own module so UI surfaces (settings panel, sign-in recovery
 * modal) can import the exact shape they need without pulling in the full
 * Effect-based `OsnAuth` service.
 */

export interface RecoveryClientConfig {
  /** OSN issuer base URL, e.g. http://localhost:4000 */
  issuerUrl: string;
}

export class RecoveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecoveryError";
  }
}

/** Matches `PublicProfile` in `@osn/api`. */
export interface RecoveryProfile {
  id: string;
  handle: string;
  email: string;
  displayName: string | null;
  avatarUrl: string | null;
}

export interface RecoveryLoginResult {
  session: Session;
  profile: RecoveryProfile;
}

export interface RecoveryCodesStatus {
  /** Codes in the current set that have not been used yet. */
  active: number;
  /** Codes in the current set, used or not. 0 when none were ever generated. */
  total: number;
  /** Unix seconds the current set was minted, or null if there is no set. */
  generatedAt: number | null;
}

export interface RecoveryClient {
  /**
   * Generate a fresh batch of recovery codes. Returns the raw codes exactly
   * once — the caller must display + prompt the user to save them. Replaces
   * any previously generated set.
   *
   * Step-up gated (M-PK1): without a fresh `stepUpToken` the server answers
   * 403 `step_up_required`, so run the step-up ceremony first and pass the
   * token it mints.
   */
  generateRecoveryCodes(input: {
    accessToken: string;
    stepUpToken?: string;
  }): Promise<{ codes: string[] }>;
  /**
   * How many codes the account has left and when the set was minted. Carries
   * no secret, so it needs no step-up.
   */
  getRecoveryCodesStatus(input: { accessToken: string }): Promise<RecoveryCodesStatus>;
  /**
   * Exchange an identifier + recovery code for a session. Consumes the code
   * (single-use) and revokes all other sessions for the account.
   */
  loginWithRecoveryCode(input: { identifier: string; code: string }): Promise<RecoveryLoginResult>;
  /**
   * Ask for an account-recovery code by email. Unauthenticated.
   *
   * `identifier` must be the **email address** on the account — a handle is
   * refused, because this call puts mail in somebody's inbox and a handle is
   * public. Always resolves when the request was accepted; it deliberately does
   * NOT say whether the address matched an account, whether a code was sent, or
   * whether the account has hit its cap, so a caller cannot use it to test
   * whether somebody has an OSN account.
   *
   * Pass `turnstileToken` wherever the sign-in surface renders a widget: once a
   * Turnstile secret is configured the server requires one and fails closed.
   */
  emailRecoveryBegin(input: { identifier: string; turnstileToken?: string }): Promise<void>;
  /**
   * Exchange the emailed code for a **restricted recovery session**. The
   * returned session can do exactly one thing — enrol a passkey — and expires
   * 15 minutes after it is issued. Every other session on the account is
   * revoked.
   */
  emailRecoveryComplete(input: { identifier: string; code: string }): Promise<RecoveryLoginResult>;
  /**
   * The same restricted session, from an authenticator-app code instead. This
   * is the path for somebody who has lost the device AND cannot reach the
   * mailbox. `identifier` may be a handle or an email address.
   */
  totpRecoveryComplete(input: { identifier: string; code: string }): Promise<RecoveryLoginResult>;
  /**
   * Undo a recovery from the "this wasn't me" token in the notice email.
   *
   * Unauthenticated — the person who needs this has just been signed out of
   * everything, and the token is the credential. It revokes the credentials the
   * recovery enrolled, every session on the account, and the recovery window,
   * so the owner can recover again straight away.
   *
   * Resolves on every outcome the server is willing to describe: a good token,
   * a wrong one, a spent one and an expired one all answer 202. Only a refusal
   * the server owes a reason for — a malformed body, a rate limit — rejects.
   */
  disown(input: { token: string }): Promise<void>;
}

export function createRecoveryClient(config: RecoveryClientConfig): RecoveryClient {
  const base = config.issuerUrl.replace(/\/$/, "");

  const generateRecoveryCodes = async (input: { accessToken: string; stepUpToken?: string }) => {
    const res = await fetch(`${base}/recovery/generate`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.accessToken}`,
        "Content-Type": "application/json",
      },
      credentials: "include",
      body: JSON.stringify(input.stepUpToken ? { step_up_token: input.stepUpToken } : {}),
    });
    const json = (await res.json()) as { recoveryCodes?: string[]; error?: string };
    if (!res.ok || !Array.isArray(json.recoveryCodes)) {
      throw new RecoveryError(json.error ?? `Request failed: ${res.status}`);
    }
    return { codes: json.recoveryCodes };
  };

  const getRecoveryCodesStatus = async (input: { accessToken: string }) => {
    const res = await fetch(`${base}/recovery/status`, {
      headers: { Authorization: `Bearer ${input.accessToken}` },
      credentials: "include",
    });
    const json = (await res.json()) as Partial<RecoveryCodesStatus> & { error?: string };
    if (!res.ok || typeof json.active !== "number" || typeof json.total !== "number") {
      throw new RecoveryError(json.error ?? `Request failed: ${res.status}`);
    }
    return {
      active: json.active,
      total: json.total,
      generatedAt: typeof json.generatedAt === "number" ? json.generatedAt : null,
    };
  };

  const loginWithRecoveryCode = async (input: { identifier: string; code: string }) => {
    // `sessionFetch`: this route sets the refresh cookie. See
    // `./session-fetch.ts`.
    const res = await sessionFetch(`${base}/login/recovery/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify(input),
    });
    const json = (await res.json()) as {
      session?: unknown;
      profile?: RecoveryProfile;
      error?: string;
    };
    if (!res.ok || !json.session || !json.profile) {
      throw new RecoveryError(json.error ?? `Request failed: ${res.status}`);
    }
    return {
      session: parseTokenResponse(json.session),
      profile: json.profile,
    };
  };

  const emailRecoveryBegin = async (input: { identifier: string; turnstileToken?: string }) => {
    const res = await fetch(`${base}/login/recovery/email/begin`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify(input),
    });
    // 202 on every outcome the server is willing to describe. Anything else is
    // a refusal it owes the caller a reason for — a malformed identifier, a
    // rate limit, a failed bot check.
    if (!res.ok) {
      const json = (await res.json().catch(() => ({}))) as { error?: string };
      throw new RecoveryError(json.error ?? `Request failed: ${res.status}`);
    }
  };

  /** Shared by the two factor completers — both return the same envelope. */
  const completeFactorLogin = async (path: string, input: { identifier: string; code: string }) => {
    // `sessionFetch`: these routes set the refresh cookie. See
    // `./session-fetch.ts`.
    const res = await sessionFetch(`${base}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify(input),
    });
    const json = (await res.json()) as {
      session?: unknown;
      profile?: RecoveryProfile;
      error?: string;
    };
    if (!res.ok || !json.session || !json.profile) {
      throw new RecoveryError(json.error ?? `Request failed: ${res.status}`);
    }
    return { session: parseTokenResponse(json.session), profile: json.profile };
  };

  const emailRecoveryComplete = (input: { identifier: string; code: string }) =>
    completeFactorLogin("/login/recovery/email/complete", input);

  const totpRecoveryComplete = (input: { identifier: string; code: string }) =>
    completeFactorLogin("/login/recovery/totp/complete", input);

  const disown = async (input: { token: string }) => {
    // No `credentials: "include"`: this route sets no cookie and reads none.
    // Every session on the account is about to be revoked anyway.
    const res = await fetch(`${base}/recovery/disown`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    if (!res.ok) {
      const json = (await res.json().catch(() => ({}))) as { error?: string };
      throw new RecoveryError(json.error ?? `Request failed: ${res.status}`);
    }
  };

  return {
    generateRecoveryCodes,
    getRecoveryCodesStatus,
    loginWithRecoveryCode,
    emailRecoveryBegin,
    emailRecoveryComplete,
    totpRecoveryComplete,
    disown,
  };
}
