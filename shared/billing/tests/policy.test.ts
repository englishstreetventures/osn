import { describe, expect, it } from "vitest";

import {
  DEFAULT_POLICY,
  decideFeature,
  decideSubscription,
  nextBoundary,
  type SubscriptionFacts,
} from "../src/policy";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const now = new Date("2030-06-01T00:00:00.000Z");
const at = (offsetMs: number) => new Date(now.getTime() + offsetMs);
const LEEWAY = DEFAULT_POLICY.periodLeewayHours * HOUR;
const GRACE = DEFAULT_POLICY.graceDays * DAY;

const sub = (over: Partial<SubscriptionFacts>): SubscriptionFacts => ({
  status: "active",
  features: ["workspace"],
  currentPeriodEnd: null,
  trialEnd: null,
  pastDueSince: null,
  ...over,
});

describe("decideSubscription", () => {
  const cases: Array<[string, Partial<SubscriptionFacts>, boolean, string]> = [
    [
      "trialing inside trial end + leeway",
      { status: "trialing", trialEnd: at(-LEEWAY + 1) },
      true,
      "trial",
    ],
    [
      "trialing past trial end + leeway",
      { status: "trialing", trialEnd: at(-LEEWAY) },
      false,
      "none",
    ],
    ["trialing with no trial end", { status: "trialing" }, false, "none"],
    [
      "active inside period end + leeway",
      { status: "active", currentPeriodEnd: at(-LEEWAY + 1) },
      true,
      "subscription",
    ],
    [
      "active past period end + leeway",
      { status: "active", currentPeriodEnd: at(-LEEWAY) },
      false,
      "none",
    ],
    ["past_due inside grace", { status: "past_due", pastDueSince: at(-GRACE + 1) }, true, "grace"],
    ["past_due past grace", { status: "past_due", pastDueSince: at(-GRACE) }, false, "none"],
    ["past_due with no start", { status: "past_due" }, false, "none"],
    ...(["canceled", "unpaid", "incomplete", "incomplete_expired", "paused"] as const).map(
      (status): [string, Partial<SubscriptionFacts>, boolean, string] => [
        status,
        { status, currentPeriodEnd: at(DAY), trialEnd: at(DAY), pastDueSince: now },
        false,
        "none",
      ],
    ),
  ];
  it.each(cases)("%s", (_name, facts, allowed, reason) => {
    const decision = decideSubscription(sub(facts), DEFAULT_POLICY, now);
    expect([decision.allowed, decision.reason, decision.unknownStatus]).toEqual([
      allowed,
      reason,
      false,
    ]);
  });

  it("gives an unknown status no access, and flags it", () => {
    const decision = decideSubscription(
      sub({ status: "frozen", currentPeriodEnd: at(DAY) }),
      DEFAULT_POLICY,
      now,
    );
    expect([decision.allowed, decision.unknownStatus]).toEqual([false, true]);
  });

  it("says until when access ends", () => {
    const decision = decideSubscription(sub({ currentPeriodEnd: at(DAY) }), DEFAULT_POLICY, now);
    expect(decision.until).toEqual(at(DAY + LEEWAY));
  });
});

describe("decideFeature", () => {
  it("lets an unexpired grant override a lapsed subscription", () => {
    const access = decideFeature({
      featureId: "workspace",
      subscriptions: [sub({ status: "canceled" })],
      grants: [{ featureId: "workspace", expiresAt: at(DAY) }],
      policy: DEFAULT_POLICY,
      now,
    });
    expect([access.allowed, access.reason, access.until]).toEqual([true, "grant", at(DAY)]);
  });

  it("ignores an expired grant, and treats a grant with no expiry as permanent", () => {
    const expired = decideFeature({
      featureId: "workspace",
      subscriptions: [],
      grants: [{ featureId: "workspace", expiresAt: now }],
      policy: DEFAULT_POLICY,
      now,
    });
    const permanent = decideFeature({
      featureId: "workspace",
      subscriptions: [],
      grants: [{ featureId: "workspace", expiresAt: null }],
      policy: DEFAULT_POLICY,
      now,
    });
    expect([expired.allowed, permanent.allowed, permanent.until]).toEqual([false, true, null]);
  });

  it("reports the latest end when several subscriptions allow the feature", () => {
    const access = decideFeature({
      featureId: "workspace",
      subscriptions: [
        sub({ status: "active", currentPeriodEnd: at(DAY) }),
        sub({ status: "trialing", trialEnd: at(3 * DAY) }),
      ],
      grants: [],
      policy: DEFAULT_POLICY,
      now,
    });
    expect([access.reason, access.status, access.until]).toEqual([
      "trial",
      "trialing",
      at(3 * DAY + LEEWAY),
    ]);
  });

  it("reports the latest expiry when several dated grants allow the feature", () => {
    const access = decideFeature({
      featureId: "workspace",
      subscriptions: [],
      grants: [
        { featureId: "workspace", expiresAt: at(DAY) },
        { featureId: "workspace", expiresAt: at(3 * DAY) },
      ],
      policy: DEFAULT_POLICY,
      now,
    });
    expect([access.reason, access.until]).toEqual(["grant", at(3 * DAY)]);
  });

  it("gives no access to a feature the active plan does not include", () => {
    const access = decideFeature({
      featureId: "reports",
      subscriptions: [sub({ currentPeriodEnd: at(DAY) })],
      grants: [{ featureId: "workspace", expiresAt: null }],
      policy: DEFAULT_POLICY,
      now,
    });
    expect([access.allowed, access.reason, access.status]).toEqual([false, "none", null]);
  });
});

describe("nextBoundary", () => {
  it("is the earliest future time any decision can change on its own", () => {
    const boundary = nextBoundary({
      subscriptions: [
        sub({ status: "active", currentPeriodEnd: at(10 * DAY) }),
        sub({ status: "trialing", trialEnd: at(5 * DAY) }),
        sub({ status: "past_due", pastDueSince: at(-GRACE + 3 * DAY) }),
      ],
      grants: [{ featureId: "workspace", expiresAt: at(4 * DAY) }],
      policy: DEFAULT_POLICY,
      now,
    });
    expect(boundary).toEqual(at(3 * DAY));
  });

  it("is null when every candidate is past or there is none", () => {
    const boundary = nextBoundary({
      subscriptions: [
        sub({ status: "active", currentPeriodEnd: at(-LEEWAY - 1) }),
        sub({ status: "canceled" }),
      ],
      grants: [
        { featureId: "workspace", expiresAt: at(-1) },
        { featureId: "workspace", expiresAt: null },
      ],
      policy: DEFAULT_POLICY,
      now,
    });
    expect(boundary).toBeNull();
  });
});
