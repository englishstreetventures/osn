import { it, expect } from "@effect/vitest";
import { pulseAccountOnboarding } from "@pulse/db/schema";
import { Db } from "@pulse/db/service";
import { Effect } from "effect";
import { vi, beforeEach, describe } from "vitest";

import {
  completeOnboarding,
  getOnboardingStatus,
  resolveAccountId,
} from "../../src/services/onboarding";
import { createTestLayer } from "../helpers/db";

vi.mock("../../src/services/graphBridge", () => ({
  GraphBridgeError: class GraphBridgeError {
    _tag = "GraphBridgeError";
    constructor(public args: { cause: unknown }) {}
  },
  ProfileNotFoundError: class ProfileNotFoundError {
    _tag = "ProfileNotFoundError";
    constructor(public args: { profileId: string }) {}
  },
  getAccountIdForProfile: vi.fn(() => Effect.succeed("acc_default")),
}));

import * as bridge from "../../src/services/graphBridge";

beforeEach(() => {
  vi.mocked(bridge.getAccountIdForProfile).mockReturnValue(Effect.succeed("acc_alice"));
});

// ---------------------------------------------------------------------------
// resolveAccountId
// ---------------------------------------------------------------------------

describe("resolveAccountId", () => {
  it.effect("hits the bridge on first call and caches the result", () =>
    Effect.gen(function* () {
      const a1 = yield* resolveAccountId("usr_alice");
      const a2 = yield* resolveAccountId("usr_alice");
      expect(a1).toBe("acc_alice");
      expect(a2).toBe("acc_alice");
      // Second call should hit the cache, not the bridge.
      expect(vi.mocked(bridge.getAccountIdForProfile)).toHaveBeenCalledTimes(1);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("propagates ProfileNotFoundError from the bridge", () =>
    Effect.gen(function* () {
      vi.mocked(bridge.getAccountIdForProfile).mockReturnValue(
        Effect.fail(new bridge.ProfileNotFoundError({ profileId: "usr_ghost" })),
      );
      const err = yield* Effect.flip(resolveAccountId("usr_ghost"));
      expect(err._tag).toBe("ProfileNotFoundError");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("propagates GraphBridgeError from the bridge (infra-failure signal)", () =>
    Effect.gen(function* () {
      vi.mocked(bridge.getAccountIdForProfile).mockReturnValue(
        Effect.fail(new bridge.GraphBridgeError({ cause: new Error("upstream 500") })),
      );
      const err = yield* Effect.flip(resolveAccountId("usr_alice"));
      expect(err._tag).toBe("GraphBridgeError");
    }).pipe(Effect.provide(createTestLayer())),
  );
});

// ---------------------------------------------------------------------------
// getOnboardingStatus
// ---------------------------------------------------------------------------

describe("getOnboardingStatus", () => {
  it.effect("returns defaults when no row exists for the account", () =>
    Effect.gen(function* () {
      const status = yield* getOnboardingStatus("usr_alice");
      expect(status.completedAt).toBeNull();
      expect(status.interests).toEqual([]);
      expect(status.notificationsOptIn).toBe(false);
      expect(status.eventRemindersOptIn).toBe(false);
      expect(status.notificationsPerm).toBe("prompt");
      expect(status.locationPerm).toBe("prompt");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("returns the stored row after completion", () =>
    Effect.gen(function* () {
      yield* completeOnboarding("usr_alice", {
        interests: ["music", "food"],
        notificationsOptIn: true,
        eventRemindersOptIn: false,
        notificationsPerm: "granted",
        locationPerm: "denied",
      });
      const status = yield* getOnboardingStatus("usr_alice");
      expect(status.completedAt).toBeInstanceOf(Date);
      expect(status.interests).toEqual(["music", "food"]);
      expect(status.notificationsOptIn).toBe(true);
      expect(status.eventRemindersOptIn).toBe(false);
      expect(status.notificationsPerm).toBe("granted");
      expect(status.locationPerm).toBe("denied");
    }).pipe(Effect.provide(createTestLayer())),
  );

  // Privacy invariant — defence-in-depth at the service layer. The route
  // layer also asserts this on the wire shape, but a field added here for
  // "convenience" would still pass the wire test if `toWire` strips it.
  // Asserting on the service surface keeps the invariant one-deep at every
  // boundary. Mirrors osn/api/tests/privacy.test.ts.
  it.effect("returned status object never carries accountId (privacy invariant)", () =>
    Effect.gen(function* () {
      const empty = yield* getOnboardingStatus("usr_alice");
      expect(Object.keys(empty)).not.toContain("accountId");
      expect(Object.keys(empty)).not.toContain("account_id");

      const completed = yield* completeOnboarding("usr_alice", {
        interests: ["music"],
        notificationsOptIn: true,
        eventRemindersOptIn: true,
        notificationsPerm: "granted",
        locationPerm: "granted",
      });
      expect(Object.keys(completed)).not.toContain("accountId");
      expect(Object.keys(completed)).not.toContain("account_id");

      const reread = yield* getOnboardingStatus("usr_alice");
      expect(Object.keys(reread)).not.toContain("accountId");
      expect(Object.keys(reread)).not.toContain("account_id");
    }).pipe(Effect.provide(createTestLayer())),
  );
});

// ---------------------------------------------------------------------------
// completeOnboarding
// ---------------------------------------------------------------------------

describe("completeOnboarding", () => {
  it.effect("inserts a row with the validated payload", () =>
    Effect.gen(function* () {
      const result = yield* completeOnboarding("usr_alice", {
        interests: ["music", "tech", "outdoor"],
        notificationsOptIn: true,
        eventRemindersOptIn: true,
        notificationsPerm: "granted",
        locationPerm: "granted",
      });
      expect(result.completedAt).toBeInstanceOf(Date);
      expect(result.interests).toEqual(["music", "tech", "outdoor"]);
      expect(result.notificationsOptIn).toBe(true);
      expect(result.eventRemindersOptIn).toBe(true);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("is idempotent — second call returns the original completedAt", () =>
    Effect.gen(function* () {
      const first = yield* completeOnboarding("usr_alice", {
        interests: ["music"],
        notificationsOptIn: false,
        eventRemindersOptIn: false,
        notificationsPerm: "denied",
        locationPerm: "prompt",
      });
      const second = yield* completeOnboarding("usr_alice", {
        // Different payload — should be ignored on the second call.
        interests: ["food", "arts"],
        notificationsOptIn: true,
        eventRemindersOptIn: true,
        notificationsPerm: "granted",
        locationPerm: "granted",
      });
      expect(second.completedAt?.getTime()).toBe(first.completedAt?.getTime());
      expect(second.interests).toEqual(["music"]);
      expect(second.notificationsOptIn).toBe(false);
    }).pipe(Effect.provide(createTestLayer())),
  );

  // S-L1: with `onConflictDoNothing` two concurrent first-time completes
  // both pass the "no row exists" check, both attempt to insert, one
  // wins. The loser's payload was historically returned to the client
  // even though it wasn't persisted. After re-selecting before return,
  // the loser sees the winner's state — UI and DB stay consistent.
  it.effect("race-loser receives the persisted (winner's) state, not their own input (S-L1)", () =>
    Effect.gen(function* () {
      // Pre-seed the row directly to simulate the winner having already
      // committed by the time the loser's "no row exists" read fires.
      const { db } = yield* Db;
      yield* Effect.tryPromise({
        try: () =>
          db.insert(pulseAccountOnboarding).values({
            accountId: "acc_alice",
            completedAt: new Date(Math.floor(Date.now() / 1000) * 1000),
            interests: '["music"]',
            notificationsOptIn: true,
            eventRemindersOptIn: true,
            notificationsPerm: "granted",
            locationPerm: "granted",
          }),
        catch: () => new Error("seed failed"),
      });
      // Now call complete with a *different* payload — it should return
      // the winner's state, not the input we passed.
      const result = yield* completeOnboarding("usr_alice", {
        interests: ["food", "arts"],
        notificationsOptIn: false,
        eventRemindersOptIn: false,
        notificationsPerm: "denied",
        locationPerm: "denied",
      });
      expect(result.interests).toEqual(["music"]);
      expect(result.notificationsOptIn).toBe(true);
      expect(result.notificationsPerm).toBe("granted");
      expect(result.locationPerm).toBe("granted");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("two profiles on the same account share onboarding state", () =>
    Effect.gen(function* () {
      // Both profiles resolve to acc_shared.
      vi.mocked(bridge.getAccountIdForProfile).mockReturnValue(Effect.succeed("acc_shared"));

      yield* completeOnboarding("usr_first_profile", {
        interests: ["music"],
        notificationsOptIn: true,
        eventRemindersOptIn: true,
        notificationsPerm: "granted",
        locationPerm: "granted",
      });

      // Different profile, same account — should already be onboarded.
      const status = yield* getOnboardingStatus("usr_second_profile");
      expect(status.completedAt).toBeInstanceOf(Date);
      expect(status.interests).toEqual(["music"]);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("rejects unknown interest categories with ValidationError", () =>
    Effect.gen(function* () {
      const err = yield* Effect.flip(
        completeOnboarding("usr_alice", {
          interests: ["definitely_not_a_category"],
          notificationsOptIn: false,
          eventRemindersOptIn: false,
          notificationsPerm: "prompt",
          locationPerm: "prompt",
        }),
      );
      expect(err._tag).toBe("OnboardingValidationError");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("rejects more than 8 interests with ValidationError", () =>
    Effect.gen(function* () {
      const err = yield* Effect.flip(
        completeOnboarding("usr_alice", {
          interests: [
            "music",
            "food",
            "sports",
            "arts",
            "tech",
            "community",
            "education",
            "social",
            "nightlife",
          ],
          notificationsOptIn: false,
          eventRemindersOptIn: false,
          notificationsPerm: "prompt",
          locationPerm: "prompt",
        }),
      );
      expect(err._tag).toBe("OnboardingValidationError");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("rejects unknown perm outcomes with ValidationError", () =>
    Effect.gen(function* () {
      const err = yield* Effect.flip(
        completeOnboarding("usr_alice", {
          interests: [],
          notificationsOptIn: false,
          eventRemindersOptIn: false,
          notificationsPerm: "maybe",
          locationPerm: "prompt",
        }),
      );
      expect(err._tag).toBe("OnboardingValidationError");
    }).pipe(Effect.provide(createTestLayer())),
  );
});
