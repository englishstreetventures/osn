// The seating chart's requests and the few rules the view reads from them.
//
// `authFetch` is a PARAMETER, never an import, as in `upgrade-api.ts`: it lives
// in the AuthProvider context so the session cookie rides along. Every path is
// built with `weddingPath` + `apiUrl`, and the ids past the wedding are encoded
// here (`wiki/cire/cire-development.md` §Organiser API paths).
import { apiUrl, redirectToLogin, weddingPath } from "./api";

export type AuthFetch = (input: string, init?: RequestInit) => Promise<Response>;

export type RsvpStatus = "attending" | "declined" | "maybe";

export interface SeatingTable {
  id: string;
  name: string;
  capacity: number;
  sortOrder: number;
}

export interface SeatingGuest {
  id: string;
  firstName: string;
  lastName: string;
  /** The guest's reply to this event, or `null` before they reply. */
  rsvp: RsvpStatus | null;
  /** Their household's invitation was withdrawn. The API sends such a guest
   *  only while they still hold a seat, and refuses to seat or move them. */
  withdrawn: boolean;
  tableId: string | null;
}

export interface SeatingChart {
  event: { id: string; name: string };
  tables: SeatingTable[];
  guests: SeatingGuest[];
}

/** A refused or failed request: the status, and the reason the API named. */
export class SeatingRequestError extends Error {
  constructor(
    public status: number,
    public code: string | null,
  ) {
    super(code ?? `http_${status}`);
    this.name = "SeatingRequestError";
  }
}

const enc = encodeURIComponent;
const seatingPath = (weddingId: string, rest: string) =>
  apiUrl(weddingPath(weddingId, `/seating${rest}`));

async function send<T>(authFetch: AuthFetch, url: string, init: RequestInit = {}): Promise<T> {
  const res = await authFetch(url, {
    ...init,
    headers: init.body ? { "Content-Type": "application/json" } : undefined,
  });
  if (res.status === 401) redirectToLogin();
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
    throw new SeatingRequestError(res.status, typeof body?.error === "string" ? body.error : null);
  }
  return (await res.json()) as T;
}

export const seatingApi = {
  chart: (authFetch: AuthFetch, weddingId: string, eventId: string) =>
    send<SeatingChart>(authFetch, seatingPath(weddingId, `/events/${enc(eventId)}`)),

  seat: (
    authFetch: AuthFetch,
    weddingId: string,
    eventId: string,
    guestId: string,
    tableId: string | null,
  ) =>
    send<{ guestId: string; tableId: string | null }>(
      authFetch,
      seatingPath(weddingId, `/events/${enc(eventId)}/guests/${enc(guestId)}`),
      { method: "PUT", body: JSON.stringify({ tableId }) },
    ),

  createTable: (
    authFetch: AuthFetch,
    weddingId: string,
    eventId: string,
    body: { name: string; capacity: number },
  ) =>
    send<{ table: SeatingTable }>(
      authFetch,
      seatingPath(weddingId, `/events/${enc(eventId)}/tables`),
      { method: "POST", body: JSON.stringify(body) },
    ),

  updateTable: (
    authFetch: AuthFetch,
    weddingId: string,
    tableId: string,
    patch: { name?: string; capacity?: number },
  ) =>
    send<{ table: SeatingTable }>(authFetch, seatingPath(weddingId, `/tables/${enc(tableId)}`), {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),

  deleteTable: (authFetch: AuthFetch, weddingId: string, tableId: string) =>
    send<{ ok: true }>(authFetch, seatingPath(weddingId, `/tables/${enc(tableId)}`), {
      method: "DELETE",
    }),

  reorderTables: (
    authFetch: AuthFetch,
    weddingId: string,
    eventId: string,
    orderedIds: readonly string[],
  ) =>
    send<{ ok: true }>(
      authFetch,
      seatingPath(weddingId, `/events/${enc(eventId)}/tables/reorder`),
      {
        method: "PATCH",
        body: JSON.stringify({ orderedIds }),
      },
    ),
};

export const guestName = (guest: SeatingGuest): string =>
  `${guest.firstName} ${guest.lastName}`.trim();

/**
 * The word a guest's row carries, or `null` for a guest who said yes. Every
 * guest who has not said yes is marked, so a host can see who to chase or
 * move before the chart goes to the venue.
 */
export type RsvpBadge = "Invite withdrawn" | "Declined" | "Maybe" | "No reply";

export function rsvpBadge(guest: SeatingGuest): RsvpBadge | null {
  if (guest.withdrawn) return "Invite withdrawn";
  if (guest.rsvp === "declined") return "Declined";
  if (guest.rsvp === "maybe") return "Maybe";
  if (guest.rsvp === null) return "No reply";
  return null;
}

/** What a seat change says, for the live region. */
export function seatAnnouncement(
  name: string,
  to: SeatingTable | null,
  from: string | null,
): string {
  if (to === null) return `${name} is no longer seated.`;
  return from === null ? `${name} seated at ${to.name}.` : `${name} moved to ${to.name}.`;
}

/** What a refused seat change says. */
export function refusalMessage(
  code: string | null,
  name: string,
  tableName: string | null,
): string {
  if (code === "table_full" && tableName) {
    return `${tableName} is full, so ${name} was not seated there.`;
  }
  if (code === "household_withdrawn") {
    return `${name}'s invitation was withdrawn, so they cannot be seated.`;
  }
  return `Could not change where ${name} sits. Refresh to see the chart as saved.`;
}
