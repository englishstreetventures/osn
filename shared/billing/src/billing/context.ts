import type { Effect } from "effect";

import type { AnyPlan } from "../plans";
import { DEFAULT_POLICY, type AccessPolicy } from "../policy";
import type { BillingProvider, TaxOptions } from "../provider/port";
import type { BillingStorage } from "../storage/port";
import { DEFAULT_TUNING, type AccessDecision, type AccessHookContext, type Tuning } from "./types";

/** Everything a billing instance's modules share, resolved once at `createBilling`. */
export interface BillingContext {
  readonly plans: readonly AnyPlan[];
  readonly planById: ReadonlyMap<string, AnyPlan>;
  readonly featureIds: readonly string[];
  readonly storage: BillingStorage;
  readonly provider: BillingProvider;
  readonly policy: AccessPolicy;
  readonly tax: TaxOptions;
  readonly tuning: Tuning;
  readonly portalConfiguration: string | undefined;
  readonly onAccess:
    | ((decision: AccessDecision, context: AccessHookContext) => Effect.Effect<void, unknown>)
    | undefined;
  readonly now: () => Date;
}

export function createContext(input: {
  plans: readonly AnyPlan[];
  storage: BillingStorage;
  provider: BillingProvider;
  policy: Partial<AccessPolicy> | undefined;
  tax: TaxOptions | undefined;
  tuning: Partial<Tuning> | undefined;
  portalConfiguration: string | undefined;
  onAccess: BillingContext["onAccess"];
  now: (() => Date) | undefined;
}): BillingContext {
  const tax = input.tax ?? { automatic: false, collectTaxIds: false, requireTaxId: false };
  if (tax.requireTaxId && !tax.collectTaxIds) {
    throw new Error("tax.requireTaxId needs tax.collectTaxIds");
  }
  const features = new Set<string>();
  for (const plan of input.plans) for (const feature of plan.features) features.add(feature.id);
  return {
    plans: input.plans,
    planById: new Map(input.plans.map((plan) => [plan.id, plan])),
    featureIds: [...features],
    storage: input.storage,
    provider: input.provider,
    policy: { ...DEFAULT_POLICY, ...input.policy },
    tax,
    tuning: { ...DEFAULT_TUNING, ...input.tuning },
    portalConfiguration: input.portalConfiguration,
    onAccess: input.onAccess,
    now: input.now ?? (() => new Date()),
  };
}

export const after = (date: Date, ms: number) => new Date(date.getTime() + ms);
