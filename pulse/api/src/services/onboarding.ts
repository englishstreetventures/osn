import {
  pulseAccountOnboarding,
  pulseProfileAccounts,
  type PulseAccountOnboarding,
} from "@pulse/db/schema";
import { Db } from "@pulse/db/service";
import { eq } from "drizzle-orm";
import { Data, Effect, Schema } from "effect";

import {
  metricOnboardingCompleted,
  metricOnboardingProfileAccountResolved,
  metricOnboardingStatusFetched,
} from "../metrics";
import { getAccountIdForProfile, GraphBridgeError, ProfileNotFoundError } from "./graphBridge";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class DatabaseError extends Data.TaggedError("OnboardingDatabaseError")<{
  readonly cause: unknown;
}> {}

export class ValidationError extends Data.TaggedError("OnboardingValidationError")<{
  readonly cause: unknown;
}> {}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

/**
 * Allowed interest categories. Mirrors the subset of `ALLOWED_CATEGORIES`
 * from `metrics.ts` that the UI exposes — `none` and `other` are excluded
 * because they're metric-side bucketing artefacts, not user-pickable
 * categories. Must stay in sync with the UI's `INTEREST_CATEGORIES`.
 */
export const INTEREST_CATEGORIES = [
  "music",
  "food",
  "sports",
  "arts",
  "tech",
  "community",
  "education",
  "social",
  "nightlife",
  "outdoor",
  "family",
] as const;

export type InterestCategory = (typeof INTEREST_CATEGORIES)[number];

const PermOutcomeSchema = Schema.Literal("granted", "denied", "prompt", "unsupported");
export type PermOutcome = Schema.Schema.Type<typeof PermOutcomeSchema>;

const InterestSchema = Schema.Literal(...INTEREST_CATEGORIES);

const CompleteOnboardingSchema = Schema.Struct({
  interests: Schema.Array(InterestSchema).pipe(Schema.maxItems(8)),
  notificationsOptIn: Schema.Boolean,
  eventRemindersOptIn: Schema.Boolean,
  notificationsPerm: PermOutcomeSchema,
  locationPerm: PermOutcomeSchema,
});

export type CompleteOnboardingInput = Schema.Schema.Type<typeof CompleteOnboardingSchema>;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface OnboardingStatus {
  completedAt: Date | null;
  interests: readonly InterestCategory[];
  notificationsOptIn: boolean;
  eventRemindersOptIn: boolean;
  notificationsPerm: PermOutcome;
  locationPerm: PermOutcome;
}

const DEFAULT_STATUS: OnboardingStatus = {
  completedAt: null,
  interests: [],
  notificationsOptIn: false,
  eventRemindersOptIn: false,
  notificationsPerm: "prompt",
  locationPerm: "prompt",
};

// ---------------------------------------------------------------------------
// profileId → accountId resolver (cached locally)
// ---------------------------------------------------------------------------

/**
 * Resolves the OSN accountId for `profileId`, hitting the local
 * `pulse_profile_accounts` cache first and falling through to an ARC S2S
 * call to `osn/api` on miss. The mapping is immutable (OSN does not move
 * profiles between accounts), so a cache hit is authoritative — no
 * staleness handling is needed.
 *
 * Privacy invariant: `accountId` is server-side-only (see
 * `osn/api/tests/privacy.test.ts`). It must never appear in HTTP responses
 * or any value that crosses back to the client.
 */
export const resolveAccountId = (
  profileId: string,
): Effect.Effect<string, ProfileNotFoundError | GraphBridgeError | DatabaseError, Db> =>
  Effect.gen(function* () {
    const { db } = yield* Db;

    const cached = yield* Effect.tryPromise({
      try: () =>
        db
          .select({ accountId: pulseProfileAccounts.accountId })
          .from(pulseProfileAccounts)
          .where(eq(pulseProfileAccounts.profileId, profileId))
          .limit(1),
      catch: (cause) => new DatabaseError({ cause }),
    });
    if (cached[0]) {
      metricOnboardingProfileAccountResolved("cache", "ok");
      return cached[0].accountId;
    }

    const accountId = yield* getAccountIdForProfile(profileId).pipe(
      Effect.tapError((e) =>
        Effect.sync(() => {
          metricOnboardingProfileAccountResolved(
            "bridge",
            e._tag === "ProfileNotFoundError" ? "validation_error" : "error",
          );
        }),
      ),
    );

    yield* Effect.tryPromise({
      try: () =>
        db
          .insert(pulseProfileAccounts)
          .values({ profileId, accountId, fetchedAt: new Date() })
          .onConflictDoNothing(),
      catch: (cause) => new DatabaseError({ cause }),
    });
    metricOnboardingProfileAccountResolved("bridge", "ok");
    return accountId;
  }).pipe(Effect.withSpan("pulse.onboarding.profile_account.resolve"));

// ---------------------------------------------------------------------------
// Status read
// ---------------------------------------------------------------------------

const parseInterests = (raw: string): readonly InterestCategory[] => {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const valid = new Set<string>(INTEREST_CATEGORIES);
    return parsed.filter((v): v is InterestCategory => typeof v === "string" && valid.has(v));
  } catch {
    return [];
  }
};

const rowToStatus = (row: PulseAccountOnboarding): OnboardingStatus => ({
  completedAt: row.completedAt,
  interests: parseInterests(row.interests),
  notificationsOptIn: row.notificationsOptIn,
  eventRemindersOptIn: row.eventRemindersOptIn,
  notificationsPerm: row.notificationsPerm,
  locationPerm: row.locationPerm,
});

/**
 * Returns the onboarding status for the account that owns `profileId`.
 * When no row exists yet, returns sane defaults so callers don't have to
 * check for null.
 */
export const getOnboardingStatus = (
  profileId: string,
): Effect.Effect<OnboardingStatus, ProfileNotFoundError | GraphBridgeError | DatabaseError, Db> =>
  Effect.gen(function* () {
    const accountId = yield* resolveAccountId(profileId);
    const { db } = yield* Db;
    const rows = yield* Effect.tryPromise({
      try: () =>
        db
          .select()
          .from(pulseAccountOnboarding)
          .where(eq(pulseAccountOnboarding.accountId, accountId))
          .limit(1),
      catch: (cause) => new DatabaseError({ cause }),
    });
    const row = rows[0];
    if (!row) {
      metricOnboardingStatusFetched(false);
      return DEFAULT_STATUS;
    }
    metricOnboardingStatusFetched(row.completedAt !== null);
    return rowToStatus(row);
  }).pipe(Effect.withSpan("pulse.onboarding.status.get"));

// ---------------------------------------------------------------------------
// Complete
// ---------------------------------------------------------------------------

/**
 * Marks onboarding complete for the account that owns `profileId`.
 *
 * Idempotent: a second call returns the existing row's `completedAt`
 * without overwriting it, so reloading the finish step or a duplicate
 * client submission doesn't reset captured preferences. Updating
 * preferences after completion is a separate (future) settings flow.
 */
export const completeOnboarding = (
  profileId: string,
  data: unknown,
): Effect.Effect<
  OnboardingStatus,
  ValidationError | ProfileNotFoundError | GraphBridgeError | DatabaseError,
  Db
> =>
  Effect.gen(function* () {
    const validated = yield* Schema.decodeUnknown(CompleteOnboardingSchema)(data).pipe(
      Effect.mapError((cause) => new ValidationError({ cause })),
    );

    const accountId = yield* resolveAccountId(profileId);
    const { db } = yield* Db;

    const existing = yield* Effect.tryPromise({
      try: () =>
        db
          .select()
          .from(pulseAccountOnboarding)
          .where(eq(pulseAccountOnboarding.accountId, accountId))
          .limit(1),
      catch: (cause) => new DatabaseError({ cause }),
    });

    if (existing[0]) {
      metricOnboardingCompleted({
        result: "ok",
        notificationsOptIn: existing[0].notificationsOptIn,
        eventRemindersOptIn: existing[0].eventRemindersOptIn,
        notificationsPerm: existing[0].notificationsPerm,
        locationPerm: existing[0].locationPerm,
        interestsCount: parseInterests(existing[0].interests).length,
      });
      return rowToStatus(existing[0]);
    }

    // SQLite `integer + timestamp` truncates to seconds, so build the
    // value with the same precision we'll read back. Without this, the
    // first call returns ms-precise `now` while a subsequent re-read of
    // the same row returns the second-truncated value.
    const now = new Date(Math.floor(Date.now() / 1000) * 1000);
    const interestsJson = JSON.stringify(validated.interests);
    yield* Effect.tryPromise({
      try: () =>
        db
          .insert(pulseAccountOnboarding)
          .values({
            accountId,
            completedAt: now,
            interests: interestsJson,
            notificationsOptIn: validated.notificationsOptIn,
            eventRemindersOptIn: validated.eventRemindersOptIn,
            notificationsPerm: validated.notificationsPerm,
            locationPerm: validated.locationPerm,
          })
          .onConflictDoNothing(),
      catch: (cause) => new DatabaseError({ cause }),
    });

    // S-L1: re-read the persisted row before returning. With
    // `onConflictDoNothing`, two concurrent first-completions both see
    // "no row" in the read above and both attempt to insert; one wins
    // and the other's payload is silently discarded. Returning `validated`
    // would tell the loser their preferences were saved when in fact the
    // winner's were. Re-selecting guarantees the response matches durable
    // state.
    const finalRows = yield* Effect.tryPromise({
      try: () =>
        db
          .select()
          .from(pulseAccountOnboarding)
          .where(eq(pulseAccountOnboarding.accountId, accountId))
          .limit(1),
      catch: (cause) => new DatabaseError({ cause }),
    });
    // The insert just ran with `onConflictDoNothing`, so a row must exist.
    const finalRow = finalRows[0]!;
    const finalStatus = rowToStatus(finalRow);

    metricOnboardingCompleted({
      result: "ok",
      notificationsOptIn: finalStatus.notificationsOptIn,
      eventRemindersOptIn: finalStatus.eventRemindersOptIn,
      notificationsPerm: finalStatus.notificationsPerm,
      locationPerm: finalStatus.locationPerm,
      interestsCount: finalStatus.interests.length,
    });

    return finalStatus;
  }).pipe(
    Effect.tapError((e) =>
      Effect.gen(function* () {
        if (e._tag === "OnboardingValidationError") {
          metricOnboardingCompleted({
            result: "validation_error",
            notificationsOptIn: false,
            eventRemindersOptIn: false,
            notificationsPerm: "prompt",
            locationPerm: "prompt",
            interestsCount: 0,
          });
          return;
        }
        yield* Effect.logError("onboarding complete failed", e);
        metricOnboardingCompleted({
          result: "error",
          notificationsOptIn: false,
          eventRemindersOptIn: false,
          notificationsPerm: "prompt",
          locationPerm: "prompt",
          interestsCount: 0,
        });
      }),
    ),
    Effect.withSpan("pulse.onboarding.complete"),
  );
