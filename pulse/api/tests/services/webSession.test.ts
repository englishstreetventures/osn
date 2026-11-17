import { it, expect } from "@effect/vitest";
import { pulseWebSessions } from "@pulse/db/schema";
import { Db } from "@pulse/db/service";
import { hashToken } from "@shared/crypto/tokens";
import { Effect } from "effect";

import { webSessionService, type WebIdentity } from "../../src/services/webSession";
import { createTestLayer } from "../helpers/db";

const identity: WebIdentity = {
  osnProfileId: "usr_alice",
  osnSub: "pairwise-sub-for-pulse",
  email: "alice@example.com",
  handle: "alice",
  displayName: "Alice",
  avatarUrl: null,
};

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

it.effect("create returns a token that is stored only as a hash", () =>
  Effect.gen(function* () {
    const { token } = yield* webSessionService.create(identity);
    expect(token.length).toBeGreaterThan(20);

    const { db } = yield* Db;
    const rows = yield* Effect.promise(() => db.select().from(pulseWebSessions));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.token).not.toBe(token);
    expect(rows[0]?.token).toBe(yield* hashToken(token));
    expect(rows[0]?.osnProfileId).toBe("usr_alice");
    expect(rows[0]?.osnSub).toBe("pairwise-sub-for-pulse");
  }).pipe(Effect.provide(createTestLayer())),
);

it.effect("create honours the TTL it is given", () =>
  Effect.gen(function* () {
    const before = Date.now();
    const { expiresAt } = yield* webSessionService.create(identity, 60);
    // Bounded either side rather than exact — the clock moves between the two reads.
    expect(expiresAt.getTime()).toBeGreaterThanOrEqual(before + 60_000);
    expect(expiresAt.getTime()).toBeLessThan(before + 60_000 + 5_000);
  }).pipe(Effect.provide(createTestLayer())),
);

// ---------------------------------------------------------------------------
// validate
// ---------------------------------------------------------------------------

it.effect("validate resolves a live token to its login-time identity snapshot", () =>
  Effect.gen(function* () {
    const { token } = yield* webSessionService.create(identity);
    const session = yield* webSessionService.validate(token);
    expect(session.osnProfileId).toBe("usr_alice");
    expect(session.osnSub).toBe("pairwise-sub-for-pulse");
    expect(session.email).toBe("alice@example.com");
    expect(session.handle).toBe("alice");
    expect(session.displayName).toBe("Alice");
    expect(session.avatarUrl).toBeNull();
  }).pipe(Effect.provide(createTestLayer())),
);

it.effect("validate fails `expired` for a lapsed token and leaves the row in place", () =>
  Effect.gen(function* () {
    // Negative TTL puts `expiresAt` in the past without waiting on a clock.
    const { token } = yield* webSessionService.create(identity, -1);
    const err = yield* Effect.flip(webSessionService.validate(token));
    expect(err.reason).toBe("expired");

    // Expiry is reported, never deleted — `sweepExpired` owns removal, so a
    // read path stays a read path.
    const { db } = yield* Db;
    const rows = yield* Effect.promise(() => db.select().from(pulseWebSessions));
    expect(rows).toHaveLength(1);
  }).pipe(Effect.provide(createTestLayer())),
);

// ---------------------------------------------------------------------------
// revoke / revokeAllForProfile
// ---------------------------------------------------------------------------

it.effect("revoke drops only the session it names", () =>
  Effect.gen(function* () {
    const first = yield* webSessionService.create(identity);
    const second = yield* webSessionService.create(identity);

    yield* webSessionService.revoke(first.token);

    const err = yield* Effect.flip(webSessionService.validate(first.token));
    expect(err.reason).toBe("missing");
    const survivor = yield* webSessionService.validate(second.token);
    expect(survivor.osnProfileId).toBe("usr_alice");
  }).pipe(Effect.provide(createTestLayer())),
);

// ---------------------------------------------------------------------------
// sweepExpired
// ---------------------------------------------------------------------------

it.effect("sweepExpired deletes lapsed rows, counts them, and spares live ones", () =>
  Effect.gen(function* () {
    yield* webSessionService.create(identity, -1);
    yield* webSessionService.create(identity, -1);
    const live = yield* webSessionService.create(identity);

    const deleted = yield* webSessionService.sweepExpired();
    expect(deleted).toBe(2);

    const { db } = yield* Db;
    const rows = yield* Effect.promise(() => db.select().from(pulseWebSessions));
    expect(rows).toHaveLength(1);
    expect((yield* webSessionService.validate(live.token)).osnProfileId).toBe("usr_alice");
  }).pipe(Effect.provide(createTestLayer())),
);

it.effect("sweepExpired at an earlier `now` leaves a not-yet-expired row alone", () =>
  Effect.gen(function* () {
    yield* webSessionService.create(identity, 60);
    const deleted = yield* webSessionService.sweepExpired(new Date(Date.now() - 60_000));
    expect(deleted).toBe(0);
  }).pipe(Effect.provide(createTestLayer())),
);
