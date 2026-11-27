/**
 * The change-notice registry: every notice osn-api can mail to its account
 * holders, by id, as `change-notices.json` beside this file holds it.
 *
 * The words live in the repository, so the owner reads them in the pull
 * request that adds them, and the send route takes only an id: whoever holds
 * the operator's secret can send a reviewed notice, never text of their own.
 *
 * This module imports nothing. `scripts/production-operator.ts` loads it
 * beside a production secret under `bun --no-install`, to parse the file at
 * the commit production osn-api runs and show the approver the words it will
 * send.
 */

/** One notice: the page that changes, what changes, and the day it takes effect. */
export interface ChangeNotice {
  /** What the page is called, lower case: "privacy notice", "terms". */
  readonly document: string;
  /** The page's path on the app's origin: "/privacy". */
  readonly path: string;
  /** `YYYY-MM-DD`: the day, in UTC, the changes take effect. */
  readonly takesEffect: string;
  /** What changes, in plain words, one line each. */
  readonly changes: readonly string[];
}

/** A notice id: lower case letters, digits and dashes, starting with a letter or digit. */
export const NOTICE_ID_PATTERN = "^[a-z0-9][a-z0-9-]{0,62}$";

const NOTICE_ID = new RegExp(NOTICE_ID_PATTERN);
const DOCUMENT = /^[a-z][a-z ]{0,39}$/;
const PATH = /^(?:\/[a-z0-9-]+)+$/;
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const FIELDS = ["changes", "document", "path", "takesEffect"] as const;
const MAX_CHANGES = 8;
const MAX_CHANGE_LENGTH = 300;

/** An entry as the file holds it, each field still to be checked. */
interface RawNotice {
  readonly document?: unknown;
  readonly path?: unknown;
  readonly takesEffect?: unknown;
  readonly changes?: unknown;
}

/** A registry that does not parse. The message names the id and the field, never more. */
export class ChangeNoticeRegistryError extends Error {
  override readonly name = "ChangeNoticeRegistryError";
}

const refuse = (detail: string): never => {
  throw new ChangeNoticeRegistryError(`change-notice registry: ${detail}`);
};

/** Unix seconds at the UTC midnight of `day`, or undefined when no such day exists. */
function utcMidnight(day: string): number | undefined {
  const parts = DAY.exec(day);
  if (parts === null) return undefined;
  const [year, month, date] = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
  const ms = Date.UTC(year, month - 1, date);
  const back = new Date(ms);
  return back.getUTCFullYear() === year &&
    back.getUTCMonth() === month - 1 &&
    back.getUTCDate() === date
    ? ms / 1_000
    : undefined;
}

function parseNotice(id: string, entry: unknown): ChangeNotice {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    return refuse(`${id} is not an object`);
  }
  const keys = Object.keys(entry).toSorted();
  if (keys.join(",") !== FIELDS.join(",")) {
    return refuse(`${id} must hold exactly ${FIELDS.join(", ")}`);
  }
  const { document, path, takesEffect, changes } = entry as RawNotice;
  if (typeof document !== "string" || !DOCUMENT.test(document)) {
    return refuse(`${id}.document must be 1 to 40 lower-case letters and spaces`);
  }
  if (typeof path !== "string" || !PATH.test(path) || path.length > 64) {
    return refuse(`${id}.path must be a path such as /privacy`);
  }
  if (typeof takesEffect !== "string" || utcMidnight(takesEffect) === undefined) {
    return refuse(`${id}.takesEffect must be a day that exists, written YYYY-MM-DD`);
  }
  if (!Array.isArray(changes) || changes.length === 0 || changes.length > MAX_CHANGES) {
    return refuse(`${id}.changes must hold 1 to ${MAX_CHANGES} lines`);
  }
  for (const line of changes) {
    if (
      typeof line !== "string" ||
      line.trim() === "" ||
      line.length > MAX_CHANGE_LENGTH ||
      /[\r\n]/.test(line)
    ) {
      return refuse(`${id}.changes must be lines of 1 to ${MAX_CHANGE_LENGTH} characters`);
    }
  }
  return { document, path, takesEffect, changes: [...(changes as string[])] };
}

/**
 * The registry from the parsed JSON file. Throws {@link ChangeNoticeRegistryError}
 * on anything but an object of well-formed notices.
 */
export function parseChangeNotices(value: unknown): ReadonlyMap<string, ChangeNotice> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return refuse("the file must hold one object, by notice id");
  }
  const notices = new Map<string, ChangeNotice>();
  for (const [id, entry] of Object.entries(value)) {
    if (!NOTICE_ID.test(id)) return refuse(`an id must match ${NOTICE_ID_PATTERN}`);
    notices.set(id, parseNotice(id, entry));
  }
  return notices;
}

/** Unix seconds at the UTC midnight of the day `notice` takes effect. */
export function takesEffectSeconds(notice: ChangeNotice): number {
  return utcMidnight(notice.takesEffect) ?? refuse("takesEffect must be a day that exists");
}

/**
 * SHA-256, lower-case hex, of the notice's words in a fixed order. The
 * operator's check job shows the approver a notice and its digest; every call
 * of the run carries the digest, and osn-api refuses unless its own notice
 * hashes the same, so what is sent is what was approved.
 */
export async function noticeDigest(notice: ChangeNotice): Promise<string> {
  const canonical = JSON.stringify([
    notice.document,
    notice.path,
    notice.takesEffect,
    notice.changes,
  ]);
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
