/**
 * Frontend mirror of `pulse/api/src/lib/shareSource.ts`. Adding a new
 * source means widening BOTH lists. Drift is caught by the route tests
 * (a value the server doesn't accept will 422 the RSVP / share / exposure
 * endpoints), but keeping the constants visually adjacent is the
 * cheapest insurance.
 */

export const SHARE_SOURCES = [
  "instagram",
  "facebook",
  "tiktok",
  "x",
  "whatsapp",
  "copy_link",
  "other",
] as const;

export type ShareSource = (typeof SHARE_SOURCES)[number];

const SHARE_SOURCE_SET: ReadonlySet<string> = new Set(SHARE_SOURCES);

export const isShareSource = (value: unknown): value is ShareSource =>
  typeof value === "string" && SHARE_SOURCE_SET.has(value);

/**
 * Coerce an arbitrary inbound `?source=…` value into a known
 * `ShareSource`. Unknown values collapse to `"other"` rather than being
 * dropped — that way attribution still records the touch, just bucketed
 * under the catch-all. `null` / `undefined` returns `null` so callers can
 * tell "no source" apart from "unknown source".
 */
export const coerceShareSource = (raw: unknown): ShareSource | null => {
  if (raw === null || raw === undefined) return null;
  if (Array.isArray(raw)) return coerceShareSource(raw[0]);
  if (typeof raw !== "string" || raw.length === 0) return null;
  return isShareSource(raw) ? raw : "other";
};

/**
 * Inject `source=<value>` into the query string of `url`. Replaces any
 * existing `source` param so chained shares don't accumulate stale
 * attribution. Returns the input unchanged if the URL fails to parse —
 * we never want a share button to throw.
 */
export const withShareSource = (url: string, source: ShareSource): string => {
  try {
    const parsed = new URL(url);
    parsed.searchParams.set("source", source);
    return parsed.toString();
  } catch {
    return url;
  }
};
