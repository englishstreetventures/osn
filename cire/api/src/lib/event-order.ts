/**
 * Chronological event ordering shared by the organiser exports and the RSVP
 * view. `start_at` is an ISO-8601 string WITH offset, so lexicographic order is
 * NOT reliable across timezones — compare by parsed epoch, falling back to
 * `sort_order` then id for ties / unparseable timestamps.
 */
export interface EventOrderKey {
  id: string;
  startAt: string;
  sortOrder: number;
}

export function compareEventsByStart(a: EventOrderKey, b: EventOrderKey): number {
  const ta = Date.parse(a.startAt);
  const tb = Date.parse(b.startAt);
  const aValid = !Number.isNaN(ta);
  const bValid = !Number.isNaN(tb);
  if (aValid && bValid && ta !== tb) return ta - tb;
  if (aValid !== bValid) return aValid ? -1 : 1;
  if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
