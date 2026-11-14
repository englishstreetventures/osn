import type { CheckEmailPurpose } from "./CheckEmailView";

/**
 * How many wrong numbers on a flow's emailed links stop its links, and for how
 * long: the rule the link page states. osn-api enforces it. This package
 * cannot import osn-api, so these copy its values, and
 * `tests/link-lockout.contract.test.ts` fails when the two differ.
 *
 * - Sign-up and email change count wrong numbers per address on one counter
 *   (`REGISTRATION_LINK_LOCKOUT_*`, `osn/api/src/services/auth/constants.ts`):
 *   once it is full, no link of either flow goes to that address.
 * - Recovery and step-up each count per account, on counters of their own
 *   with recovery's numbers (`RECOVERY_LOCKOUT_*`,
 *   `osn/api/src/lib/recovery-lockout-store.ts`): once one is full, that
 *   flow mails no link and refuses even the right number.
 *
 * Each window opens at the first wrong number, so the stop lasts until the
 * window ends: "for up to" its length.
 */
export interface LinkLockout {
  /** Wrong numbers in one window that stop the links. */
  readonly wrong: number;
  readonly windowMs: number;
  /** What the count is kept for. */
  readonly scope: "address" | "account";
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

const ADDRESS: LinkLockout = { wrong: 3, windowMs: DAY_MS, scope: "address" };
const ACCOUNT: LinkLockout = { wrong: 5, windowMs: 15 * MINUTE_MS, scope: "account" };

export const LINK_LOCKOUT = {
  "sign-up": ADDRESS,
  recovery: ACCOUNT,
  "step-up": ACCOUNT,
  "email-change": ADDRESS,
} as const satisfies Record<CheckEmailPurpose, LinkLockout>;

/** A window in words: "a day", "2 hours", "15 minutes". */
function span(ms: number): string {
  const [unit, size] =
    ms % DAY_MS === 0
      ? ["day", DAY_MS]
      : ms % HOUR_MS === 0
        ? ["hour", HOUR_MS]
        : ["minute", MINUTE_MS];
  const count = Math.round(ms / size);
  if (count === 1) return unit === "hour" ? "an hour" : `a ${unit}`;
  return `${count} ${unit}s`;
}

/**
 * The rule in one sentence: "After 3 wrong numbers in a day, links to this
 * address stop for up to a day." It says what happens, never whether it has.
 */
export function lockoutRule(purpose: CheckEmailPurpose): string {
  const rule = LINK_LOCKOUT[purpose];
  const window = span(rule.windowMs);
  const links = rule.scope === "address" ? "links to this address" : "links like this one";
  return `After ${rule.wrong} wrong numbers in ${window}, ${links} stop for up to ${window}.`;
}
