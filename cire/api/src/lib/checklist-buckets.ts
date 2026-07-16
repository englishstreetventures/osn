/**
 * The lead-time buckets a checklist task files under, in display order
 * (furthest-out first). Single source of truth for the server: the HTTP schema's
 * bucket enum + any bucket-ordered read derive from THIS list. The organiser
 * client keeps its own label mirror (it can't import cire/api) — keep the two in
 * sync when a bucket is added or a label reworded ([[platform-plan]] §4.1).
 */
export const TIMEFRAME_BUCKETS = [
  { key: "12m", label: "12+ months out" },
  { key: "9m", label: "9 months out" },
  { key: "6m", label: "6 months out" },
  { key: "3m", label: "3 months out" },
  { key: "1m", label: "1 month out" },
  { key: "2w", label: "2 weeks out" },
  { key: "week_of", label: "Week of" },
  { key: "day_of", label: "Day of" },
] as const;

export type TimeframeBucket = (typeof TIMEFRAME_BUCKETS)[number]["key"];

export const TIMEFRAME_BUCKET_KEYS: readonly TimeframeBucket[] = TIMEFRAME_BUCKETS.map(
  (b) => b.key,
);

export function isTimeframeBucket(value: string): value is TimeframeBucket {
  return (TIMEFRAME_BUCKET_KEYS as readonly string[]).includes(value);
}
