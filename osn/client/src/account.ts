/**
 * Account-level client helpers — currently just the step-up-gated email
 * change ceremony. Kept in its own module so the settings UI can import
 * only what it needs without dragging in the full Effect service.
 */

export interface AccountClientConfig {
  /** OSN issuer base URL, e.g. http://localhost:4000 */
  issuerUrl: string;
}

export class AccountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AccountError";
  }
}

export interface AccountClient {
  /** Sends an OTP to the NEW email address. Does not mutate the account yet. */
  changeEmailBegin(input: { accessToken: string; newEmail: string }): Promise<{ sent: true }>;
  /**
   * Swaps the account's email after verifying both the OTP (sent to the
   * new address by `changeEmailBegin`) and a fresh step-up token. Revokes
   * every other session atomically with the email update.
   */
  changeEmailComplete(input: {
    accessToken: string;
    code: string;
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
    accessToken: string;
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
  cancelAccountDeletion(input: { accessToken: string }): Promise<{ cancelled: boolean }>;

  /**
   * Returns the current deletion status. The UI uses this to decide
   * whether to show the "scheduled for deletion" banner.
   */
  getAccountDeletionStatus(input: {
    accessToken: string;
  }): Promise<
    { scheduled: false } | { scheduled: true; scheduledFor: number; softDeletedAt: number }
  >;
}

async function postJson<T>(url: string, bearer: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${bearer}`,
    },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as T & { error?: string };
  if (!res.ok) {
    throw new AccountError(json.error ?? `Request failed: ${res.status}`);
  }
  return json;
}

async function deleteJson<T>(url: string, bearer: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "DELETE",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${bearer}`,
    },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as T & { error?: string };
  if (!res.ok && res.status !== 202) {
    throw new AccountError(json.error ?? `Request failed: ${res.status}`);
  }
  return json;
}

async function getJson<T>(url: string, bearer: string): Promise<T> {
  const res = await fetch(url, {
    method: "GET",
    credentials: "include",
    headers: { Authorization: `Bearer ${bearer}` },
  });
  const json = (await res.json()) as T & { error?: string };
  if (!res.ok) {
    throw new AccountError(json.error ?? `Request failed: ${res.status}`);
  }
  return json;
}

export function createAccountClient(config: AccountClientConfig): AccountClient {
  const base = config.issuerUrl.replace(/\/$/, "");

  return {
    changeEmailBegin: (input) =>
      postJson<{ sent: true }>(`${base}/account/email/begin`, input.accessToken, {
        new_email: input.newEmail,
      }),
    changeEmailComplete: (input) =>
      postJson<{ email: string }>(`${base}/account/email/complete`, input.accessToken, {
        code: input.code,
        step_up_token: input.stepUpToken,
      }),
    deleteAccount: (input) =>
      deleteJson<{ scheduled_for: number; already_pending: boolean }>(
        `${base}/account`,
        input.accessToken,
        {
          confirm_handle: input.confirmHandle,
          step_up_token: input.stepUpToken,
        },
      ),
    cancelAccountDeletion: (input) =>
      postJson<{ cancelled: boolean }>(`${base}/account/restore`, input.accessToken, {}),
    getAccountDeletionStatus: async (input) => {
      const raw = await getJson<{
        scheduled: boolean;
        scheduledFor?: number;
        softDeletedAt?: number;
      }>(`${base}/account/deletion-status`, input.accessToken);
      if (!raw.scheduled) return { scheduled: false };
      return {
        scheduled: true,
        scheduledFor: raw.scheduledFor!,
        softDeletedAt: raw.softDeletedAt!,
      };
    },
  };
}
