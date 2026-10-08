/**
 * A wedding's people count against its plan's limit, as the API reports it.
 *
 * The API is the authority: it counts every seat below owner plus every owner
 * beyond the first two, reads the limit from the wedding's tier, and refuses a
 * write past it inside the statement that writes. The portal holds no copy of
 * the limits; every number here comes from `peopleLimit` on the co-host routes
 * (`GET`, `POST`, `PUT` and `DELETE` under `/hosts`) or from a 409
 * `people_limit_reached` body, which carries the same three fields.
 */

import { isPaidTier, isTier, type PaidTier, type Tier, TIER_LABEL } from "./tiers";

export interface PeopleLimit {
  used: number;
  limit: number;
  /** The lowest tier, at or above the wedding's own, with room for one more
   *  person; `null` when no tier has room. */
  tier: Tier | null;
}

const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;

/**
 * The people limit in `value`, or `null` when it carries none — an older API —
 * or one this build cannot trust. A malformed count is never guessed at: the
 * panel then behaves as it did before limits existed, and the API still
 * refuses what it must.
 */
export function readPeopleLimit(value: unknown): PeopleLimit | null {
  if (typeof value !== "object" || value === null) return null;
  const { used, limit, tier } = value as { used?: unknown; limit?: unknown; tier?: unknown };
  if (!isCount(used) || !isCount(limit)) return null;
  if (tier !== null && !isTier(tier)) return null;
  return { used, limit, tier };
}

/** Whether the wedding has no room for one more person. */
export const atPeopleLimit = (l: PeopleLimit): boolean => l.used >= l.limit;

/** The tier to offer an owner, or `null` while there is room or when no tier
 *  has any. */
export function upgradeTierFor(l: PeopleLimit): PaidTier | null {
  return atPeopleLimit(l) && isPaidTier(l.tier) ? l.tier : null;
}

/** "4 of 6 people". */
export const peopleCountLabel = (l: PeopleLimit): string => `${l.used} of ${l.limit} people`;

/**
 * Why no one more can join, and what would change that. Worded like the
 * guest-cap refusal (`import-errors.ts`): the limit, then the way out, and
 * plainly when no plan holds more.
 */
export function peopleLimitMessage(l: PeopleLimit): string {
  const upgrade = isPaidTier(l.tier) ? TIER_LABEL[l.tier] : null;
  if (l.used > l.limit) {
    const toRemove = l.used - l.limit + 1;
    const way = upgrade
      ? `remove ${toRemove} or upgrade to ${upgrade}`
      : `remove ${toRemove} first`;
    return `This wedding has ${l.used} people, more than its plan's limit of ${l.limit}. Everyone keeps their place; to add someone, ${way}.`;
  }
  const reached = `This wedding has reached its plan's limit of ${l.limit} people.`;
  return upgrade
    ? `${reached} Remove someone, or upgrade to ${upgrade}.`
    : `${reached} No plan holds more, so remove someone first.`;
}
