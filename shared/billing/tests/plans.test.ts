import { describe, expect, it } from "vitest";

import { assertDistinctPlans, defineFeature, definePlan } from "../src/plans";
import { annual, monthly, workspace } from "./support/billing";

const price = {
  interval: "month",
  defaultCurrency: "AUD",
  amounts: { AUD: 4900 },
  taxBehavior: "exclusive",
} as const;

const plan = (over: Record<string, unknown> = {}) =>
  definePlan({
    id: "starter",
    name: "Starter",
    group: "workspace",
    lookupKey: "workspace_starter_v1",
    features: [workspace],
    price,
    ...over,
  } as Parameters<typeof definePlan>[0]);

describe("defineFeature", () => {
  it.each(["", "Reports", "1reports", "re-ports", "a".repeat(65)])("refuses the id %j", (id) => {
    expect(() => defineFeature({ id })).toThrow(/must match/);
  });
});

describe("definePlan", () => {
  it("accepts a well-formed plan", () => {
    expect(plan().id).toBe("starter");
  });

  it.each(["", "Starter", "1starter", "star-ter"])("refuses the id %j", (id) => {
    expect(() => plan({ id })).toThrow(/must match/);
  });

  it.each(["", "   "])("refuses the lookup key %j", (lookupKey) => {
    expect(() => plan({ lookupKey })).toThrow(/lookup key/);
  });

  it.each([1.5, -1, Number.NaN])("refuses trialDays %s", (trialDays) => {
    expect(() => plan({ trialDays })).toThrow(/trialDays/);
  });

  it("refuses a currency that is not upper-case ISO 4217", () => {
    expect(() => plan({ price: { ...price, amounts: { aud: 4900 } } })).toThrow(/upper-case/);
  });

  it.each([0, -100, 49.5])("refuses the amount %s", (amount) => {
    expect(() => plan({ price: { ...price, amounts: { AUD: amount } } })).toThrow(
      /positive whole number/,
    );
  });

  it("refuses a default currency with no amount", () => {
    expect(() => plan({ price: { ...price, amounts: { USD: 3500 } } })).toThrow(
      /default currency AUD/,
    );
  });
});

describe("assertDistinctPlans", () => {
  it("accepts distinct plans", () => {
    expect(() => assertDistinctPlans([monthly, annual])).not.toThrow();
  });

  it("refuses a plan id used twice", () => {
    expect(() => assertDistinctPlans([monthly, plan({ id: "monthly" })])).toThrow(
      /"monthly" is defined twice/,
    );
  });

  it("refuses a lookup key used twice", () => {
    expect(() => assertDistinctPlans([monthly, plan({ lookupKey: monthly.lookupKey })])).toThrow(
      /used twice/,
    );
  });
});
