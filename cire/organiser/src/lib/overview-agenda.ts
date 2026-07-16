/**
 * Pure builder for the Overview "What's next" timeline: merges upcoming schedule
 * events, unpaid budget payments, and open checklist tasks into one
 * chronological agenda. No Solid primitives, no fetch — `now` is injected — so
 * every rule here is exhaustively unit-testable and never disagrees with the
 * Countdown card by a day across timezones.
 */

export type AgendaKind = "event" | "payment" | "task";

export interface AgendaItem {
  /** Stable key `${kind}:${sourceId}` for keyed rendering + navigation. */
  key: string;
  kind: AgendaKind;
  /** Local calendar date this item sits on, `YYYY-MM-DD`. */
  date: string;
  /** Primary label (event name / payment label / task title). */
  label: string;
  /** Trailing detail — formatted amount for payments, else null. */
  detail: string | null;
  /** Source row id (for navigation). */
  sourceId: string;
  /** Date strictly before today. Only payments/tasks can be overdue; past
   *  events are excluded entirely. */
  overdue: boolean;
}

export interface AgendaInput {
  events: { id: string; name: string; startAt: string }[];
  payments: {
    id: string;
    label: string;
    amountMinor: number;
    dueAt: string | null;
    paidAt: number | null;
  }[];
  tasks: { id: string; title: string; dueAt: string | null; status: "open" | "done" }[];
  /** Injected clock, ms epoch. */
  now: number;
  /** Currency for formatting payment amounts. */
  currency: string;
  /** Upcoming items more than this many days ahead are dropped. */
  horizonDays: number;
  /** Max UPCOMING items to keep; overdue items are always kept. */
  limit: number;
}

const KIND_ORDER: Record<AgendaKind, number> = { event: 0, payment: 1, task: 2 };

/** Normalise an ISO datetime, a `YYYY-MM-DD` string, or an ms-epoch number to a
 *  local `YYYY-MM-DD` key (or null if unparseable). A bare date string is read
 *  as local midnight (not UTC) so it lands on the organiser's calendar day. */
export function toLocalDateKey(value: string | number): string | null {
  let d: Date;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    d = new Date(value);
  } else {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    d = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(value);
  }
  if (Number.isNaN(d.getTime())) return null;
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  const da = String(d.getDate()).padStart(2, "0");
  return `${y}-${mo}-${da}`;
}

function fmtAmount(minor: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
      maximumFractionDigits: 0,
    }).format(minor / 100);
  } catch {
    return (minor / 100).toFixed(0);
  }
}

export function buildAgenda(input: AgendaInput): AgendaItem[] {
  const todayKey = toLocalDateKey(input.now)!;
  const nowDate = new Date(input.now);
  const horizonDate = new Date(
    nowDate.getFullYear(),
    nowDate.getMonth(),
    nowDate.getDate() + input.horizonDays,
  );
  const horizonKey = toLocalDateKey(horizonDate.getTime())!;

  const items: AgendaItem[] = [];

  for (const e of input.events) {
    const date = toLocalDateKey(e.startAt);
    if (date == null || date < todayKey) continue; // past events happened — drop
    items.push({
      key: `event:${e.id}`,
      kind: "event",
      date,
      label: e.name,
      detail: null,
      sourceId: e.id,
      overdue: false,
    });
  }

  for (const p of input.payments) {
    if (p.paidAt != null || p.dueAt == null) continue;
    const date = toLocalDateKey(p.dueAt);
    if (date == null) continue;
    items.push({
      key: `payment:${p.id}`,
      kind: "payment",
      date,
      label: p.label,
      detail: fmtAmount(p.amountMinor, input.currency),
      sourceId: p.id,
      overdue: date < todayKey,
    });
  }

  for (const t of input.tasks) {
    if (t.status !== "open" || t.dueAt == null) continue;
    const date = toLocalDateKey(t.dueAt);
    if (date == null) continue;
    items.push({
      key: `task:${t.id}`,
      kind: "task",
      date,
      label: t.title,
      detail: null,
      sourceId: t.id,
      overdue: date < todayKey,
    });
  }

  const cmp = (a: AgendaItem, b: AgendaItem): number => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    if (KIND_ORDER[a.kind] !== KIND_ORDER[b.kind]) return KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
    return a.label < b.label ? -1 : a.label > b.label ? 1 : 0;
  };

  const overdue = items.filter((i) => i.overdue).toSorted(cmp);
  const upcoming = items
    .filter((i) => !i.overdue && i.date <= horizonKey)
    .toSorted(cmp)
    .slice(0, input.limit);

  return [...overdue, ...upcoming];
}
