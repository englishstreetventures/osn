/**
 * Lightweight REST wrappers for the RSVP / comms / settings endpoints.
 *
 * We don't use the Eden treaty client for these because the Eden types
 * don't stay stable when routes are added to the chain in the order we
 * happen to have them (Elysia's type inference chains left-to-right, so
 * extending the chain in a separate PR keeps breaking). Raw `fetch` against
 * `VITE_API_URL` keeps the surface area small.
 */

const BASE_URL = import.meta.env.VITE_API_URL ?? "http://localhost:3001";

function authHeaders(token: string | null): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export type RsvpStatus = "going" | "interested" | "not_going" | "invited";

export interface Rsvp {
  id: string;
  eventId: string;
  profileId: string;
  status: RsvpStatus;
  /** Server returns null to non-organiser viewers; only the organiser sees who invited whom. */
  invitedByProfileId: string | null;
  /**
   * True when this attendee has marked the current viewer as a close
   * friend. Server-computed against the OSN graph; the client renders
   * the close-friend affordance (green ring) when this is true.
   */
  isCloseFriend: boolean;
  createdAt: string;
  profile: {
    id: string;
    handle: string;
    displayName: string | null;
    avatarUrl: string | null;
  } | null;
}

export interface RsvpCounts {
  going: number;
  interested: number;
  not_going: number;
  invited: number;
}

export async function fetchLatestRsvps(
  eventId: string,
  token: string | null,
  limit = 5,
): Promise<Rsvp[]> {
  const res = await fetch(`${BASE_URL}/events/${eventId}/rsvps/latest?limit=${limit}`, {
    headers: authHeaders(token),
  });
  if (!res.ok) return [];
  const body = (await res.json()) as { rsvps?: Rsvp[] };
  return body.rsvps ?? [];
}

export async function fetchRsvpsByStatus(
  eventId: string,
  status: RsvpStatus,
  token: string | null,
): Promise<Rsvp[]> {
  const res = await fetch(`${BASE_URL}/events/${eventId}/rsvps?status=${status}&limit=200`, {
    headers: authHeaders(token),
  });
  if (!res.ok) return [];
  const body = (await res.json()) as { rsvps?: Rsvp[] };
  return body.rsvps ?? [];
}

export async function fetchRsvpCounts(eventId: string): Promise<RsvpCounts> {
  const res = await fetch(`${BASE_URL}/events/${eventId}/rsvps/counts`);
  if (!res.ok) return { going: 0, interested: 0, not_going: 0, invited: 0 };
  const body = (await res.json()) as { counts?: RsvpCounts };
  return body.counts ?? { going: 0, interested: 0, not_going: 0, invited: 0 };
}

export async function upsertMyRsvp(
  eventId: string,
  status: "going" | "interested" | "not_going",
  token: string,
): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(`${BASE_URL}/events/${eventId}/rsvps`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders(token) },
    body: JSON.stringify({ status }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
    return { ok: false, error: body.message ?? body.error ?? `HTTP ${res.status}` };
  }
  return { ok: true };
}

export async function updateMySettings(
  data: { attendanceVisibility: "connections" | "no_one" },
  token: string,
): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(`${BASE_URL}/me/settings`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...authHeaders(token) },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
    return { ok: false, error: body.message ?? body.error ?? `HTTP ${res.status}` };
  }
  return { ok: true };
}

export interface CommsSummary {
  channels: ("sms" | "email")[];
  blasts: {
    id: string;
    channel: "sms" | "email";
    body: string;
    sentByProfileId: string;
    sentAt: string | null;
    createdAt: string;
  }[];
}

export async function fetchCommsSummary(eventId: string): Promise<CommsSummary | null> {
  const res = await fetch(`${BASE_URL}/events/${eventId}/comms`);
  if (!res.ok) return null;
  return (await res.json()) as CommsSummary;
}

export const apiBaseUrl = BASE_URL;
