/**
 * The organiser's unseen RSVP changes: what guests changed since this organiser
 * last opened the RSVP table, their read marker, and their daily digest switch.
 *
 * The API decides everything role-shaped. `digest.available` is its answer to
 * "does this organiser get the daily email", so the portal shows the switch
 * without reading a role itself. Every call here fails soft: a feed that cannot
 * be read hides the card and the badges, and nothing else on the page waits
 * for it.
 */

import { apiUrl } from "./api";

/** The kinds this build words. The API may send one it does not know yet. */
export type RsvpChangeKind =
  | "reply_new"
  | "reply_edited"
  | "plus_one_added"
  | "plus_one_renamed"
  | "plus_one_removed";

export interface RsvpChangeItem {
  familyId: string;
  familyName: string;
  kinds: string[];
  /** ISO time of the household's newest unseen change. */
  at: string;
}

export interface RsvpChanges {
  /** The newest unseen change — sent back to mark everything seen. 0 when none. */
  markSeq: number;
  households: number;
  /** The API read as many rows as it will; `households` may be more. */
  truncated: boolean;
  items: RsvpChangeItem[];
  /** Changed RSVP-table rows; `eventId: null` means every row of that guest. */
  rows: { guestId: string; eventId: string | null }[];
  digest: { available: boolean; enabled: boolean };
}

type AuthFetch = (input: string, init?: RequestInit) => Promise<Response>;

const KIND_LABEL = {
  reply_new: "replied",
  reply_edited: "changed their reply",
  plus_one_added: "added a plus-one",
  plus_one_renamed: "changed their plus-one's name",
  plus_one_removed: "removed their plus-one",
} as const satisfies Readonly<Record<RsvpChangeKind, string>>;

const isKnownKind = (kind: string): kind is RsvpChangeKind => Object.hasOwn(KIND_LABEL, kind);

/** "replied, added a plus-one" — kinds this build does not know are left out. */
export function describeChangeKinds(kinds: readonly string[]): string {
  return kinds
    .filter(isKnownKind)
    .map((kind) => KIND_LABEL[kind])
    .join(", ");
}

/** Is this RSVP-table row one the guest changed since the organiser last looked? */
export function newRowCheck(
  rows: readonly { guestId: string; eventId: string | null }[],
): (guestId: string, eventId: string) => boolean {
  const pairs = new Set<string>();
  const wholeGuests = new Set<string>();
  for (const row of rows) {
    if (row.eventId === null) wholeGuests.add(row.guestId);
    else pairs.add(`${row.guestId}::${row.eventId}`);
  }
  return (guestId, eventId) => wholeGuests.has(guestId) || pairs.has(`${guestId}::${eventId}`);
}

/** "just now", "15 min ago", "3 h ago", "2 days ago"; "" for a time it cannot read. */
export function formatChangeTime(iso: string, nowMs: number = Date.now()): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return "";
  const minutes = Math.floor((nowMs - at) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  return `${days} ${days === 1 ? "day" : "days"} ago`;
}

function isItem(item: unknown): item is RsvpChangeItem {
  if (typeof item !== "object" || item === null) return false;
  if (!("familyId" in item) || typeof item.familyId !== "string") return false;
  if (!("familyName" in item) || typeof item.familyName !== "string") return false;
  if (!("at" in item) || typeof item.at !== "string") return false;
  if (!("kinds" in item) || !Array.isArray(item.kinds)) return false;
  return item.kinds.every((kind: unknown) => typeof kind === "string");
}

function isRow(row: unknown): row is RsvpChanges["rows"][number] {
  if (typeof row !== "object" || row === null) return false;
  if (!("guestId" in row) || typeof row.guestId !== "string") return false;
  return "eventId" in row && (row.eventId === null || typeof row.eventId === "string");
}

/** The body really is a feed, not an error or some other route's answer. */
function isRsvpChanges(body: unknown): body is RsvpChanges {
  if (typeof body !== "object" || body === null) return false;
  if (!("markSeq" in body) || typeof body.markSeq !== "number") return false;
  if (!("households" in body) || typeof body.households !== "number") return false;
  if (!("truncated" in body) || typeof body.truncated !== "boolean") return false;
  if (!("items" in body) || !Array.isArray(body.items) || !body.items.every(isItem)) return false;
  if (!("rows" in body) || !Array.isArray(body.rows) || !body.rows.every(isRow)) return false;
  if (!("digest" in body) || typeof body.digest !== "object" || body.digest === null) return false;
  const digest = body.digest;
  if (!("available" in digest) || typeof digest.available !== "boolean") return false;
  return "enabled" in digest && typeof digest.enabled === "boolean";
}

const base = (weddingId: string) =>
  apiUrl(`/api/organiser/weddings/${encodeURIComponent(weddingId)}/rsvp-changes`);

/** The caller's unseen changes, or null when they cannot be read. */
export async function fetchRsvpChanges(
  authFetch: AuthFetch,
  weddingId: string,
): Promise<RsvpChanges | null> {
  try {
    const res = await authFetch(base(weddingId));
    if (!res.ok) return null;
    const body: unknown = await res.json();
    return isRsvpChanges(body) ? body : null;
  } catch {
    return null;
  }
}

/** Mark every change up to `seq` seen. Best effort: a failure only means the badges come back. */
export async function markRsvpChangesSeen(
  authFetch: AuthFetch,
  weddingId: string,
  seq: number,
): Promise<void> {
  try {
    await authFetch(`${base(weddingId)}/seen`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ seq }),
    });
  } catch {
    // Nothing to do: the next visit shows the same changes again.
  }
}

/** Turn the caller's daily digest on or off. True when the API saved it. */
export async function setRsvpDigest(
  authFetch: AuthFetch,
  weddingId: string,
  enabled: boolean,
): Promise<boolean> {
  try {
    const res = await authFetch(`${base(weddingId)}/digest`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled }),
    });
    return res.ok;
  } catch {
    return false;
  }
}
