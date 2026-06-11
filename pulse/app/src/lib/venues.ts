/**
 * REST wrappers for the venue endpoints. Raw fetch to match the rsvps
 * + series modules — Eden treaty types chain left-to-right and the
 * venue routes will likely grow as the surface expands (capacity
 * booking, follower lists, …) so we keep this decoupled until the
 * shape stabilises.
 */

const BASE_URL = import.meta.env.VITE_API_URL ?? "http://localhost:3001";

export interface VenueSummary {
  id: string;
  orgHandle: string;
  handle: string;
  name: string;
  kind: string;
  description: string | null;
  address: string | null;
  city: string | null;
  country: string | null;
  latitude: number | null;
  longitude: number | null;
  capacity: number | null;
  /** JSON-encoded weekday hours map. Parsed by `parseVenueHours`. */
  hours: string | null;
  heroImageUrl: string | null;
  websiteUrl: string | null;
  instagramHandle: string | null;
  timezone: string;
}

export interface VenueEvent {
  id: string;
  title: string;
  description: string | null;
  startTime: string;
  endTime: string | null;
  status: "upcoming" | "ongoing" | "maybe_finished" | "finished" | "cancelled";
  imageUrl: string | null;
  category: string | null;
  priceAmount: number | null;
  priceCurrency: string | null;
  venueId: string | null;
  createdByName: string | null;
}

export type LineupRole = "headliner" | "support" | "resident" | "opener" | "guest";

export interface LineupSlot {
  id: string;
  eventId: string;
  artistName: string;
  role: LineupRole;
  slotStart: string;
  slotEnd: string;
  orderIndex: number;
}

/** Parsed weekday hours map. Keys are ISO weekday numbers (Mon = 1, Sun = 7). */
export type VenueHours = Record<string, { open: string; close: string } | null>;

export function parseVenueHours(raw: string | null): VenueHours | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as VenueHours;
    if (typeof parsed !== "object" || parsed === null) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Pulls every venue. Feeds the Explore map's venue layer.
 *
 * TODO(venue-bbox-search): swap for a viewport-scoped fetch (pass
 * minLat/maxLat/minLng/maxLng) once the API supports it — tracked in
 * wiki/TODO.md → Performance Backlog P-W28.
 */
export async function fetchAllVenues(): Promise<VenueSummary[]> {
  const res = await fetch(`${BASE_URL}/venues`);
  if (!res.ok) return [];
  const body = (await res.json()) as { venues?: VenueSummary[] };
  return body.venues ?? [];
}

export async function fetchVenue(
  orgHandle: string,
  venueHandle: string,
): Promise<VenueSummary | null> {
  const res = await fetch(
    `${BASE_URL}/venues/${encodeURIComponent(orgHandle)}/${encodeURIComponent(venueHandle)}`,
  );
  if (!res.ok) return null;
  const body = (await res.json()) as { venue?: VenueSummary };
  return body.venue ?? null;
}

export async function fetchVenueEvents(
  orgHandle: string,
  venueHandle: string,
  scope: "upcoming" | "past" | "all" = "upcoming",
  limit?: number,
): Promise<VenueEvent[]> {
  const query = `scope=${scope}${limit === undefined ? "" : `&limit=${limit}`}`;
  const res = await fetch(
    `${BASE_URL}/venues/${encodeURIComponent(orgHandle)}/${encodeURIComponent(venueHandle)}/events?${query}`,
  );
  if (!res.ok) return [];
  const body = (await res.json()) as { events?: VenueEvent[] };
  return body.events ?? [];
}

/**
 * Allow a URL onto an `href`/`src` attribute only when it parses with an
 * http(s) scheme. Venue rows are seed-only today, but `website_url` /
 * `hero_image_url` are destined for org self-service — a `javascript:`
 * value must never reach the DOM (S-M2).
 */
export function safeHttpUrl(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" || url.protocol === "http:" ? raw : null;
  } catch {
    return null;
  }
}

export function venueMapsUrl(v: VenueSummary): string | null {
  if (v.latitude !== null && v.longitude !== null) {
    return `https://www.google.com/maps/search/?api=1&query=${v.latitude},${v.longitude}`;
  }
  const addr = [v.address, v.city, v.country].filter(Boolean).join(", ");
  if (!addr) return null;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(addr)}`;
}

const WEEKDAY_FROM_SHORT: Record<string, string> = {
  Mon: "1",
  Tue: "2",
  Wed: "3",
  Thu: "4",
  Fri: "5",
  Sat: "6",
  Sun: "7",
};

const WEEKDAY_SHORT_FROM_ISO: Record<string, string> = {
  "1": "Mon",
  "2": "Tue",
  "3": "Wed",
  "4": "Thu",
  "5": "Fri",
  "6": "Sat",
  "7": "Sun",
};

function toMin(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

function prevIsoDay(iso: string): string {
  return String(((Number(iso) - 2 + 7) % 7) + 1);
}

function venueLocalNow(now: Date, tz: string): { weekday: string; minutes: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const wd = parts.find((p) => p.type === "weekday")?.value ?? "Mon";
  const hh = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const mm = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  return { weekday: WEEKDAY_FROM_SHORT[wd] ?? "1", minutes: hh * 60 + mm };
}

export interface OpenStatus {
  isOpen: boolean;
  label: string;
}

export function computeOpenStatus(
  hours: VenueHours,
  timezone: string,
  now: Date = new Date(),
): OpenStatus {
  const { weekday, minutes } = venueLocalNow(now, timezone);

  const prev = hours[prevIsoDay(weekday)];
  if (prev) {
    const open = toMin(prev.open);
    const close = toMin(prev.close);
    if (close <= open && minutes < close) {
      return { isOpen: true, label: `Open · closes ${prev.close}` };
    }
  }

  const today = hours[weekday];
  if (today) {
    const open = toMin(today.open);
    const close = toMin(today.close);
    const sameDay = close > open;
    if (sameDay && minutes >= open && minutes < close) {
      return { isOpen: true, label: `Open · closes ${today.close}` };
    }
    if (!sameDay && minutes >= open) {
      return { isOpen: true, label: `Open · closes ${today.close}` };
    }
  }

  for (let i = 0; i < 7; i++) {
    const checkDay = String(((Number(weekday) - 1 + i) % 7) + 1);
    const slot = hours[checkDay];
    if (!slot) continue;
    const open = toMin(slot.open);
    if (i === 0 && open <= minutes) continue;
    const minutesUntil = i * 24 * 60 + open - minutes;
    if (i === 0) {
      const h = Math.floor(minutesUntil / 60);
      const m = minutesUntil % 60;
      if (minutesUntil < 60) return { isOpen: false, label: `Opens in ${minutesUntil}m` };
      if (minutesUntil < 6 * 60) return { isOpen: false, label: `Opens in ${h}h ${m}m` };
      return { isOpen: false, label: `Opens at ${slot.open}` };
    }
    if (i === 1) return { isOpen: false, label: `Opens tomorrow ${slot.open}` };
    return { isOpen: false, label: `Opens ${WEEKDAY_SHORT_FROM_ISO[checkDay]} ${slot.open}` };
  }
  return { isOpen: false, label: "Closed" };
}

export async function fetchEventLineup(
  orgHandle: string,
  venueHandle: string,
  eventId: string,
): Promise<LineupSlot[]> {
  const res = await fetch(
    `${BASE_URL}/venues/${encodeURIComponent(orgHandle)}/${encodeURIComponent(venueHandle)}/events/${encodeURIComponent(eventId)}/lineup`,
  );
  if (!res.ok) return [];
  const body = (await res.json()) as { slots?: LineupSlot[] };
  return body.slots ?? [];
}
