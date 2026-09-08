/**
 * The data-shaping behind every chart, kept free of Solid and Plot so it can be
 * tested under `bun test` without a DOM or a bundler.
 *
 * Two rules from `wiki/observability/session-metrics.md` govern everything here:
 *
 *   - Median, never mean, for a per-pull-request distribution. The corpus is
 *     severely right-skewed and a mean describes its three largest cards.
 *   - A `null` ratio is *unknown*, not zero and not 100%. `exploreShare` is null
 *     when the transcript showed no edit; a correction rate is null when a card
 *     recorded no human turn at all. Both are excluded and the excluded count
 *     is returned, so a chart can say how much of the corpus it is not showing.
 *
 * `toRow` and `median` come from `@tools/pr-metrics`'s own report rather than
 * being restated, so the dashboard and the CLI cannot disagree about a ratio.
 */
import type { Card } from "../../pr-metrics/index.ts";
import { type CardRow, median, toRow } from "../../pr-metrics/report.ts";

export type { CardRow };
export { median, toRow };

export const monthOf = (iso: string): string => iso.slice(0, 7);

// ---------------------------------------------------------------------------
// Coverage — how much of the corpus can be trusted
// ---------------------------------------------------------------------------

export interface Coverage {
  cards: number;
  merged: number;
  /** `complexity.method === "confirmed"` — the only ratings worth acting on. */
  confirmed: number;
  /** An agent's own guess that nobody signed off. Shown, never charted. */
  unconfirmed: number;
  atOpen: number;
  atMerge: number;
  firstMonth: string | null;
  lastMonth: string | null;
}

export function coverage(cards: Card[]): Coverage {
  const rows = cards.map(toRow);
  const months = rows.map((row) => monthOf(row.at)).toSorted();

  return {
    cards: cards.length,
    merged: rows.filter((row) => row.mergedAt !== null).length,
    confirmed: rows.filter((row) => row.ratingMethod === "confirmed").length,
    unconfirmed: rows.filter((row) => row.ratingMethod === "unconfirmed").length,
    atOpen: rows.filter((row) => row.phase === "at-open").length,
    atMerge: rows.filter((row) => row.phase === "at-merge").length,
    firstMonth: months[0] ?? null,
    lastMonth: months.at(-1) ?? null,
  };
}

// ---------------------------------------------------------------------------
// A value per pull request, bucketed by month
// ---------------------------------------------------------------------------

export interface MonthPoint {
  month: string;
  pr: number | null;
  branch: string;
  value: number;
}

export interface MonthMedian {
  month: string;
  prs: number;
  median: number;
}

export interface Monthly {
  points: MonthPoint[];
  medians: MonthMedian[];
  /** Cards `pick` returned null for — unknown, so left out rather than zeroed. */
  excluded: number;
}

/**
 * One point per card and one median per month. `pick` returns null to exclude
 * a card; the count of exclusions comes back so the chart can print it.
 */
export function monthly(rows: CardRow[], pick: (row: CardRow) => number | null): Monthly {
  const points: MonthPoint[] = [];
  let excluded = 0;

  for (const row of rows) {
    const value = pick(row);
    if (value === null) {
      excluded += 1;
      continue;
    }

    points.push({ month: monthOf(row.at), pr: row.pr, branch: row.branch, value });
  }

  const byMonth = new Map<string, number[]>();
  for (const point of points) {
    const bucket = byMonth.get(point.month);
    if (bucket) bucket.push(point.value);
    else byMonth.set(point.month, [point.value]);
  }

  const medians = [...byMonth.entries()]
    .toSorted((a, b) => a[0].localeCompare(b[0]))
    .map(([month, values]) => ({ month, prs: values.length, median: median(values) }));

  return { points: points.toSorted((a, b) => a.month.localeCompare(b.month)), medians, excluded };
}

/** Corrections as a share of human turns; unknown when nobody typed anything. */
export const correctionRate = (row: CardRow): number | null =>
  row.turns > 0 ? row.corrections / row.turns : null;

// ---------------------------------------------------------------------------
// Cost against declared complexity
// ---------------------------------------------------------------------------

export interface ComplexityPoint {
  pr: number | null;
  branch: string;
  declared: number;
  usd: number;
  sourceLoc: number;
}

export interface ComplexityView {
  points: ComplexityPoint[];
  /** No `complexity:` label on the issue at all. */
  unrated: number;
  /** Rated by an agent, unconfirmed — excluded so the chart cannot be circular. */
  unconfirmed: number;
}

export function complexity(rows: CardRow[]): ComplexityView {
  const points: ComplexityPoint[] = [];
  let unrated = 0;
  let unconfirmed = 0;

  for (const row of rows) {
    if (row.declared === null) {
      unrated += 1;
      continue;
    }
    if (row.ratingMethod !== "confirmed") {
      unconfirmed += 1;
      continue;
    }

    points.push({
      pr: row.pr,
      branch: row.branch,
      declared: row.declared,
      usd: row.usd,
      sourceLoc: row.sourceLoc,
    });
  }

  return { points, unrated, unconfirmed };
}

// ---------------------------------------------------------------------------
// Sessions per pull request against cost
// ---------------------------------------------------------------------------

export interface SessionPoint {
  pr: number | null;
  branch: string;
  sessions: number;
  usd: number;
}

export interface SessionMedian {
  sessions: number;
  prs: number;
  median: number;
}

export interface SessionView {
  points: SessionPoint[];
  medians: SessionMedian[];
}

/** `window.sessions` is not on a `CardRow`, so this one reads the cards. */
export function sessionsAgainstCost(cards: Card[]): SessionView {
  const points = cards.map((card) => ({
    pr: card.pr.number,
    branch: card.pr.branch,
    sessions: card.window.sessions,
    usd: card.spend.usd_equivalent,
  }));

  const bySessions = new Map<number, number[]>();
  for (const point of points) {
    const bucket = bySessions.get(point.sessions);
    if (bucket) bucket.push(point.usd);
    else bySessions.set(point.sessions, [point.usd]);
  }

  const medians = [...bySessions.entries()]
    .toSorted((a, b) => a[0] - b[0])
    .map(([sessions, values]) => ({ sessions, prs: values.length, median: median(values) }));

  return { points, medians };
}

// ---------------------------------------------------------------------------
// Model and effort mix
// ---------------------------------------------------------------------------

export interface MixShare {
  month: string;
  key: string;
  messages: number;
  /** Of that month's messages. Sums to 1 within a month. */
  share: number;
}

export interface Mix {
  shares: MixShare[];
  /** Every key seen, largest first — the fixed order a colour scale should use. */
  keys: string[];
  /** Cards that contributed no message to this split at all. */
  unrecorded: number;
}

interface Count {
  key: string;
  messages: number;
}

function mix(cards: Card[], countsOf: (card: Card) => Count[]): Mix {
  const byMonth = new Map<string, Map<string, number>>();
  const totals = new Map<string, number>();
  let unrecorded = 0;

  for (const card of cards) {
    const counts = countsOf(card).filter((count) => count.messages > 0);
    if (counts.length === 0) {
      unrecorded += 1;
      continue;
    }

    const month = monthOf(card.pr.merged_at ?? card.pr.generated_at);
    const bucket = byMonth.get(month) ?? new Map<string, number>();
    byMonth.set(month, bucket);

    for (const { key, messages } of counts) {
      bucket.set(key, (bucket.get(key) ?? 0) + messages);
      totals.set(key, (totals.get(key) ?? 0) + messages);
    }
  }

  const keys = [...totals.entries()].toSorted((a, b) => b[1] - a[1]).map(([key]) => key);

  const shares: MixShare[] = [];
  for (const [month, bucket] of [...byMonth.entries()].toSorted((a, b) =>
    a[0].localeCompare(b[0]),
  )) {
    const monthTotal = [...bucket.values()].reduce((sum, n) => sum + n, 0);
    for (const key of keys) {
      const messages = bucket.get(key) ?? 0;
      if (messages > 0) shares.push({ month, key, messages, share: messages / monthTotal });
    }
  }

  return { shares, keys, unrecorded };
}

/** Which model answered, as a share of assistant messages per month. */
export const modelMix = (cards: Card[]): Mix =>
  mix(cards, (card) =>
    Object.entries(card.spend.by_model).map(([key, bucket]) => ({
      key,
      messages: bucket.messages,
    })),
  );

/**
 * Reasoning effort per assistant message, per month. A message with no
 * `effort` field is not counted, so a card whose transcript never recorded one
 * lands in `unrecorded` rather than in a made-up level.
 */
export const effortMix = (cards: Card[]): Mix =>
  mix(cards, (card) =>
    Object.entries(card.spend.effort).map(([key, messages]) => ({ key, messages })),
  );
