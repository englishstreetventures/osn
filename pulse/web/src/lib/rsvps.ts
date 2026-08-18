/**
 * Lightweight REST wrappers for the RSVP / comms / settings endpoints.
 *
 * We don't use the Eden treaty client for these because the Eden types
 * don't stay stable when routes are added to the chain in the order we
 * happen to have them (Elysia's type inference chains left-to-right, so
 * extending the chain in a separate PR keeps breaking). Raw `fetch` against
 * `VITE_API_URL` keeps the surface area small.
 *
 * None of these take a credential. The browser holds exactly one — the
 * HttpOnly Pulse session cookie — and it rides along on every call here
 * because both `authFetch` and `publicFetch` set `credentials: "include"`.
 */

import { authFetch, expiredMessage, PULSE_API_URL, publicFetch } from "./auth";
import type { ShareSource } from "./shareSource";

const BASE_URL = PULSE_API_URL;

const JSON_HEADERS = { "Content-Type": "application/json" };

export type RsvpStatus = "going" | "maybe" | "not_going" | "invited";

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
  maybe: number;
  not_going: number;
  invited: number;
}

export async function fetchLatestRsvps(eventId: string, limit = 5): Promise<Rsvp[]> {
  const res = await publicFetch(`${BASE_URL}/events/${eventId}/rsvps/latest?limit=${limit}`);
  if (!res.ok) return [];
  const body = (await res.json()) as { rsvps?: Rsvp[] };
  return body.rsvps ?? [];
}

export async function fetchRsvpsByStatus(eventId: string, status: RsvpStatus): Promise<Rsvp[]> {
  const res = await publicFetch(`${BASE_URL}/events/${eventId}/rsvps?status=${status}&limit=200`);
  if (!res.ok) return [];
  const body = (await res.json()) as { rsvps?: Rsvp[] };
  return body.rsvps ?? [];
}

export async function fetchRsvpCounts(eventId: string): Promise<RsvpCounts> {
  const res = await publicFetch(`${BASE_URL}/events/${eventId}/rsvps/counts`);
  if (!res.ok) return { going: 0, maybe: 0, not_going: 0, invited: 0 };
  const body = (await res.json()) as { counts?: RsvpCounts };
  return body.counts ?? { going: 0, maybe: 0, not_going: 0, invited: 0 };
}

/** Request body for `POST /events/:id/rsvps`. `shareSource` is omitted when unknown. */
interface RsvpUpsertBody {
  status: "going" | "maybe" | "not_going";
  shareSource?: ShareSource;
}

export async function upsertMyRsvp(
  eventId: string,
  status: "going" | "maybe" | "not_going",
  shareSource?: ShareSource | null,
): Promise<{ ok: boolean; error?: string }> {
  const body: RsvpUpsertBody = { status };
  if (shareSource) body.shareSource = shareSource;
  try {
    const res = await authFetch(`${BASE_URL}/events/${eventId}/rsvps`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const respBody = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
      return { ok: false, error: respBody.message ?? respBody.error ?? `HTTP ${res.status}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: expiredMessage(err) };
  }
}

/**
 * Fire-and-forget telemetry pings for outbound shares and inbound
 * exposures. Both are rate-limited server-side and neither blocks the
 * surrounding UX — failures are swallowed because the user-facing action
 * (share, navigation) has already succeeded by the time these run.
 *
 * Both send the session cookie so the server's visibility gate sees the
 * caller's identity — without it an organiser sharing their own *private*
 * event would 404 (the gate can't tell they're the organiser) and the
 * counter would silently never increment.
 *
 * `keepalive: true` lets the browser complete the request even when the
 * share fires a navigation intent (WhatsApp / X / Facebook open a new
 * context and may unload this tab) — otherwise those platforms, the ones
 * this metric most exists to measure, would systematically under-count.
 */
export async function recordShareInvoked(eventId: string, source: ShareSource): Promise<void> {
  try {
    await publicFetch(`${BASE_URL}/events/${eventId}/share`, {
      method: "POST",
      keepalive: true,
      headers: JSON_HEADERS,
      body: JSON.stringify({ source }),
    });
  } catch {
    // Telemetry best-effort.
  }
}

export async function recordShareExposure(eventId: string, source: ShareSource): Promise<void> {
  try {
    await publicFetch(`${BASE_URL}/events/${eventId}/exposure`, {
      method: "POST",
      keepalive: true,
      headers: JSON_HEADERS,
      body: JSON.stringify({ source }),
    });
  } catch {
    // Telemetry best-effort.
  }
}

export async function updateMySettings(data: {
  attendanceVisibility: "connections" | "no_one";
}): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await authFetch(`${BASE_URL}/me/settings`, {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify(data),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
      return { ok: false, error: body.message ?? body.error ?? `HTTP ${res.status}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: expiredMessage(err) };
  }
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
  const res = await publicFetch(`${BASE_URL}/events/${eventId}/comms`);
  if (!res.ok) return null;
  return (await res.json()) as CommsSummary;
}

export const apiBaseUrl = BASE_URL;
