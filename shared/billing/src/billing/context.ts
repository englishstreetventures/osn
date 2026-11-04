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
  /** Origins a return URL may point at, each as `URL.origin` gives it. */
  readonly returnOrigins: ReadonlySet<string>;
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
  returnOrigins: readonly string[];
  portalConfiguration: string | undefined;
  onAccess: BillingContext["onAccess"];
  now: (() => Date) | undefined;
}): BillingContext {
  const tax = input.tax ?? { automatic: false, collectTaxIds: false, requireTaxId: false };
  if (tax.requireTaxId && !tax.collectTaxIds) {
    throw new Error("tax.requireTaxId needs tax.collectTaxIds");
  }
  const policy: AccessPolicy = { ...DEFAULT_POLICY, ...definedOnly(input.policy) };
  for (const key of ["graceDays", "periodLeewayHours"] as const) {
    // A NaN here would make every period end a NaN, which no comparison orders.
    if (!Number.isFinite(policy[key]) || policy[key] < 0) {
      throw new Error(`policy.${key} must be a finite number of at least 0`);
    }
  }
  const tuning: Tuning = { ...DEFAULT_TUNING, ...definedOnly(input.tuning) };
  for (const [key, value] of Object.entries(tuning)) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`tuning.${key} must be a finite number above 0`);
    }
  }
  // The lease must outlive the longest application, or a newer holder could
  // take it while an older hook is still writing.
  const longestApply = tuning.hookTimeoutMs + tuning.accessBudgetMs;
  if (tuning.leaseMs <= longestApply) {
    throw new Error("tuning.leaseMs must exceed hookTimeoutMs + accessBudgetMs");
  }
  if (tuning.eventLeaseMs <= longestApply + input.provider.callTimeoutMs) {
    throw new Error(
      "tuning.eventLeaseMs must exceed hookTimeoutMs + accessBudgetMs + the provider's callTimeoutMs",
    );
  }
  const returnOrigins = new Set<string>();
  for (const origin of input.returnOrigins) {
    if (originOf(origin) !== origin) {
      throw new Error(`returnOrigins: ${origin} is not an origin such as https://app.example.com`);
    }
    returnOrigins.add(origin);
  }
  if (returnOrigins.size === 0) throw new Error("returnOrigins must name at least one origin");
  const features = new Set<string>();
  for (const plan of input.plans) for (const feature of plan.features) features.add(feature.id);
  return {
    plans: input.plans,
    planById: new Map(input.plans.map((plan) => [plan.id, plan])),
    featureIds: [...features],
    storage: input.storage,
    provider: input.provider,
    policy,
    tax,
    tuning,
    returnOrigins,
    portalConfiguration: input.portalConfiguration,
    onAccess: input.onAccess,
    now: input.now ?? (() => new Date()),
  };
}

export const after = (date: Date, ms: number) => new Date(date.getTime() + ms);

/** The URL's origin, or `null` when it does not parse. */
export function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** `overrides` without the keys it sets to `undefined`, which keep their default. */
function definedOnly<T extends object>(overrides: Partial<T> | undefined): Partial<T> {
  const out: Partial<T> = {};
  for (const key in overrides) {
    if (overrides[key] !== undefined) out[key] = overrides[key];
  }
  return out;
}
