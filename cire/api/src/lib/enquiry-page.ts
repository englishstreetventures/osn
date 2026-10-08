/**
 * One page of an enquiry inbox, as the two inbox routes take it from the query
 * string: `?limit=` and `?cursor=`.
 *
 * Both inboxes list newest first by `(last_message_at, id)`, and a cursor is
 * the last row's pair. `last_message_at` holds epoch seconds, so two enquiries
 * often share one; `id` decides between them, which is what lets a page start
 * exactly where the previous one stopped.
 */
import { epochSeconds } from "../db/live-wedding";

/** The most enquiries one page holds, and the page size when the request names none. */
export const ENQUIRY_PAGE_MAX = 50;

/** Longer than any cursor this API writes: ten digits, a dot, and an `enq_<uuid>` id. */
const MAX_CURSOR_LENGTH = 200;

/** The last row of the previous page. `lastMessageAt` is in epoch seconds, the column's unit. */
export interface EnquiryCursor {
  readonly lastMessageAt: number;
  readonly id: string;
}

export interface EnquiryPageRequest {
  /** 1 to {@link ENQUIRY_PAGE_MAX}. */
  readonly limit: number;
  /** Rows strictly after this one in the inbox order; `null` for page one. */
  readonly after: EnquiryCursor | null;
}

/** The cursor that continues after `row`. Opaque to the portals, which send it back unread. */
export function encodeEnquiryCursor(row: { id: string; lastMessageAt: Date }): string {
  return `${epochSeconds(row.lastMessageAt)}.${row.id}`;
}

/** A cursor this API wrote, or `null` for anything else. */
export function decodeEnquiryCursor(raw: string): EnquiryCursor | null {
  if (raw.length > MAX_CURSOR_LENGTH) return null;
  const dot = raw.indexOf(".");
  if (dot <= 0) return null;
  const seconds = raw.slice(0, dot);
  const id = raw.slice(dot + 1);
  if (!/^\d+$/.test(seconds) || id.length === 0) return null;
  const lastMessageAt = Number(seconds);
  if (!Number.isSafeInteger(lastMessageAt)) return null;
  return { lastMessageAt, id };
}

interface EnquiryPageQuery {
  limit?: unknown;
  cursor?: unknown;
}

/** Says only "an object"; the parse below does the checking. */
function isEnquiryPageQuery(value: unknown): value is EnquiryPageQuery {
  return typeof value === "object" && value !== null;
}

/**
 * The page a request asks for, or `null` when its cursor is not one this API
 * wrote — the route answers 400 `invalid_cursor`.
 *
 * A limit that is not plain digits reads as a full page, and any limit is held
 * to 1–{@link ENQUIRY_PAGE_MAX}. A bad cursor is refused rather than read as
 * page one: the portal would append page one again under the rows it shows.
 */
export function parseEnquiryPage(query: unknown): EnquiryPageRequest | null {
  const q: EnquiryPageQuery = isEnquiryPageQuery(query) ? query : {};
  const limit =
    typeof q.limit === "string" && /^\d+$/.test(q.limit)
      ? Math.min(ENQUIRY_PAGE_MAX, Math.max(1, Number(q.limit)))
      : ENQUIRY_PAGE_MAX;
  if (q.cursor === undefined) return { limit, after: null };
  if (typeof q.cursor !== "string") return null;
  const after = decodeEnquiryCursor(q.cursor);
  return after ? { limit, after } : null;
}
