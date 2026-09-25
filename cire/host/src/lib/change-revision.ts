// The wedding's change head — the revision an editor draft is built on.
//
// The editors seed their draft once, when they load, and the save posts the
// whole draft: a row it lacks reads as a removal. So the draft carries the head
// revision read BEFORE its rows were loaded, and the API refuses the save once
// the head has moved (a co-host saved, a change was reverted). Read it first
// and load the rows after, never the other way round: rows loaded before the
// head could miss a change the head already counts.
//
// Effect is deliberately NOT imported here — this is frontend code.
import { apiUrl, redirectToLogin } from "./api";

type AuthFetch = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * Fetch the wedding's current change head. Rejects on any failure: an editor
 * without a revision cannot save, so it must show a load error rather than
 * seed a draft.
 */
export async function loadHeadRevision(authFetch: AuthFetch, weddingId: string): Promise<string> {
  const res = await authFetch(apiUrl(`/api/organiser/weddings/${weddingId}/changes/head`));
  if (res.status === 401) {
    redirectToLogin();
    throw new Error("unauthenticated");
  }
  if (!res.ok) throw new Error("Failed to load the change head");
  const body = (await res.json().catch(() => null)) as { revision?: unknown } | null;
  const revision = body?.revision;
  if (typeof revision !== "string" || revision.length === 0) {
    throw new Error("change head unavailable");
  }
  return revision;
}
