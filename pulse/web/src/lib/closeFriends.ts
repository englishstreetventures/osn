/**
 * Lightweight REST wrappers for the Pulse close-friends surface.
 *
 * Mirrors the pattern in `./rsvps.ts` — raw fetch against `VITE_API_URL`,
 * no Eden treaty client (the type chain breaks across PRs). Every route
 * here needs a signed-in caller, so all of them go through `authFetch`
 * and the session cookie it carries.
 */

import { authFetch, isExpired, PULSE_API_URL } from "./auth";

const BASE_URL = PULSE_API_URL;

export interface CloseFriendEntry {
  profileId: string;
  handle: string | null;
  displayName: string | null;
  avatarUrl: string | null;
}

export async function listCloseFriends(): Promise<CloseFriendEntry[]> {
  const res = await authFetch(`${BASE_URL}/close-friends`).catch(() => null);
  if (!res?.ok) return [];
  const body = (await res.json()) as { closeFriends?: CloseFriendEntry[] };
  return body.closeFriends ?? [];
}

export interface CandidateEntry {
  profileId: string;
  handle: string;
  displayName: string | null;
  avatarUrl: string | null;
}

/**
 * The people the caller may add: their OSN connections, already sorted by
 * name. The browser can't read the OSN graph itself — it holds a Pulse
 * session cookie, not an OSN token — so Pulse serves the list.
 *
 * `null` means the graph was unreachable, which is not the same as an empty
 * list and must not be shown as "you have no connections".
 */
export async function listCloseFriendCandidates(): Promise<CandidateEntry[] | null> {
  const res = await authFetch(`${BASE_URL}/close-friends/candidates`).catch(() => null);
  if (!res?.ok) return null;
  const body = (await res.json()) as { connections?: CandidateEntry[] };
  return body.connections ?? [];
}

export type AddCloseFriendError = "self" | "not_a_connection" | "expired" | "unknown";

export async function addCloseFriend(
  friendId: string,
): Promise<{ ok: true } | { ok: false; error: AddCloseFriendError }> {
  let res: Response;
  try {
    res = await authFetch(`${BASE_URL}/close-friends/${encodeURIComponent(friendId)}`, {
      method: "POST",
    });
  } catch (err) {
    return { ok: false, error: isExpired(err) ? "expired" : "unknown" };
  }
  if (res.ok) return { ok: true };
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  if (body.error === "self") return { ok: false, error: "self" };
  if (body.error === "not_a_connection") return { ok: false, error: "not_a_connection" };
  return { ok: false, error: "unknown" };
}

export async function removeCloseFriend(friendId: string): Promise<{ ok: boolean }> {
  const res = await authFetch(`${BASE_URL}/close-friends/${encodeURIComponent(friendId)}`, {
    method: "DELETE",
  }).catch(() => null);
  return { ok: res?.ok === true };
}
