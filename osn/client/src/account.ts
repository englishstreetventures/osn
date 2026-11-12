/**
 * Account-level client helpers: the step-up-gated email change, and account
 * deletion. Kept in its own module so the settings UI can import only what it
 * needs without dragging in the full Effect service.
 */

import { OsnApiError } from "./api-error";
import { reach, readJson } from "./auth-fetch";
import type { AuthFetch } from "./runtime";

export interface AccountClientConfig {
  /** OSN issuer base URL, e.g. http://localhost:4000 */
  issuerUrl: string;
  /** The page runtime's `authFetch` (`createOsnAuthRuntime`). */
  authFetch: AuthFetch;
}

export class AccountError extends OsnApiError {
  constructor(message: string, status: number, code?: string) {
    super(message, status, code);
    this.name = "AccountError";
  }
}

/** An email change this tab began: what it keeps, and the number it shows. */
export interface EmailChangeRequest {
  readonly requestId: string;
  /** Kept by this tab alone, in memory; it completes the change. */
  readonly claimSecret: string;
  /** Shown while waiting: the link's page asks the reader to pick it. Never stored or logged. */
  readonly pairingCode: string;
  /** Unix seconds. */
  readonly expiresAt: number;
}

/** What an email change's status poll learned. `confirmed`: step up, then complete. */
export type EmailChangeStatus =
  | { readonly status: "pending"; readonly pairingCode?: string }
  | { readonly status: "confirmed" }
  | { readonly status: "expired" };

/**
 * A rejection of `authFetch` about the session, or the caller's abort,
 * reaches the caller unchanged (`./auth-fetch.ts`); every other failure is
 * an `AccountError`.
 */
export interface AccountClient {
  /**
   * Mails a link to the NEW address. Does not change the account. Answers the
   * same whether or not another account holds the address.
   */
  changeEmailBegin(input: { newEmail: string }): Promise<EmailChangeRequest>;
  /**
   * Polls the request. `confirmed` once the link is confirmed at the new
   * address. A refusal answers `expired`; a rate limit, a server error or no
   * answer throws, and the caller polls again.
   */
  changeEmailStatus(input: { requestId: string; claimSecret: string }): Promise<EmailChangeStatus>;
  /** Another link for the same request. `limit` once it has sent all it may. */
  changeEmailResend(input: {
    requestId: string;
    claimSecret: string;
  }): Promise<{ status: "sent" | "limit" | "expired" }>;
  /**
   * Moves the account to the new address of a confirmed request, with a fresh
   * step-up token for `email_change`. Revokes every other session atomically
   * with the email update.
   */
  changeEmailComplete(input: {
    requestId: string;
    claimSecret: string;
    stepUpToken: string;
  }): Promise<{ email: string }>;

  /**
   * GDPR Art. 17 — Right of erasure (Flow A — full OSN account deletion).
   *
   * Soft-deletes the account immediately, schedules a hard delete in 7
   * days. The user types their handle verbatim as a confirmation guard.
   * Cross-service fan-out to Pulse / Zap is async — the response returns
   * before fan-out completes; the sweeper retries any failing bridge.
   *
   * Returns 202 with `scheduled_for` (unix seconds). Idempotent on
   * already-pending deletions: `already_pending = true`.
   */
  deleteAccount(input: {
    /** Must equal the user's current handle verbatim. */
    confirmHandle: string;
    /** Fresh step-up token from osn-api's begin/complete ceremony. */
    stepUpToken: string;
  }): Promise<{ scheduled_for: number; already_pending: boolean }>;

  /**
   * Cancels a pending deletion during the 7-day grace window. Must be
   * called from the original requesting session (the only surviving
   * session — we revoked all others at soft-delete time).
   */
  cancelAccountDeletion(): Promise<{ cancelled: boolean }>;

  /**
   * Returns the current deletion status. The UI uses this to decide
   * whether to show the "scheduled for deletion" banner.
   */
  getAccountDeletionStatus(): Promise<
    { scheduled: false } | { scheduled: true; scheduledFor: number; softDeletedAt: number }
  >;
}

async function postJson<T>(authFetch: AuthFetch, url: string, body: unknown): Promise<T> {
  const res = await reach(
    AccountError,
    url,
    {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    authFetch,
  );
  return readJson<T>(AccountError, res);
}

/** The fields the link routes answer with; anything else in the body is ignored. */
interface LinkAnswer {
  readonly status?: unknown;
  readonly pairingCode?: unknown;
}

/**
 * POSTs an email-change link call. Null for a refusal of the request (a 4xx
 * other than a rate limit); throws on a rate limit, a server error or no
 * answer, which a poll retries.
 */
async function postLinkCall(
  authFetch: AuthFetch,
  url: string,
  body: unknown,
): Promise<LinkAnswer | null> {
  const res = await reach(
    AccountError,
    url,
    {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    authFetch,
  );
  if (res.status === 429 || res.status >= 500) {
    throw new AccountError(`Request failed: ${res.status}`, res.status);
  }
  if (!res.ok) return null;
  return readJson<LinkAnswer>(AccountError, res);
}

async function deleteJson<T>(authFetch: AuthFetch, url: string, body: unknown): Promise<T> {
  const res = await reach(
    AccountError,
    url,
    {
      method: "DELETE",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    authFetch,
  );
  return readJson<T>(AccountError, res);
}

async function getJson<T>(authFetch: AuthFetch, url: string): Promise<T> {
  const res = await reach(AccountError, url, { method: "GET", credentials: "include" }, authFetch);
  return readJson<T>(AccountError, res);
}

export function createAccountClient(config: AccountClientConfig): AccountClient {
  const base = config.issuerUrl.replace(/\/$/, "");
  const { authFetch } = config;

  return {
    changeEmailBegin: async (input) => {
      const raw = await postJson<Partial<EmailChangeRequest>>(
        authFetch,
        `${base}/account/email/begin`,
        { new_email: input.newEmail },
      );
      if (
        typeof raw.requestId !== "string" ||
        typeof raw.claimSecret !== "string" ||
        typeof raw.pairingCode !== "string" ||
        typeof raw.expiresAt !== "number"
      ) {
        throw new AccountError("Unexpected email change answer", 200);
      }
      return {
        requestId: raw.requestId,
        claimSecret: raw.claimSecret,
        pairingCode: raw.pairingCode,
        expiresAt: raw.expiresAt,
      };
    },
    changeEmailStatus: async (input) => {
      const raw = await postLinkCall(
        authFetch,
        `${base}/account/email/${encodeURIComponent(input.requestId)}/status`,
        { claimSecret: input.claimSecret },
      );
      if (raw?.status === "confirmed") return { status: "confirmed" };
      if (raw?.status === "pending") {
        return typeof raw.pairingCode === "string"
          ? { status: "pending", pairingCode: raw.pairingCode }
          : { status: "pending" };
      }
      return { status: "expired" };
    },
    changeEmailResend: async (input) => {
      const raw = await postLinkCall(
        authFetch,
        `${base}/account/email/${encodeURIComponent(input.requestId)}/resend`,
        { claimSecret: input.claimSecret },
      );
      const status = raw?.status;
      return status === "sent" || status === "limit" ? { status } : { status: "expired" };
    },
    changeEmailComplete: (input) =>
      postJson<{ email: string }>(
        authFetch,
        `${base}/account/email/${encodeURIComponent(input.requestId)}/complete`,
        { claimSecret: input.claimSecret, step_up_token: input.stepUpToken },
      ),
    deleteAccount: (input) =>
      deleteJson<{ scheduled_for: number; already_pending: boolean }>(
        authFetch,
        `${base}/account`,
        {
          confirm_handle: input.confirmHandle,
          step_up_token: input.stepUpToken,
        },
      ),
    cancelAccountDeletion: () =>
      postJson<{ cancelled: boolean }>(authFetch, `${base}/account/restore`, {}),
    getAccountDeletionStatus: async () => {
      const raw = await getJson<{
        scheduled: boolean;
        scheduledFor?: number;
        softDeletedAt?: number;
      }>(authFetch, `${base}/account/deletion-status`);
      if (!raw.scheduled) return { scheduled: false };
      return {
        scheduled: true,
        scheduledFor: raw.scheduledFor!,
        softDeletedAt: raw.softDeletedAt!,
      };
    },
  };
}
