// A host removing their Cire data and keeping their Musubi account: the three
// calls the "Remove my Cire data" screen makes to cire/api
// (`cire/api/src/routes/organiser-account.ts`), and what the screen keeps in
// `sessionStorage` while the person is on Musubi confirming.
//
// The screen sends the person to Musubi in the same tab, so it keeps their
// answers first, and Musubi sends them back with a code in the address
// (`#/remove-data?code=…`, read by `parseRoute`). The code alone removes
// nothing: cire/api also needs the `cire_removal` cookie this browser was given
// when it asked for the confirmation, which `authFetch` sends with every call.
//
// Read by the screen that draws the removal, and by its tests.
//
// Effect is deliberately NOT imported (frontend code).
import type { AuthFetch } from "@shared/rp-auth";

import { apiUrl } from "./api";
import { OSN_ACCOUNT_URL } from "./osn";

/** A seat's role as the screen shows it: the strongest the person holds there. */
export type RemovalRole = "owner" | "editor" | "viewer" | "helper";

/** One wedding the person holds a seat on, and what the removal does to it. */
export interface RemovalWedding {
  readonly weddingId: string;
  readonly name: string;
  readonly role: RemovalRole;
  /** The person alone owns it: it is deleted unless they add another owner first. */
  readonly soleOwner: boolean;
  /** Already deleted: the removal takes the last seat, and the restore window with it. */
  readonly deleted: boolean;
}

/** An answer the removal needs: one per wedding the person alone owns, or one for them all past 100. */
export interface RemovalAction {
  readonly id: string;
  /** The wedding it names; null for the one action that stands for more than 100. */
  readonly weddingId: string | null;
}

export interface RemovalPlan {
  readonly weddings: readonly RemovalWedding[];
  /** Weddings past the first 200, not listed. */
  readonly more: number;
  readonly openActions: readonly RemovalAction[];
  /** The plan covers every profile of the account: the person has confirmed on Musubi. */
  readonly confirmed: boolean;
}

/** Why a call did not get what it asked for. */
export type RemovalFailure =
  /** 403: no confirmation from Musubi this browser can use; confirm again. */
  | "confirmation_required"
  /** 409 on the confirmation: the account cannot be used here (its deletion is pending). */
  | "account_unavailable"
  /** 503: Cire cannot reach Musubi's identity service now. */
  | "unavailable"
  /** 429: too many tries; wait a minute. */
  | "limit"
  /** Anything else, a 500 included. */
  | "server"
  /** The request never reached cire/api. */
  | "network";

export class RemovalError extends Error {
  constructor(readonly reason: RemovalFailure) {
    super(`Removal failed: ${reason}`);
    this.name = "RemovalError";
  }
}

function failureOf(status: number, error: string | null): RemovalFailure {
  if (status === 403) return "confirmation_required";
  if (status === 409 && error === "account_unavailable") return "account_unavailable";
  if (status === 503) return "unavailable";
  if (status === 429) return "limit";
  return "server";
}

async function send(
  authFetch: AuthFetch,
  method: "POST" | "DELETE",
  path: string,
  body: unknown,
): Promise<Response> {
  try {
    return await authFetch(apiUrl(path), {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    // An expired session is the caller's to handle (`isAuthExpired`).
    if (err instanceof TypeError) throw new RemovalError("network");
    throw err;
  }
}

/** The `error` code a refusal carried, or null. */
async function errorOf(res: Response): Promise<string | null> {
  try {
    const { error } = (await res.json()) as { error?: unknown };
    return typeof error === "string" ? error : null;
  } catch {
    return null;
  }
}

/** What the removal would do: the signed-in profile's weddings, or with `code`, every profile's. */
export async function loadRemovalPlan(authFetch: AuthFetch, code?: string): Promise<RemovalPlan> {
  const res = await send(
    authFetch,
    "POST",
    "/api/organiser/account/removal/preview",
    code === undefined ? {} : { code },
  );
  if (!res.ok) throw new RemovalError(failureOf(res.status, await errorOf(res)));
  return (await res.json()) as RemovalPlan;
}

/**
 * Asks for a confirmation and answers where Musubi confirms it. The browser
 * keeps the request's secret in an HttpOnly cookie; the page never sees it.
 */
export async function beginRemovalConfirmation(authFetch: AuthFetch): Promise<string> {
  const res = await send(authFetch, "POST", "/api/organiser/account/removal/confirmation", {});
  if (!res.ok) throw new RemovalError(failureOf(res.status, await errorOf(res)));
  const { requestId } = (await res.json()) as { requestId: string };
  return `${OSN_ACCOUNT_URL.replace(/\/+$/, "")}/confirm/${encodeURIComponent(requestId)}`;
}

/** What one removal call did. */
export type RemovalOutcome =
  | { readonly status: "done" }
  /** More weddings to go: call again with the same code. */
  | { readonly status: "not_finished" }
  /** Answers missing, on the rows as they stand: the fresh list to answer. */
  | {
      readonly status: "open_actions";
      readonly openActions: readonly RemovalAction[];
      readonly weddings: readonly RemovalWedding[];
      readonly more: number;
    };

/** The removal, with the confirmation's code and the person's answers. */
export async function removeCireData(
  authFetch: AuthFetch,
  input: {
    readonly code: string;
    readonly answered: readonly string[];
    readonly deleteEverything: boolean;
  },
): Promise<RemovalOutcome> {
  const res = await send(authFetch, "DELETE", "/api/organiser/account", {
    code: input.code,
    choices: Object.fromEntries(input.answered.map((id) => [id, "delete"])),
    deleteEverything: input.deleteEverything,
  });
  if (res.status === 200) return { status: "done" };
  if (res.status === 202) return { status: "not_finished" };
  if (res.status === 409) {
    const body = (await res.json()) as {
      error?: unknown;
      openActions?: RemovalAction[];
      weddings?: RemovalWedding[];
      more?: number;
    };
    if (body.error === "open_actions" && body.openActions && body.weddings) {
      return {
        status: "open_actions",
        openActions: body.openActions,
        weddings: body.weddings,
        more: body.more ?? 0,
      };
    }
    throw new RemovalError("server");
  }
  throw new RemovalError(failureOf(res.status, await errorOf(res)));
}

// ---------------------------------------------------------------------------
// What the screen keeps while the person is on Musubi
// ---------------------------------------------------------------------------

const ANSWERS_KEY = "cire.removal.answers";
const CODE_KEY = "cire.removal.code";

/** The person's answers before they went to Musubi: the action ids answered, and the switch. */
export interface KeptAnswers {
  readonly answered: readonly string[];
  readonly deleteEverything: boolean;
}

function storage(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

export function keepAnswers(answers: KeptAnswers): void {
  storage()?.setItem(ANSWERS_KEY, JSON.stringify(answers));
}

export function keptAnswers(): KeptAnswers | null {
  const raw = storage()?.getItem(ANSWERS_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<KeptAnswers>;
    if (!Array.isArray(parsed.answered) || typeof parsed.deleteEverything !== "boolean") {
      return null;
    }
    return {
      answered: parsed.answered.filter((id): id is string => typeof id === "string"),
      deleteEverything: parsed.deleteEverything,
    };
  } catch {
    return null;
  }
}

/** Keeps the code Musubi sent the person back with, before the address loses it. */
export function keepCode(code: string): void {
  storage()?.setItem(CODE_KEY, code);
}

export function keptCode(): string | null {
  return storage()?.getItem(CODE_KEY) ?? null;
}

/** Forgets the answers and the code: the removal finished, or the person started again. */
export function forgetRemoval(): void {
  storage()?.removeItem(ANSWERS_KEY);
  storage()?.removeItem(CODE_KEY);
}
