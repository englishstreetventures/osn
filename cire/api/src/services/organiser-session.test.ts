import { describe, it, expect } from "bun:test";

import { organiserSessions } from "@cire/db";
import { Effect } from "effect";

import { DbService } from "../db";
import { TestDbLayer } from "../db/test-layer";
import { effWith } from "../test-helpers";
import { organiserSessionService, OrganiserSessionInvalid } from "./organiser-session";
import type { OrganiserIdentity } from "./organiser-session";

const withDb = effWith(TestDbLayer);

const identity = (overrides: Partial<OrganiserIdentity> = {}): OrganiserIdentity => ({
  osnProfileId: "usr_organiser",
  osnSub: "pw_organiser",
  email: "organiser@example.test",
  handle: "organiser",
  displayName: "Test Organiser",
  avatarUrl: "https://cdn.test.invalid/a.png",
  ...overrides,
});

describe("organiserSessionService.create", () => {
  it(
    "issues a token that validates back to the identity it was minted from",
    withDb(
      Effect.gen(function* () {
        const created = yield* organiserSessionService.create(identity());
        const session = yield* organiserSessionService.validate(created.token);
        expect(session.osnProfileId).toBe("usr_organiser");
        expect(session.osnSub).toBe("pw_organiser");
        expect(session.email).toBe("organiser@example.test");
        expect(session.handle).toBe("organiser");
        expect(session.displayName).toBe("Test Organiser");
        expect(session.avatarUrl).toBe("https://cdn.test.invalid/a.png");
        // The column is second-precision, so the round trip drops milliseconds.
        expect(Math.floor(session.expiresAt.getTime() / 1000)).toBe(
          Math.floor(created.expiresAt.getTime() / 1000),
        );
      }),
    ),
  );

  it(
    "stores only the hash — a leaked table cannot be replayed as a cookie",
    withDb(
      Effect.gen(function* () {
        const db = yield* DbService;
        const created = yield* organiserSessionService.create(identity());
        const rows = yield* Effect.promise(() =>
          Promise.resolve(db.select().from(organiserSessions).all()),
        );
        expect(rows).toHaveLength(1);
        expect(rows[0]!.token).not.toBe(created.token);
        expect(rows[0]!.token).toMatch(/^[0-9a-f]{64}$/);
        expect(rows[0]!.id).toMatch(/^oss_/);
      }),
    ),
  );

  it(
    "defaults to a seven-day window",
    withDb(
      Effect.gen(function* () {
        const before = Date.now();
        const created = yield* organiserSessionService.create(identity());
        const sevenDays = 7 * 24 * 60 * 60 * 1000;
        expect(created.expiresAt.getTime()).toBeGreaterThanOrEqual(before + sevenDays);
        expect(created.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + sevenDays);
      }),
    ),
  );

  it(
    "keeps a null-claim identity as nulls rather than empty strings",
    withDb(
      Effect.gen(function* () {
        const created = yield* organiserSessionService.create(
          identity({ email: null, handle: null, displayName: null, avatarUrl: null }),
        );
        const session = yield* organiserSessionService.validate(created.token);
        expect(session.email).toBeNull();
        expect(session.handle).toBeNull();
        expect(session.displayName).toBeNull();
        expect(session.avatarUrl).toBeNull();
      }),
    ),
  );

  it(
    "mints a distinct token per sign-in so one browser's session is not another's",
    withDb(
      Effect.gen(function* () {
        const first = yield* organiserSessionService.create(identity());
        const second = yield* organiserSessionService.create(identity());
        expect(first.token).not.toBe(second.token);
        const db = yield* DbService;
        expect(db.select().from(organiserSessions).all()).toHaveLength(2);
      }),
    ),
  );
});

describe("organiserSessionService.validate", () => {
  it(
    "rejects an unknown token as missing",
    withDb(
      Effect.gen(function* () {
        const error = yield* Effect.flip(organiserSessionService.validate("nope"));
        expect(error).toBeInstanceOf(OrganiserSessionInvalid);
        expect(error.reason).toBe("missing");
      }),
    ),
  );

  it(
    "rejects an empty token as missing",
    withDb(
      Effect.gen(function* () {
        const error = yield* Effect.flip(organiserSessionService.validate(""));
        expect(error.reason).toBe("missing");
      }),
    ),
  );

  it(
    "reports an elapsed session as expired, not missing",
    withDb(
      Effect.gen(function* () {
        const created = yield* organiserSessionService.create(identity(), -1);
        const error = yield* Effect.flip(organiserSessionService.validate(created.token));
        expect(error.reason).toBe("expired");
      }),
    ),
  );
});

describe("organiserSessionService.revoke", () => {
  it(
    "makes the revoked token unusable and leaves other sessions alone",
    withDb(
      Effect.gen(function* () {
        const browser = yield* organiserSessionService.create(identity());
        const phone = yield* organiserSessionService.create(identity());
        yield* organiserSessionService.revoke(browser.token);

        const error = yield* Effect.flip(organiserSessionService.validate(browser.token));
        expect(error.reason).toBe("missing");
        const stillLive = yield* organiserSessionService.validate(phone.token);
        expect(stillLive.osnProfileId).toBe("usr_organiser");
      }),
    ),
  );

  it(
    "is a no-op for a token that was never issued",
    withDb(
      Effect.gen(function* () {
        yield* organiserSessionService.create(identity());
        yield* organiserSessionService.revoke("never-issued");
        const db = yield* DbService;
        expect(db.select().from(organiserSessions).all()).toHaveLength(1);
      }),
    ),
  );
});

describe("organiserSessionService.revokeAllForProfile", () => {
  it(
    "signs one profile out everywhere without touching another's sessions",
    withDb(
      Effect.gen(function* () {
        const browser = yield* organiserSessionService.create(identity());
        const phone = yield* organiserSessionService.create(identity());
        const other = yield* organiserSessionService.create(
          identity({ osnProfileId: "usr_other", osnSub: "pw_other" }),
        );

        yield* organiserSessionService.revokeAllForProfile("usr_organiser");

        expect((yield* Effect.flip(organiserSessionService.validate(browser.token))).reason).toBe(
          "missing",
        );
        expect((yield* Effect.flip(organiserSessionService.validate(phone.token))).reason).toBe(
          "missing",
        );
        const survivor = yield* organiserSessionService.validate(other.token);
        expect(survivor.osnProfileId).toBe("usr_other");
      }),
    ),
  );
});

describe("organiserSessionService.sweepExpired", () => {
  it(
    "deletes every elapsed row, keeps live ones, and returns the count",
    withDb(
      Effect.gen(function* () {
        const db = yield* DbService;
        yield* organiserSessionService.create(identity(), -1);
        yield* organiserSessionService.create(identity(), -1);
        const live = yield* organiserSessionService.create(identity());

        const deleted = yield* organiserSessionService.sweepExpired();
        expect(deleted).toBe(2);

        const rows = db.select().from(organiserSessions).all();
        expect(rows).toHaveLength(1);
        const survivor = yield* organiserSessionService.validate(live.token);
        expect(survivor.osnProfileId).toBe("usr_organiser");
      }),
    ),
  );

  it(
    "returns zero when nothing has elapsed",
    withDb(
      Effect.gen(function* () {
        yield* organiserSessionService.create(identity());
        expect(yield* organiserSessionService.sweepExpired()).toBe(0);
      }),
    ),
  );

  it(
    "sweeps against the clock it is handed",
    withDb(
      Effect.gen(function* () {
        const db = yield* DbService;
        const created = yield* organiserSessionService.create(identity());
        // A week and a day from now — past this session's expiry.
        const later = new Date(Date.now() + 8 * 24 * 60 * 60 * 1000);
        expect(yield* organiserSessionService.sweepExpired(later)).toBe(1);
        expect(db.select().from(organiserSessions).all()).toHaveLength(0);
        expect((yield* Effect.flip(organiserSessionService.validate(created.token))).reason).toBe(
          "missing",
        );
      }),
    ),
  );
});
