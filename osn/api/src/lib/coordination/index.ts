/**
 * Every piece of short-lived shared state osn-api keeps outside D1, as one
 * bundle: the rate limiters and per-account caps, the ceremony stores, the
 * step-up token guard, the three lockout counters and the health probe.
 *
 * Two builders produce it. `createInMemoryCoordination()` (`./memory`) keeps
 * everything in this process — the Bun dev server, the OpenAPI generator and
 * tests. `createDurableCoordination(ns, onError)` (`./durable`) puts every
 * store on the `COORDINATION` Durable Object binding, so every isolate of a
 * deployed Worker sees the same state. `buildAppDeps` takes a
 * {@link CoordinationBuilder} and calls it once, after the app runtime exists,
 * so a failed call is logged through that runtime.
 */

import type { CoordinationErrorHook } from "@shared/coordination";
import type { RateLimiterBackend } from "@shared/rate-limit";

import type { AccountErasureRateLimiters } from "../../routes/account-erasure";
import type { AuthRateLimiters } from "../../routes/auth/limiters";
import type { ProfileRateLimiters } from "../../routes/profile";
import type { RecommendationRateLimiters } from "../../routes/recommendations";
import type { AccountCapLimiter, CeremonyStores, StepUpJtiStore } from "../../services/auth/stores";
import type { RecoveryLockoutStore } from "../recovery-lockout-store";
import type { CoordinationBackend, CoordinationStoreName } from "./names";
import type { CoordinationProbe } from "./probe";

export type {
  CeremonyStoreName,
  CoordinationBackend,
  CoordinationStoreName,
  LockoutStoreName,
} from "./names";

export interface CoordinationStores {
  readonly backend: CoordinationBackend;
  /** Per-IP auth limiters. A deployed Worker moves the one-minute ones onto native bindings. */
  readonly authRateLimiters: AuthRateLimiters;
  /** Per-user graph writes. */
  readonly graphRateLimiter: RateLimiterBackend;
  /** Per-user organisation writes. */
  readonly orgRateLimiter: RateLimiterBackend;
  /** Per-IP profile create, delete and set-default. */
  readonly profileRateLimiters: ProfileRateLimiters;
  /** Per-user recommendation fan-out and search. */
  readonly recommendationRateLimiters: RecommendationRateLimiters;
  /** Per-account: one account export a day. */
  readonly accountExportLimiter: RateLimiterBackend;
  /** Per-IP guard in front of the account export. */
  readonly accountExportIpLimiter: RateLimiterBackend;
  /** Per-account deletion, restore and status. */
  readonly accountErasureRateLimiters: AccountErasureRateLimiters;
  /** Single-use guard for step-up token ids. */
  readonly stepUpJtiStore: StepUpJtiStore;
  readonly ceremonyStores: CeremonyStores;
  readonly recoveryLockoutStore: RecoveryLockoutStore;
  readonly recoveryOtpLockoutStore: RecoveryLockoutStore;
  readonly totpLockoutStore: RecoveryLockoutStore;
  readonly profileSwitchCap: AccountCapLimiter;
  readonly emailChangeBeginCap: AccountCapLimiter;
  readonly recoveryEmailBeginCap: AccountCapLimiter;
  /** `GET /health/coordination`'s write, read and remove on its own store. */
  readonly healthProbe: CoordinationProbe;
  /** Per-IP guard in front of the health probe. */
  readonly healthProbeLimiter: RateLimiterBackend;
}

/**
 * Told once about every failed store call, after any retry. It receives the
 * store's name and the operation, never a key or a value.
 */
export type CoordinationErrorReporter = CoordinationErrorHook<CoordinationStoreName>;

/** Builds the bundle. `buildAppDeps` calls it once with its error reporter. */
export type CoordinationBuilder = (onError: CoordinationErrorReporter) => CoordinationStores;
