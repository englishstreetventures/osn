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

/** One version of an event's chart. */
export interface SeatingPlan {
  id: string;
  name: string;
  /** The event's plan in use: the one the venue file prints. */
  selected: boolean;
}

export interface SeatingChart {
  event: { id: string; name: string };
  /** The event's plans, the one in use first. */
  plans: SeatingPlan[];
  /** The plan the tables and seats are from, or `null` before the event has
   *  one. */
  planId: string | null;
  tables: SeatingTable[];
  guests: SeatingGuest[];
}

/** `GET …/seating/events/:eventId` as the API answers it. An API from before
 *  plans sends neither `plans` nor `planId`, and the portal can serve against
 *  it while a release deploys or after one rolls back. */
export type SeatingChartWire = Omit<SeatingChart, "plans" | "planId"> & {
  plans?: SeatingPlan[];
  planId?: string | null;
};

/** A chart as the portal keeps it, from either shape: one from an API before
 *  plans reads as an event with no plan, its tables and seats as sent. Read
 *  until englishstreetventures/osn#1658 lands; no API that sends the old shape
 *  can serve after it. */
export function readChart(chart: SeatingChartWire): SeatingChart {
  return { ...chart, plans: chart.plans ?? [], planId: chart.planId ?? null };
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

/**
 * Where a table, order or seat write goes: the plan on screen, or, for a chart
 * that names no plan, the event's own addresses, which act on its plan in use.
 * A chart names no plan for an event with none yet, and from an API before
 * plans; both serve the event's addresses.
 */
export interface PlanScope {
  eventId: string;
  planId: string | null;
}

const scopePath = ({ eventId, planId }: PlanScope) =>
  planId ? `/plans/${enc(planId)}` : `/events/${enc(eventId)}`;
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
  /** One plan of the event: `planId`, or the plan in use when none is named. */
  chart: async (
    authFetch: AuthFetch,
    weddingId: string,
    eventId: string,
    planId?: string | null,
  ): Promise<SeatingChart> =>
    readChart(
      await send<SeatingChartWire>(
        authFetch,
        seatingPath(weddingId, `/events/${enc(eventId)}${planId ? `?plan=${enc(planId)}` : ""}`),
      ),
    ),

  /** A new plan at the event: blank, or a copy of `copyFrom`. */
  createPlan: (
    authFetch: AuthFetch,
    weddingId: string,
    eventId: string,
    body: { name: string; copyFrom?: string },
  ) =>
    send<{ plan: SeatingPlan }>(
      authFetch,
      seatingPath(weddingId, `/events/${enc(eventId)}/plans`),
      {
        method: "POST",
        body: JSON.stringify(body),
      },
    ),

  renamePlan: (authFetch: AuthFetch, weddingId: string, planId: string, name: string) =>
    send<{ plan: SeatingPlan }>(authFetch, seatingPath(weddingId, `/plans/${enc(planId)}`), {
      method: "PATCH",
      body: JSON.stringify({ name }),
    }),

  deletePlan: (authFetch: AuthFetch, weddingId: string, planId: string) =>
    send<{ ok: true }>(authFetch, seatingPath(weddingId, `/plans/${enc(planId)}`), {
      method: "DELETE",
    }),

  /** Make `planId` the event's plan in use. */
  selectPlan: (authFetch: AuthFetch, weddingId: string, eventId: string, planId: string) =>
    send<{ ok: true }>(authFetch, seatingPath(weddingId, `/events/${enc(eventId)}/selected-plan`), {
      method: "PUT",
      body: JSON.stringify({ planId }),
    }),

  seat: (
    authFetch: AuthFetch,
    weddingId: string,
    where: PlanScope,
    guestId: string,
    tableId: string | null,
  ) =>
    send<{ guestId: string; tableId: string | null }>(
      authFetch,
      seatingPath(weddingId, `${scopePath(where)}/guests/${enc(guestId)}`),
      { method: "PUT", body: JSON.stringify({ tableId }) },
    ),

  /** A table in the plan; at the event's own address, in its plan in use,
   *  which the API makes when the event has none. */
  createTable: (
    authFetch: AuthFetch,
    weddingId: string,
    where: PlanScope,
    body: { name: string; capacity: number },
  ) =>
    send<{ table: SeatingTable }>(authFetch, seatingPath(weddingId, `${scopePath(where)}/tables`), {
      method: "POST",
      body: JSON.stringify(body),
    }),

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
    where: PlanScope,
    orderedIds: readonly string[],
  ) =>
    send<{ ok: true }>(authFetch, seatingPath(weddingId, `${scopePath(where)}/tables/reorder`), {
      method: "PATCH",
      body: JSON.stringify({ orderedIds }),
    }),
};

/**
 * What a plan asks a host to look at, worked out from the guests the chart
 * already holds: guests seated who declined, guests seated whose invitation
 * was withdrawn, and guests who said yes with no seat in this plan. A guest's
 * reply or invitation changing never moves a seat; it shows here, in every
 * plan, until a host moves the guest. Guests who said maybe or have not
 * replied carry a badge and are not listed.
 */
export interface PlanReview {
  declinedSeated: SeatingGuest[];
  withdrawnSeated: SeatingGuest[];
  attendingUnseated: SeatingGuest[];
}

export function planReview(guests: readonly SeatingGuest[]): PlanReview {
  const review: PlanReview = { declinedSeated: [], withdrawnSeated: [], attendingUnseated: [] };
  for (const guest of guests) {
    if (guest.tableId !== null) {
      if (guest.withdrawn) review.withdrawnSeated.push(guest);
      else if (guest.rsvp === "declined") review.declinedSeated.push(guest);
    } else if (!guest.withdrawn && guest.rsvp === "attending") {
      review.attendingUnseated.push(guest);
    }
  }
  return review;
}

/** A name for a new plan that no plan of the event has: "Plan 2", "Plan 3"… */
export function nextPlanName(plans: readonly SeatingPlan[]): string {
  const taken = new Set(plans.map((plan) => plan.name.trim().toLowerCase()));
  let n = plans.length + 1;
  while (taken.has(`plan ${n}`)) n += 1;
  return `Plan ${n}`;
}

/** The name a copy of `name` starts with, inside the API's 80 characters. */
export function copyName(name: string): string {
  return `${name.slice(0, 75).trimEnd()} copy`;
}

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
