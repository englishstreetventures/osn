// An owner deleting a wedding and restoring it: the two requests and their
// copy. The API decides everything — who may, and whether money or an import
// still in flight holds the delete back; this only turns its answers into words.
// Frontend code: no Effect.
import type { AuthFetch } from "@shared/rp-auth";

import type { DeletedWeddingSummary } from "../components/CreateWeddingForm";
import { apiUrl, weddingPath } from "./api";

/** What each refusal of a delete means for the owner, and what to do about it. */
const DELETE_REFUSALS = {
  confirmation_mismatch: "That is not this wedding's link name. Type it exactly as shown.",
  purchase_in_flight:
    "An upgrade payment is still going through. Try again once it has finished — within a day.",
  gift_in_flight:
    "A guest's gift is still being paid. Try again once it has settled — usually within a few days.",
  change_in_progress:
    "A guest-list or schedule change is still being applied. Try again in a few minutes.",
  forbidden: "Only an owner of this wedding can delete it.",
  wedding_not_found: "This wedding has already been deleted.",
} as const;

const RESTORE_REFUSALS = {
  restore_window_passed: "It is too late to restore this wedding: its 7 days have passed.",
  not_deleted: "This wedding is not deleted.",
  forbidden: "Only an owner of this wedding can restore it.",
  wedding_not_found: "This wedding has been deleted for good.",
} as const;

async function errorOf(res: Response): Promise<string | null> {
  try {
    const body: unknown = await res.json();
    return body && typeof body === "object" && "error" in body && typeof body.error === "string"
      ? body.error
      : null;
  } catch {
    return null;
  }
}

/** The copy a refusal table holds for `error`, if it names one. */
function refusalCopy<T extends object>(refusals: T, error: string | null): string | undefined {
  if (error === null || !Object.hasOwn(refusals, error)) return undefined;
  const copy: unknown = refusals[error as keyof T];
  return typeof copy === "string" ? copy : undefined;
}

function messageFor<T extends object>(
  refusals: T,
  error: string | null,
  status: number,
  fallback: string,
): string {
  const copy = refusalCopy(refusals, error);
  if (copy) return copy;
  if (status === 429) return "Too many attempts. Wait a minute and try again.";
  return fallback;
}

export type DeleteOutcome = { ok: true; restoreUntil: string } | { ok: false; message: string };

/** Soft-delete a wedding, confirmed by its slug typed exactly. */
export async function deleteWedding(
  authFetch: AuthFetch,
  weddingId: string,
  confirmSlug: string,
): Promise<DeleteOutcome> {
  const res = await authFetch(apiUrl(weddingPath(weddingId)), {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ confirmSlug }),
  });
  if (res.ok) {
    const body = (await res.json()) as { restoreUntil: string };
    return { ok: true, restoreUntil: body.restoreUntil };
  }
  return {
    ok: false,
    message: messageFor(
      DELETE_REFUSALS,
      await errorOf(res),
      res.status,
      "Could not delete the wedding. Try again.",
    ),
  };
}

export type RestoreOutcome =
  | { ok: true }
  | {
      ok: false;
      /** The wedding can no longer be restored, so it should leave the list. */
      gone: boolean;
      message: string;
    };

/** Restore a soft-deleted wedding, inside its window. */
export async function restoreWedding(
  authFetch: AuthFetch,
  weddingId: string,
): Promise<RestoreOutcome> {
  const res = await authFetch(apiUrl(weddingPath(weddingId, "/restore")), { method: "POST" });
  if (res.ok) return { ok: true };
  const error = await errorOf(res);
  return {
    ok: false,
    gone: error === "restore_window_passed" || error === "wedding_not_found",
    message: messageFor(
      RESTORE_REFUSALS,
      error,
      res.status,
      "Could not restore the wedding. Try again.",
    ),
  };
}

/** The `deleted` list from a `GET /api/organiser/weddings` body, or none. */
export function deletedWeddingsOf(body: unknown): DeletedWeddingSummary[] {
  if (!body || typeof body !== "object" || !("deleted" in body)) return [];
  return Array.isArray(body.deleted) ? (body.deleted as DeletedWeddingSummary[]) : [];
}

const DAY = new Intl.DateTimeFormat("en-AU", { day: "numeric", month: "long", year: "numeric" });

/** "8 October 2026" — the last day a deleted wedding can be restored. */
export function restoreUntilLabel(iso: string): string {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? "" : DAY.format(at);
}
