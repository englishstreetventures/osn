/**
 * Personal calendar (agenda) data access + pure date helpers.
 *
 * Like `lib/rsvps.ts`, this uses raw `fetch` against `VITE_API_URL` rather
 * than the Eden treaty client — the calendar route was added after the
 * client chain was frozen, and a small typed wrapper keeps the surface
 * stable.
 */

const BASE_URL = import.meta.env.VITE_API_URL ?? "http://localhost:3001";

export type EventStatus = "upcoming" | "ongoing" | "maybe_finished" | "finished" | "cancelled";

export interface CalendarEvent {
  id: string;
  title: string;
  description: string | null;
  location: string | null;
  venue: string | null;
  category: string | null;
  startTime: string;
  endTime: string | null;
  status: EventStatus;
  imageUrl: string | null;
  createdByProfileId: string;
  createdByName: string | null;
  createdByAvatar: string | null;
}

export interface CalendarEntry {
  event: CalendarEvent;
  /** Viewer's own RSVP status — drives the "confirm your maybe" prompt. */
  myStatus: "going" | "maybe" | null;
  isHost: boolean;
}

export async function fetchMyCalendar(token: string, limit = 50): Promise<CalendarEntry[]> {
  const res = await fetch(`${BASE_URL}/events/calendar?limit=${limit}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return [];
  const body = (await res.json()) as { entries?: CalendarEntry[] };
  return body.entries ?? [];
}

// ---------------------------------------------------------------------------
// Pure helpers (no DOM / no network) — unit-tested directly.
// ---------------------------------------------------------------------------

export interface DayGroup {
  /** Local YYYY-MM-DD key, stable for keying the <For>. */
  key: string;
  /** Start-of-day Date for the group. */
  date: Date;
  /** Human label: "Today", "Tomorrow", a weekday, or a full date. */
  label: string;
  entries: CalendarEntry[];
}

const startOfLocalDay = (d: Date): Date => new Date(d.getFullYear(), d.getMonth(), d.getDate());

const dayKey = (d: Date): string => {
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
};

/** Whole-day delta between two dates (local), ignoring the time of day. */
const dayDiff = (a: Date, b: Date): number =>
  Math.round((startOfLocalDay(a).getTime() - startOfLocalDay(b).getTime()) / 86_400_000);

export function formatDayLabel(date: Date, now: Date = new Date()): string {
  const diff = dayDiff(date, now);
  if (diff === 0) return "Today";
  if (diff === 1) return "Tomorrow";
  if (diff > 1 && diff < 7) return date.toLocaleDateString("en-US", { weekday: "long" });
  return date.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

/** Rail marker parts: month abbreviation, day-of-month, weekday abbreviation. */
export function formatRailDate(date: Date): { month: string; day: number; weekday: string } {
  return {
    month: date.toLocaleDateString("en-US", { month: "short" }).toUpperCase(),
    day: date.getDate(),
    weekday: date.toLocaleDateString("en-US", { weekday: "short" }).toUpperCase(),
  };
}

const formatClock = (d: Date): string => {
  let h = d.getHours();
  const m = d.getMinutes();
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return m === 0 ? `${h} ${ampm}` : `${h}:${String(m).padStart(2, "0")} ${ampm}`;
};

export function formatTimeRange(startISO: string, endISO: string | null): string {
  const start = formatClock(new Date(startISO));
  if (!endISO) return start;
  return `${start} – ${formatClock(new Date(endISO))}`;
}

/**
 * Group calendar entries into per-day buckets. Input is assumed to already
 * be sorted ascending by start time (the API returns it that way); the
 * grouping preserves that order both across and within buckets.
 */
export function groupEntriesByDay(entries: CalendarEntry[], now: Date = new Date()): DayGroup[] {
  const groups: DayGroup[] = [];
  const index = new Map<string, DayGroup>();
  for (const entry of entries) {
    const start = new Date(entry.event.startTime);
    const key = dayKey(start);
    let group = index.get(key);
    if (!group) {
      const date = startOfLocalDay(start);
      group = { key, date, label: formatDayLabel(date, now), entries: [] };
      index.set(key, group);
      groups.push(group);
    }
    group.entries.push(entry);
  }
  return groups;
}
