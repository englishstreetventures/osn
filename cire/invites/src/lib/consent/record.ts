import {
  CATEGORY_META,
  CONSENT_CATEGORIES,
  type ConsentCategory,
  isConsentCategory,
  isRequiredCategory,
} from "./categories";

/**
 * The consent record — what we persist, and the rules for reading it back.
 *
 * Deliberately a plain, versioned, self-describing object rather than a bag of
 * booleans: a stored decision has to survive us changing our minds about the
 * category list, and it has to be possible to tell "this guest refused
 * everything" apart from "this guest has never been asked". That distinction is
 * the whole point — the first must never re-prompt, the second always must.
 * `null` (no record) means unasked; a record with every optional grant `false`
 * means refused, and is a decision we are obliged to keep honouring.
 *
 * Under the opt-out defaults those two states also differ in what they ALLOW —
 * unasked permits `embeds`, refused does not — which makes conflating them a
 * privacy bug rather than merely a UX one. Three distinct grant maps exist for
 * that reason: {@link defaultGrants} (the floor), {@link preDecisionGrants}
 * (unasked), and {@link allGrants} (accept-all).
 */

/**
 * Storage-shape version. Bump ONLY when the record's structure changes in a way
 * `decodeConsentRecord` can't read; a mismatch discards the record and re-asks.
 */
export const CONSENT_RECORD_VERSION = 1;

/**
 * Policy version — bump when the set of vendors or what they do materially
 * changes, which invalidates previously-given consent because that consent was
 * never *informed* about the newcomer. A guest who agreed to a Pinterest embed
 * has not thereby agreed to whatever we add next month.
 *
 * Format is a plain date string so it's obvious from a stored cookie when the
 * guest's decision was taken against which disclosure. Bumping re-prompts
 * everyone exactly once, which is the intended cost.
 */
export const CONSENT_POLICY_VERSION = "2026-07-29";

export type ConsentGrants = Record<ConsentCategory, boolean>;

export interface ConsentRecord {
  /** {@link CONSENT_RECORD_VERSION} at the time of writing. */
  readonly v: number;
  /** {@link CONSENT_POLICY_VERSION} the guest decided against. */
  readonly policy: string;
  /** ISO-8601 timestamp of the decision — the GDPR Art. 7(1) audit trail. */
  readonly decidedAt: string;
  readonly grants: ConsentGrants;
}

/**
 * THE FLOOR: required categories on, everything else off.
 *
 * Two distinct jobs, both of which must stay at the floor no matter what the
 * opt-out defaults say:
 *
 *  1. What "Reject all" writes. A refusal means required-only, always.
 *  2. What applies BEFORE the stored decision has been read. A guest who
 *     previously refused must not get one third-party load in the window
 *     between first paint and the cookie being parsed — so the pre-hydration
 *     state is the floor, not {@link preDecisionGrants}.
 *
 * This used to double as the no-decision state too. It no longer does — see
 * {@link preDecisionGrants}. Conflating them is what would turn "we default
 * embeds on" into "we also ignore refusals for a few milliseconds".
 */
export function defaultGrants(): ConsentGrants {
  return Object.fromEntries(
    CONSENT_CATEGORIES.map((category) => [category, isRequiredCategory(category)]),
  ) as ConsentGrants;
}

/**
 * What applies to a guest who has been shown the banner but has not decided.
 *
 * Opt-out: `embeds` and `functional` are on here, `analytics` is not (see the
 * `defaultGranted` discussion in `categories.ts`). Distinct from
 * {@link defaultGrants} in both directions — it is more permissive than the
 * reject-all floor, and it must never be substituted for the pre-hydration
 * state, where we do not yet know whether a refusal is on file.
 */
export function preDecisionGrants(): ConsentGrants {
  return Object.fromEntries(
    CONSENT_CATEGORIES.map((category) => [category, CATEGORY_META[category].defaultGranted]),
  ) as ConsentGrants;
}

/** Every category on. Used by "Accept all". */
export function allGrants(): ConsentGrants {
  return Object.fromEntries(
    CONSENT_CATEGORIES.map((category) => [category, true]),
  ) as ConsentGrants;
}

/**
 * Coerce arbitrary/partial input into a complete, trustworthy grant map:
 * unknown keys dropped, non-booleans treated as `false`, missing categories
 * defaulted off, and required categories forced ON no matter what was passed.
 * Every path into the store funnels through here, so neither a stale cookie nor
 * a caller mistake can produce a record that switches off a necessary category.
 */
export function normaliseGrants(input: unknown): ConsentGrants {
  const grants = defaultGrants();
  if (typeof input !== "object" || input === null) return grants;

  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (!isConsentCategory(key)) continue;
    if (isRequiredCategory(key)) continue; // already true; not the caller's call
    grants[key] = value === true;
  }
  return grants;
}

/** Build a record stamped with the current versions and `now`. */
export function makeConsentRecord(grants: ConsentGrants, now: Date): ConsentRecord {
  return {
    v: CONSENT_RECORD_VERSION,
    policy: CONSENT_POLICY_VERSION,
    decidedAt: now.toISOString(),
    grants: normaliseGrants(grants),
  };
}

/** Serialise for storage. URI-encoded so it is safe as a cookie value. */
export function encodeConsentRecord(record: ConsentRecord): string {
  return encodeURIComponent(JSON.stringify(record));
}

/**
 * Is this a timestamp we are willing to carry forward as the record of when the
 * guest decided?
 *
 * `decidedAt` is the one field documented as an audit trail, and it arrives
 * from a cookie the client can rewrite — so it gets the same fail-closed
 * treatment as the two version fields rather than a bare `typeof` check. The
 * length bound stops a multi-kilobyte string being carried around in a field
 * whose only legitimate value is an ISO-8601 instant.
 */
const MAX_TIMESTAMP_LENGTH = 40;

function isPlausibleTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value.length === 0 || value.length > MAX_TIMESTAMP_LENGTH) return false;
  return !Number.isNaN(Date.parse(value));
}

/**
 * Parse a stored record back, or `null` if it cannot be trusted.
 *
 * Returns `null` — meaning "treat as never asked", i.e. re-prompt — for:
 * malformed/undecodable input, a structure-version mismatch, a policy version
 * other than the current one, and an implausible `decidedAt`. The policy check is the one that matters:
 * it is what guarantees a guest is re-asked after the vendor list changes,
 * instead of us silently reusing consent given for a smaller disclosure.
 */
export function decodeConsentRecord(raw: string | null | undefined): ConsentRecord | null {
  if (!raw) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeURIComponent(raw));
  } catch {
    // Undecodable percent-escapes or invalid JSON — a corrupted or hand-edited
    // value. Discard rather than guess.
    return null;
  }

  if (typeof parsed !== "object" || parsed === null) return null;
  const candidate = parsed as Partial<ConsentRecord>;

  if (candidate.v !== CONSENT_RECORD_VERSION) return null;
  if (candidate.policy !== CONSENT_POLICY_VERSION) return null;
  if (!isPlausibleTimestamp(candidate.decidedAt)) return null;

  return {
    v: CONSENT_RECORD_VERSION,
    policy: CONSENT_POLICY_VERSION,
    decidedAt: candidate.decidedAt,
    grants: normaliseGrants(candidate.grants),
  };
}

/**
 * Is `category` granted by this record?
 *
 * A `null` record — never asked, or one we refused to trust — falls back to
 * {@link preDecisionGrants}, i.e. the opt-out defaults. Callers that have not
 * yet READ the stored record must not use this path; see `store.ts`, which
 * holds the pre-hydration state at the floor instead.
 */
export function isGranted(record: ConsentRecord | null, category: ConsentCategory): boolean {
  if (!record) return preDecisionGrants()[category];
  return record.grants[category] === true;
}
