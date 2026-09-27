import { apiUrl } from "./api";
import {
  hasCachedGuests,
  invalidateGuests,
  peekCachedGuests,
  setCachedGuests,
} from "./guests-store";

type AuthFetch = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * Tell the API a household's invite message was just copied, so Guests →
 * Households shows it as sent. Both copy actions — the per-household one in
 * `GuestTable` and the one beside the message in the invite builder — come
 * through here. The route is owner-only; callers skip it for a co-host rather
 * than send a request that can only be refused.
 *
 * Best-effort: resolves `true` when the server recorded it and `false`
 * otherwise, and never throws — the copy has already happened.
 *
 * The cached guest rows follow the server's answer, and only a fresh list is
 * written. It is read after the POST answers, so a plus-one write made
 * meanwhile is kept, and every row of the household gets the server's time —
 * plus-ones too, since `GuestTable` takes a household's state from whichever of
 * its rows comes first. A fresh list whose answer carries no time is marked
 * stale instead. A list that is not loaded, or already stale, is left alone:
 * its next load asks the server anyway, and marking it again would throw away a
 * load a mounted view is waiting on.
 */
export async function markHouseholdShared(
  authFetch: AuthFetch,
  weddingId: string,
  familyId: string,
): Promise<boolean> {
  let res: Response;
  try {
    res = await authFetch(
      apiUrl(`/api/organiser/weddings/${weddingId}/families/${familyId}/mark-shared`),
      { method: "POST" },
    );
  } catch {
    return false;
  }
  if (!res.ok) return false;

  const body = (await res.json().catch(() => null)) as { codeSharedAt?: unknown } | null;
  const rows = peekCachedGuests(weddingId);
  if (!rows || !hasCachedGuests(weddingId)) return true;
  const sharedAt = body?.codeSharedAt;
  if (typeof sharedAt === "number") {
    setCachedGuests(
      weddingId,
      rows.map((row) => (row.familyId === familyId ? { ...row, codeSharedAt: sharedAt } : row)),
    );
  } else {
    invalidateGuests(weddingId);
  }
  return true;
}
