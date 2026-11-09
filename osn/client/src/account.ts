/**
 * Account-level client helpers — currently just the step-up-gated email
 * change ceremony. Kept in its own module so the settings UI can import
 * only what it needs without dragging in the full Effect service.
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

/**
 * A rejection of `authFetch` about the session, or the caller's abort,
 * reaches the caller unchanged (`./auth-fetch.ts`); every other failure is
 * an `AccountError`.
 */
export interface AccountClient {
  /** Sends an OTP to the NEW email address. Does not mutate the account yet. */
  changeEmailBegin(input: { newEmail: string }): Promise<{ sent: true }>;
  /**
   * Swaps the account's email after verifying both the OTP (sent to the
   * new address by `changeEmailBegin`) and a fresh step-up token. Revokes
   * every other session atomically with the email update.
   */
  changeEmailComplete(input: { code: string; stepUpToken: string }): Promise<{ email: string }>;

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
    changeEmailBegin: (input) =>
      postJson<{ sent: true }>(authFetch, `${base}/account/email/begin`, {
        new_email: input.newEmail,
      }),
    changeEmailComplete: (input) =>
      postJson<{ email: string }>(authFetch, `${base}/account/email/complete`, {
        code: input.code,
        step_up_token: input.stepUpToken,
      }),
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
