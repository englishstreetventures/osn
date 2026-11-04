/**
 * Who has access to what, as a pure function of stored billing state and the
 * time. No I/O: `check()`, the webhook, the sweep and `status()` all decide
 * through here, so the table below is the whole rule.
 *
 * | Status     | Access                                   |
 * |------------|------------------------------------------|
 * | `trialing` | until `trial_end` + leeway               |
 * | `active`   | until the current period's end + leeway  |
 * | `past_due` | until `past_due_since` + grace           |
 * | any other  | never                                    |
 *
 * An unexpired grant overrides the table. An unknown status gives no access and
 * is flagged so the caller can log it.
 */

/** Every subscription status Stripe documents for the pinned API version. */
export const KNOWN_STATUSES = [
  "incomplete",
  "incomplete_expired",
  "trialing",
  "active",
  "past_due",
  "canceled",
  "unpaid",
  "paused",
] as const;
export type KnownStatus = (typeof KNOWN_STATUSES)[number];

const KNOWN: ReadonlySet<string> = new Set(KNOWN_STATUSES);
export const isKnownStatus = (status: string): status is KnownStatus => KNOWN.has(status);

/**
 * Statuses that end a subscription for good. Every other status, unknown ones
 * included, still counts as a subscription the customer holds, so checkout
 * refuses a second one in the same group.
 */
const TERMINAL: ReadonlySet<string> = new Set(["canceled", "incomplete_expired"]);
export const isTerminalStatus = (status: string): boolean => TERMINAL.has(status);

export type AccessReason = "subscription" | "trial" | "grace" | "grant" | "none";

export interface AccessPolicy {
  /** Days of access while `past_due`. */
  readonly graceDays: number;
  /** Hours past a period or trial end before access stops, for a late renewal webhook. */
  readonly periodLeewayHours: number;
  /** A customer gets one trial, ever. */
  readonly oneTrialPerCustomer: boolean;
}

export const DEFAULT_POLICY: AccessPolicy = {
  graceDays: 7,
  periodLeewayHours: 48,
  oneTrialPerCustomer: true,
};

/** The stored facts about one subscription that access depends on. */
export interface SubscriptionFacts {
  readonly status: string;
  /** Feature ids the subscription's plan includes. */
  readonly features: readonly string[];
  readonly currentPeriodEnd: Date | null;
  readonly trialEnd: Date | null;
  readonly pastDueSince: Date | null;
}

export interface GrantFacts {
  readonly featureId: string;
  /** `null` is a grant with no expiry. */
  readonly expiresAt: Date | null;
}

/** One feature's answer for one customer. */
export interface FeatureAccess {
  readonly allowed: boolean;
  readonly reason: AccessReason;
  /** The deciding subscription's status, or `null` when no subscription bears on it. */
  readonly status: string | null;
  /** When the access ends (exclusive); `null` when denied or open-ended. */
  readonly until: Date | null;
}

export interface SubscriptionDecision {
  readonly allowed: boolean;
  readonly reason: Exclude<AccessReason, "grant">;
  readonly until: Date | null;
  readonly unknownStatus: boolean;
}

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

const plus = (date: Date | null, ms: number): Date | null =>
  date === null ? null : new Date(date.getTime() + ms);

/** When the status's own rule says access ends, or `null` when it gives none. */
function accessEnd(facts: SubscriptionFacts, policy: AccessPolicy): Date | null {
  const leeway = policy.periodLeewayHours * HOUR_MS;
  switch (facts.status) {
    case "trialing": {
      return plus(facts.trialEnd, leeway);
    }
    case "active": {
      return plus(facts.currentPeriodEnd, leeway);
    }
    case "past_due": {
      return plus(facts.pastDueSince, policy.graceDays * DAY_MS);
    }
    default: {
      return null;
    }
  }
}

const reasonFor = (status: string): SubscriptionDecision["reason"] =>
  status === "trialing"
    ? "trial"
    : status === "active"
      ? "subscription"
      : status === "past_due"
        ? "grace"
        : "none";

export function decideSubscription(
  facts: SubscriptionFacts,
  policy: AccessPolicy,
  now: Date,
): SubscriptionDecision {
  const unknownStatus = !isKnownStatus(facts.status);
  const end = accessEnd(facts, policy);
  // Written so that an end that is not a number (NaN) refuses access.
  if (end === null || !(end.getTime() > now.getTime())) {
    return { allowed: false, reason: "none", until: null, unknownStatus };
  }
  return {
    allowed: true,
    reason: reasonFor(facts.status),
    until: end,
    unknownStatus,
  };
}

const grantLive = (grant: GrantFacts, now: Date) =>
  grant.expiresAt === null || grant.expiresAt.getTime() > now.getTime();

export function decideFeature(input: {
  readonly featureId: string;
  readonly subscriptions: readonly SubscriptionFacts[];
  readonly grants: readonly GrantFacts[];
  readonly policy: AccessPolicy;
  readonly now: Date;
}): FeatureAccess {
  const relevant = input.subscriptions.filter((s) => s.features.includes(input.featureId));
  const status = relevant[0]?.status ?? null;

  // A grant with no expiry outlasts every dated one.
  const grants = input.grants.filter(
    (g) => g.featureId === input.featureId && grantLive(g, input.now),
  );
  if (grants.length > 0) {
    const open = grants.some((g) => g.expiresAt === null);
    const latest = Math.max(...grants.map((g) => g.expiresAt?.getTime() ?? 0));
    return { allowed: true, reason: "grant", status, until: open ? null : new Date(latest) };
  }

  let best: { decision: SubscriptionDecision; status: string } | null = null;
  for (const facts of relevant) {
    const decision = decideSubscription(facts, input.policy, input.now);
    if (!decision.allowed) continue;
    if (best === null || (decision.until?.getTime() ?? 0) > (best.decision.until?.getTime() ?? 0)) {
      best = { decision, status: facts.status };
    }
  }
  if (best === null) return { allowed: false, reason: "none", status, until: null };
  return {
    allowed: true,
    reason: best.decision.reason,
    status: best.status,
    until: best.decision.until,
  };
}

/**
 * The earliest future moment at which some decision for this customer changes
 * with no write: a grant expiring, grace running out, a period or trial ending.
 * `null` when nothing is pending.
 */
export function nextBoundary(input: {
  readonly subscriptions: readonly SubscriptionFacts[];
  readonly grants: readonly GrantFacts[];
  readonly policy: AccessPolicy;
  readonly now: Date;
}): Date | null {
  const nowMs = input.now.getTime();
  const candidates: number[] = [];
  for (const facts of input.subscriptions) {
    const end = accessEnd(facts, input.policy);
    if (end !== null) candidates.push(end.getTime());
  }
  for (const grant of input.grants) {
    if (grant.expiresAt !== null) candidates.push(grant.expiresAt.getTime());
  }
  const future = candidates.filter((ms) => ms > nowMs);
  return future.length === 0 ? null : new Date(Math.min(...future));
}
