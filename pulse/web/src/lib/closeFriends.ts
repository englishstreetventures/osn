/**
 * Lightweight REST wrappers for the Pulse close-friends surface.
 *
 * Mirrors the pattern in `./rsvps.ts` — raw fetch against `VITE_API_URL`
 * with bearer-token auth, no Eden treaty client (the type chain breaks
 * across PRs).
 */

const BASE_URL = import.meta.env.VITE_API_URL ?? "http://localhost:3001";

function authHeaders(token: string | null): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export interface CloseFriendEntry {
  profileId: string;
  handle: string | null;
  displayName: string | null;
  avatarUrl: string | null;
}

export async function listCloseFriends(token: string): Promise<CloseFriendEntry[]> {
  const res = await fetch(`${BASE_URL}/close-friends`, {
    headers: authHeaders(token),
  });
  if (!res.ok) return [];
  const body = (await res.json()) as { closeFriends?: CloseFriendEntry[] };
  return body.closeFriends ?? [];
}

export type AddCloseFriendError = "self" | "not_a_connection" | "unknown";

export async function addCloseFriend(
  friendId: string,
  token: string,
): Promise<{ ok: true } | { ok: false; error: AddCloseFriendError }> {
  const res = await fetch(`${BASE_URL}/close-friends/${encodeURIComponent(friendId)}`, {
    method: "POST",
    headers: authHeaders(token),
  });
  if (res.ok) return { ok: true };
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  if (body.error === "self") return { ok: false, error: "self" };
  if (body.error === "not_a_connection") return { ok: false, error: "not_a_connection" };
  return { ok: false, error: "unknown" };
}

export async function removeCloseFriend(friendId: string, token: string): Promise<{ ok: boolean }> {
  const res = await fetch(`${BASE_URL}/close-friends/${encodeURIComponent(friendId)}`, {
    method: "DELETE",
    headers: authHeaders(token),
  });
  return { ok: res.ok };
}
