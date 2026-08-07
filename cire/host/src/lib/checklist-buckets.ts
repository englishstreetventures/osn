// Client mirror of the server's checklist bucket list
// (cire/api/src/lib/checklist-buckets.ts). The organiser can't import cire/api,
// so the labels + order live here too — keep the two in sync when a bucket is
// added or a label reworded ([[platform-plan]] §4.1).
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
