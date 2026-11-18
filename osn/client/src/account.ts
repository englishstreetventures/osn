/**
 * Account-level client helpers: the step-up-gated email change, and account
 * deletion. Kept in its own module so the settings UI can import only what it
 * needs without dragging in the full Effect service.
 */

import { OsnApiError } from "./api-error";
import { reach, readJson, responseError } from "./auth-fetch";
import { errorCode, safeJson } from "./response-body";
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
 * `deleteAccount` refused with what the person must look at again, from the
 * refusal's body:
 *
 * - `open_actions` (409): the actions still waiting for an answer;
 * - `stale_choices` (409): an answer names an app action the server's fresh
 *   preview no longer lists — the fresh preview;
 * - `could_not_check` (409): an app could not be asked — the fresh preview,
 *   whose `could_not_check` names it;
 * - `invalid_choice` (400): the action whose answer was refused.
 */
export class AccountDeletionRefusedError extends AccountError {
  declare readonly code: "open_actions" | "stale_choices" | "could_not_check" | "invalid_choice";
  /** With `open_actions`: the actions that still need an answer. */
  declare readonly openActions: readonly AccountDeletionOpenAction[] | undefined;
  /** With `stale_choices` and `could_not_check`: the server's fresh preview. */
  declare readonly preview: AccountDeletionPreview | undefined;
  /** With `invalid_choice`: the action whose answer was refused. */
  declare readonly action: string | undefined;

  constructor(
    status: number,
    code: AccountDeletionRefusedError["code"],
    detail: {
      openActions?: readonly AccountDeletionOpenAction[];
      preview?: AccountDeletionPreview;
      action?: string;
    },
  ) {
    super(`Account deletion refused: ${code}`, status, code);
    this.name = "AccountDeletionRefusedError";
    Object.defineProperty(this, "openActions", { value: detail.openActions, enumerable: true });
    Object.defineProperty(this, "preview", { value: detail.preview, enumerable: true });
    Object.defineProperty(this, "action", { value: detail.action, enumerable: true });
  }
}

/** A downloaded copy of the account's data. */
export interface AccountExport {
  readonly blob: Blob;
  /** The name the server gave the file, when the browser can read it; null otherwise. */
  readonly fileName: string | null;
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
    /**
     * Answers to the open actions `getAccountDeletionPreview` lists, one per
     * action id. An open action with choices and no default needs one, or the
     * call is refused at 409 with code `open_actions`; a choice the action
     * does not offer, or a successor who is not a member, at 400 with code
     * `invalid_choice`; an answer to an app action the server's fresh preview
     * no longer lists, at 409 with code `stale_choices`. While an app cannot
     * be asked, the call is refused at 409 with code `could_not_check`.
     */
    choices?: readonly AccountDeletionChoice[];
    /**
     * Delete everything: every app erases the person's data soonest, and
     * each organisation passes to a successor where one exists. Refused at
     * 400 (`choices_with_delete_everything`) together with `choices`.
     */
    deleteEverything?: boolean;
  }): Promise<{ scheduled_for: number; already_pending: boolean }>;

  /**
   * Cancels a pending deletion during the 7-day grace window, with a fresh
   * step-up token for `account_restore`. Any live session of the account may
   * call it, a pending-deletion one included. With nothing pending it answers
   * `cancelled: false` and the token is not checked.
   */
  cancelAccountDeletion(input: {
    /** Fresh step-up token for `account_restore`. */
    stepUpToken: string;
  }): Promise<{ cancelled: boolean }>;

  /**
   * Returns the current deletion status. The UI uses this to decide
   * whether to show the "scheduled for deletion" banner.
   */
  getAccountDeletionStatus(): Promise<
    { scheduled: false } | { scheduled: true; scheduledFor: number; softDeletedAt: number }
  >;

  /**
   * What deleting the account would leave open, as
   * `GET /account/deletion-preview` answers it: each organisation a profile
   * of the account owns, who would take it over, and the choices the person
   * may make; each app's open actions; and each app that could not be asked.
   */
  getAccountDeletionPreview(): Promise<AccountDeletionPreview>;

  /**
   * Downloads a copy of the account's data (`GET /account/export`), with a
   * fresh step-up token for `account_export`. One download a day per account:
   * the next is refused at 429. A session whose account's deletion is pending
   * may call it.
   */
  exportAccount(input: { stepUpToken: string; signal?: AbortSignal }): Promise<AccountExport>;

  /**
   * Emails the account's own address a link to the page that downloads its
   * data (`POST /account/data-link`). The email holds no data and the link
   * no token. Three a day per account; the next is refused at 429.
   */
  sendDataLink(): Promise<{ sent: true }>;
}

/** One answer to an open action, for `deleteAccount`. */
export interface AccountDeletionChoice {
  /** The open action's `id`: `osn:organisation:<orgId>`, or `<app>:…`. */
  readonly action: string;
  /** One of the action's `choices`. */
  readonly choice: string;
  /** The member to hand an organisation to, with `successor`. */
  readonly successorProfileId?: string;
}

/**
 * One thing the person must know about, or answer, before the account is
 * deleted: an organisation a profile of the account owns (`app: "osn"`), or
 * something an app holds. Field names are the route's own.
 */
export interface AccountDeletionOpenAction {
  /** What an {@link AccountDeletionChoice} names as its `action`. */
  readonly id: string;
  /** `osn`, or the app that holds it. */
  readonly app: string;
  readonly kind: string;
  readonly label: string;
  /**
   * What the person may answer, each with a sentence to show and the date
   * (unix seconds) the data it keeps is erased: null when it keeps nothing
   * past the deletion. None: the action is shown for information only.
   */
  readonly choices: ReadonlyArray<{
    readonly choice: string;
    readonly description: string;
    readonly erased_on: number | null;
  }>;
  /** What happens with no answer; null on an action with choices means it needs one. */
  readonly default_choice: string | null;
  /** Where the person can deal with it in the app. */
  readonly link: string | null;
  /** An organisation's id, handle and name; organisations only. */
  readonly organisation?: {
    readonly id: string;
    readonly handle: string;
    readonly name: string;
  };
  /** The member an organisation passes to with no successor named; null when there is none. */
  readonly successor?: {
    readonly profile_id: string;
    readonly handle: string;
    readonly display_name: string | null;
    readonly role: "admin" | "member";
  } | null;
  /**
   * The members a `successor` answer may name, in succession order, at most
   * 50: every member from another account. Organisations only.
   */
  readonly candidates?: ReadonlyArray<{
    readonly profile_id: string;
    readonly handle: string;
    readonly display_name: string | null;
    readonly role: "admin" | "member";
  }>;
}

/** `GET /account/deletion-preview`'s answer. */
export interface AccountDeletionPreview {
  readonly open_actions: readonly AccountDeletionOpenAction[];
  /** Each app that could not be asked; the deletion waits until it answers. */
  readonly could_not_check: readonly string[];
}

/** `DELETE /account`'s body, in the route's field names. */
interface DeleteAccountBody {
  confirm_handle: string;
  step_up_token: string;
  delete_everything?: boolean;
  choices?: Array<{
    action: string;
    choice: AccountDeletionChoice["choice"];
    successor_profile_id: string | undefined;
  }>;
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

/** The refusal codes whose body tells the person what to look at again. */
const DETAILED_REFUSALS = new Set([
  "open_actions",
  "stale_choices",
  "could_not_check",
  "invalid_choice",
]);

/**
 * `DELETE /account`. A refusal that carries what to look at again is an
 * {@link AccountDeletionRefusedError}; every other is an `AccountError`.
 */
async function sendDelete(authFetch: AuthFetch, url: string, body: unknown) {
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
  if (!res.ok) {
    const answer = await safeJson<{
      open_actions?: unknown;
      could_not_check?: unknown;
      action?: unknown;
    }>(res);
    const code = errorCode(answer);
    if (answer !== null && code !== undefined && DETAILED_REFUSALS.has(code)) {
      const openActions = Array.isArray(answer.open_actions)
        ? (answer.open_actions as readonly AccountDeletionOpenAction[])
        : undefined;
      const preview =
        openActions !== undefined && Array.isArray(answer.could_not_check)
          ? {
              open_actions: openActions,
              could_not_check: answer.could_not_check as readonly string[],
            }
          : undefined;
      throw new AccountDeletionRefusedError(
        res.status,
        code as AccountDeletionRefusedError["code"],
        {
          openActions: code === "open_actions" ? openActions : undefined,
          preview: code === "stale_choices" || code === "could_not_check" ? preview : undefined,
          action: typeof answer.action === "string" ? answer.action : undefined,
        },
      );
    }
    throw responseError(AccountError, res, answer);
  }
  return readJson<{ scheduled_for: number; already_pending: boolean }>(AccountError, res);
}

/** The file name a `Content-Disposition: attachment; filename="…"` header gives, if readable. */
function attachmentName(header: string | null): string | null {
  const match = header?.match(/filename="([^"]+)"/);
  return match?.[1] ?? null;
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
    deleteAccount: (input) => {
      const body: DeleteAccountBody = {
        confirm_handle: input.confirmHandle,
        step_up_token: input.stepUpToken,
      };
      if (input.deleteEverything === true) body.delete_everything = true;
      if (input.choices !== undefined) {
        body.choices = input.choices.map((c) => ({
          action: c.action,
          choice: c.choice,
          successor_profile_id: c.successorProfileId,
        }));
      }
      return sendDelete(authFetch, `${base}/account`, body);
    },
    cancelAccountDeletion: (input) =>
      postJson<{ cancelled: boolean }>(authFetch, `${base}/account/restore`, {
        step_up_token: input.stepUpToken,
      }),
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
    getAccountDeletionPreview: async () => {
      const raw = await getJson<Partial<AccountDeletionPreview>>(
        authFetch,
        `${base}/account/deletion-preview`,
      );
      if (!Array.isArray(raw.open_actions) || !Array.isArray(raw.could_not_check)) {
        throw new AccountError("Unexpected deletion preview answer", 200);
      }
      return { open_actions: raw.open_actions, could_not_check: raw.could_not_check };
    },
    exportAccount: async (input) => {
      const res = await reach(
        AccountError,
        `${base}/account/export`,
        {
          method: "GET",
          credentials: "include",
          headers: { "X-Step-Up-Token": input.stepUpToken },
          signal: input.signal,
        },
        authFetch,
      );
      if (!res.ok) throw responseError(AccountError, res, await safeJson(res));
      return {
        blob: await res.blob(),
        fileName: attachmentName(res.headers.get("content-disposition")),
      };
    },
    sendDataLink: async () => {
      const raw = await postJson<{ sent?: unknown }>(authFetch, `${base}/account/data-link`, {});
      if (raw.sent !== true) throw new AccountError("Unexpected data link answer", 202);
      return { sent: true };
    },
  };
}
