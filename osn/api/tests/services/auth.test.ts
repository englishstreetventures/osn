import { createHash } from "node:crypto";

import { it, expect, describe } from "@effect/vitest";
import { passkeys } from "@osn/db/schema";
import { Db } from "@osn/db/service";
import { EmailError, EmailService, makeLogEmailLive } from "@shared/email";
import { Deferred, Effect, Layer, Logger, References } from "effect";
import { beforeAll } from "vitest";

import { createAuthService } from "../../src/services/auth";
import { createServerMac } from "../../src/services/auth/server-mac";
import { createDefaultCeremonyStores } from "../../src/services/auth/stores";
import { makeTestAuthConfig } from "../helpers/auth-config";
import { settle } from "../helpers/background";
import { createTestLayer, createTestLayerWithSqlite } from "../helpers/db";
import { latestLinkTo, registerThroughService } from "../helpers/registration";

/**
 * Build a fresh auth service + email recorder + merged test layer.
 *
 * Usage:
 *   it.effect("...", () => {
 *     const { svc, recorded, layer } = makeAuth();
 *     return Effect.gen(function* () {
 *       yield* settle(svc.beginRegistration(...));
 *       expect(latestLinkTo(recorded(), address)).not.toBeNull();
 *     }).pipe(Effect.provide(layer));
 *   });
 */
function makeAuth() {
  const email = makeLogEmailLive();
  const svc = createAuthService(config);
  const layer = Layer.merge(createTestLayer(), email.layer);
  return { svc, recorded: () => email.recorded(), layer };
}

let config: Awaited<ReturnType<typeof makeTestAuthConfig>>;
let auth: ReturnType<typeof createAuthService>;

beforeAll(async () => {
  config = await makeTestAuthConfig();
  auth = createAuthService(config);
});

describe("registerProfile", () => {
  it.effect("creates a new user with usr_ prefix and correct fields", () =>
    Effect.gen(function* () {
      const profile = yield* auth.registerProfile("alice@example.com", "alice", "Alice");
      expect(profile.id).toMatch(/^usr_/);
      expect(profile.email).toBe("alice@example.com");
      expect(profile.handle).toBe("alice");
      expect(profile.displayName).toBe("Alice");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("creates user without displayName", () =>
    Effect.gen(function* () {
      const profile = yield* auth.registerProfile("bob@example.com", "bob");
      expect(profile.handle).toBe("bob");
      expect(profile.displayName).toBeNull();
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("fails if email already registered", () =>
    Effect.gen(function* () {
      yield* auth.registerProfile("carol@example.com", "carol");
      const error = yield* Effect.flip(auth.registerProfile("carol@example.com", "carol2"));
      expect(error._tag).toBe("AuthError");
      expect(error.message).toContain("Email already registered");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("stores and returns the email in lower case", () =>
    Effect.gen(function* () {
      const profile = yield* auth.registerProfile("Reg-Case@Example.COM", "regcase");
      expect(profile.email).toBe("reg-case@example.com");
      expect(yield* auth.findProfileByEmail("reg-case@example.com")).toMatchObject({
        id: profile.id,
        email: "reg-case@example.com",
      });
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("refuses an email that differs from a registered one only in case", () =>
    Effect.gen(function* () {
      yield* auth.registerProfile("reg-twin@example.com", "regtwin");
      const error = yield* Effect.flip(auth.registerProfile("REG-Twin@example.com", "regtwin2"));
      expect(error._tag).toBe("AuthError");
      expect(error.message).toContain("Email already registered");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("fails if handle already taken", () =>
    Effect.gen(function* () {
      yield* auth.registerProfile("dan@example.com", "dan");
      const error = yield* Effect.flip(auth.registerProfile("dan2@example.com", "dan"));
      expect(error._tag).toBe("AuthError");
      expect(error.message).toContain("Handle already taken");
    }).pipe(Effect.provide(createTestLayer())),
  );

  // The single OR-probe must preserve the email-first error priority when
  // both fields collide against two different existing accounts.
  it.effect(
    "reports the email collision when email and handle collide with different accounts",
    () =>
      Effect.gen(function* () {
        yield* auth.registerProfile("alice@example.com", "alice");
        yield* auth.registerProfile("bob@example.com", "bob");
        const error = yield* Effect.flip(auth.registerProfile("alice@example.com", "bob"));
        expect(error._tag).toBe("AuthError");
        expect(error.message).toContain("Email already registered");
      }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("fails with invalid email format", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(auth.registerProfile("not-an-email", "myhandle"));
      expect(error._tag).toBe("ValidationError");
    }).pipe(Effect.provide(createTestLayer())),
  );

  // Copenhagen Book M3: emails longer than 255 chars are rejected even when
  // they match the format regex.
  it.effect("fails with an email longer than 255 characters", () =>
    Effect.gen(function* () {
      const tooLong = `${"a".repeat(244)}@example.com`; // 256 chars total
      const error = yield* Effect.flip(auth.registerProfile(tooLong, "myhandle"));
      expect(error._tag).toBe("ValidationError");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("accepts an email of exactly 255 characters", () =>
    Effect.gen(function* () {
      const atLimit = `${"a".repeat(243)}@example.com`; // 255 chars total
      const user = yield* auth.registerProfile(atLimit, "limithandle");
      expect(user.handle).toBe("limithandle");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("fails with invalid handle format (uppercase)", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(auth.registerProfile("eve@example.com", "Eve"));
      expect(error._tag).toBe("ValidationError");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("fails with invalid handle format (too long)", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(auth.registerProfile("frank@example.com", "a".repeat(31)));
      expect(error._tag).toBe("ValidationError");
    }).pipe(Effect.provide(createTestLayer())),
  );
});

describe("checkHandle", () => {
  it.effect("returns available:true for a free handle", () =>
    Effect.gen(function* () {
      const result = yield* auth.checkHandle("freehandle");
      expect(result.available).toBe(true);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("returns available:false for a taken handle", () =>
    Effect.gen(function* () {
      yield* auth.registerProfile("grace@example.com", "grace");
      const result = yield* auth.checkHandle("grace");
      expect(result.available).toBe(false);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("returns available:false for a reserved handle", () =>
    Effect.gen(function* () {
      const result = yield* auth.checkHandle("admin");
      expect(result.available).toBe(false);
    }).pipe(Effect.provide(createTestLayer())),
  );

  // The dev sign-in provisions these two with `onConflictDoNothing`, so a
  // registration that took either first would turn the insert into a silent
  // no-op and the bypass would resolve nothing.
  it.effect("returns available:false for the dev-login principal's handles", () =>
    Effect.gen(function* () {
      for (const handle of ["dev_bootstrap", "dev_bootstrap_org"]) {
        expect((yield* auth.checkHandle(handle)).available).toBe(false);
      }
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("fails with ValidationError for invalid format", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(auth.checkHandle("INVALID!"));
      expect(error._tag).toBe("ValidationError");
    }).pipe(Effect.provide(createTestLayer())),
  );
});

// ---------------------------------------------------------------------------
// Sign-up through the emailed link: beginRegistration, the link's confirm,
// registrationStatus. The refusals over HTTP are in
// tests/routes/registration-link.test.ts; these hold what only the service
// can show — what is stored, and how a send or a database fault plays out.
// ---------------------------------------------------------------------------

describe("sign-up through the emailed link", () => {
  it.effect("creates the account for the tab that began, with a session", () => {
    const { svc, recorded, layer } = makeAuth();
    return Effect.gen(function* () {
      const result = yield* registerThroughService(
        svc,
        recorded,
        "verify@example.com",
        "verifyme",
        { displayName: "Verify Me" },
      );
      expect(result.profileId).toMatch(/^usr_/);
      expect(result.handle).toBe("verifyme");
      expect(result.email).toBe("verify@example.com");
      expect(result.displayName).toBe("Verify Me");
      expect(result.accessToken.length).toBeGreaterThan(0);
      expect(result.refreshToken.length).toBeGreaterThan(0);
      expect(result.expiresIn).toBeGreaterThan(0);

      const found = yield* svc.findProfileByEmail("verify@example.com");
      expect(found?.handle).toBe("verifyme");
      expect(found?.displayName).toBe("Verify Me");
    }).pipe(Effect.provide(layer));
  });

  it.effect("email is normalised to lowercase across the pipeline", () => {
    const { svc, recorded, layer } = makeAuth();
    return Effect.gen(function* () {
      const result = yield* registerThroughService(
        svc,
        recorded,
        "MixedCase@Example.com",
        "mixedcase",
      );
      expect(result.email).toBe("mixedcase@example.com");
      const a = yield* svc.findProfileByEmail("mixedcase@example.com");
      expect(a?.id).toBe(result.profileId);
    }).pipe(Effect.provide(layer));
  });

  it.effect("does not create the user before the link is confirmed and claimed", () => {
    const { svc, recorded, layer } = makeAuth();
    return Effect.gen(function* () {
      const begun = yield* settle(
        svc.beginRegistration("pending@example.com", "pendinguser", "1990-01-01"),
      );
      const link = latestLinkTo(recorded(), "pending@example.com")!;
      yield* svc.confirmEmailLink(link.requestId, {
        linkSecret: link.linkSecret,
        pairingPick: begun.pairingCode,
      });

      expect(yield* svc.findProfileByEmail("pending@example.com")).toBeNull();
      expect((yield* svc.checkHandle("pendinguser")).available).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.effect("rejects begin with ValidationError on bad email", () => {
    const { svc, layer } = makeAuth();
    return Effect.gen(function* () {
      const error = yield* Effect.flip(
        svc.beginRegistration("not-an-email", "okhandle", "1990-01-01"),
      );
      expect(error._tag).toBe("ValidationError");
    }).pipe(Effect.provide(layer));
  });

  it.effect("rejects begin with ValidationError on bad handle format", () => {
    const { svc, layer } = makeAuth();
    return Effect.gen(function* () {
      const error = yield* Effect.flip(
        svc.beginRegistration("ok@example.com", "Bad Handle!", "1990-01-01"),
      );
      expect(error._tag).toBe("ValidationError");
    }).pipe(Effect.provide(layer));
  });

  it.effect("rejects begin with AuthError on a reserved handle", () => {
    const { svc, layer } = makeAuth();
    return Effect.gen(function* () {
      const error = yield* Effect.flip(
        svc.beginRegistration("ok@example.com", "admin", "1990-01-01"),
      );
      expect(error._tag).toBe("AuthError");
      expect(error.message).toContain("reserved");
    }).pipe(Effect.provide(layer));
  });

  it.effect("COPPA: begin rejects an under-13 birthdate with AgeRestrictionError", () => {
    const { svc, recorded, layer } = makeAuth();
    return Effect.gen(function* () {
      // Ten years ago today — comfortably under 13.
      const tenYearsAgo = new Date();
      tenYearsAgo.setUTCFullYear(tenYearsAgo.getUTCFullYear() - 10);
      const dob = tenYearsAgo.toISOString().slice(0, 10);
      const error = yield* Effect.flip(
        svc.beginRegistration("child@example.com", "childuser", dob),
      );
      expect(error._tag).toBe("AgeRestrictionError");
      // No link is sent and no personal information is collected.
      expect(recorded()).toEqual([]);
      const found = yield* svc.findProfileByEmail("child@example.com");
      expect(found).toBeNull();
    }).pipe(Effect.provide(layer));
  });

  it.effect("COPPA: begin accepts a birthdate exactly on the 13th birthday", () => {
    const { svc, recorded, layer } = makeAuth();
    return Effect.gen(function* () {
      const thirteenToday = new Date();
      thirteenToday.setUTCFullYear(thirteenToday.getUTCFullYear() - 13);
      const dob = thirteenToday.toISOString().slice(0, 10);
      const result = yield* settle(svc.beginRegistration("teen@example.com", "teenuser", dob));
      expect(result.requestId).toMatch(/^signup_/);
      expect(latestLinkTo(recorded(), "teen@example.com")).not.toBeNull();
    }).pipe(Effect.provide(layer));
  });

  it.effect("COPPA: rejects when the 13th birthday has not yet occurred this year", () => {
    const { svc, recorded, layer } = makeAuth();
    return Effect.gen(function* () {
      // Born ~13 years ago but the birthday is still ~2 days away ⇒ age 12.
      // Exercises the `monthDelta < 0 || day-not-reached` branch of ageInYears.
      const d = new Date();
      d.setUTCFullYear(d.getUTCFullYear() - 13);
      d.setUTCDate(d.getUTCDate() + 2);
      const dob = d.toISOString().slice(0, 10);
      const error = yield* Effect.flip(
        svc.beginRegistration("almost13@example.com", "almost13", dob),
      );
      expect(error._tag).toBe("AgeRestrictionError");
      expect(recorded()).toEqual([]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("COPPA: begin rejects a malformed birthdate with ValidationError", () => {
    const { svc, layer } = makeAuth();
    return Effect.gen(function* () {
      const error = yield* Effect.flip(
        svc.beginRegistration("bad@example.com", "baddob", "2021-02-30"),
      );
      expect(error._tag).toBe("ValidationError");
    }).pipe(Effect.provide(layer));
  });

  it.effect("begin mails nothing when the handle is already taken", () => {
    const { svc, recorded, layer } = makeAuth();
    return Effect.gen(function* () {
      yield* svc.registerProfile("first@example.com", "duphandle");
      const result = yield* settle(
        svc.beginRegistration("second@example.com", "duphandle", "1990-01-01"),
      );
      expect(result.requestId).toMatch(/^signup_/);
      expect(recorded()).toEqual([]);
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "a second begin for a live sign-up mails nothing, and the first link still finishes it",
    () => {
      const { svc, recorded, layer } = makeAuth();
      return Effect.gen(function* () {
        const first = yield* settle(
          svc.beginRegistration("dup@example.com", "dupuser", "1990-01-01"),
        );
        const link = latestLinkTo(recorded(), "dup@example.com")!;
        yield* settle(svc.beginRegistration("dup@example.com", "differenthandle", "1990-01-01"));
        expect(recorded()).toHaveLength(1);

        yield* svc.confirmEmailLink(link.requestId, {
          linkSecret: link.linkSecret,
          pairingPick: first.pairingCode,
        });
        const done = yield* settle(svc.registrationStatus(first.requestId, first.claimSecret));
        expect(done.status === "complete" && done.handle).toBe("dupuser");
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("stores no pairing number and no candidates: only a keyed digest of the number", () => {
    const stores = createDefaultCeremonyStores();
    const svc = createAuthService({ ...config, ceremonyStores: stores });
    const email = makeLogEmailLive();
    return Effect.gen(function* () {
      const begun = yield* settle(
        svc.beginRegistration("stored@example.com", "storeduser", "1990-01-01"),
      );
      const entry = yield* Effect.promise(() => stores.emailLinks.get(begun.requestId));
      expect(Object.keys(entry!).toSorted()).toEqual(
        [
          "claimSecretHash",
          "expiresAt",
          "flow",
          "mailSecretHashes",
          "pairingHash",
          "signUp",
          "status",
          "subject",
          "v",
        ].toSorted(),
      );
      // The sign-up it parks, so it can park later; never the birthdate.
      expect(entry!.signUp).toEqual({
        email: "stored@example.com",
        handle: "storeduser",
        displayName: null,
      });
      const stored = JSON.stringify(entry);
      expect(stored).not.toContain("1990");
      const serverMac = createServerMac(config.sessionIpPepper);
      for (const candidate of serverMac.pairingCandidates(begun.requestId, 5)) {
        expect(stored).not.toContain(`"${candidate}"`);
      }
      expect(stored).not.toContain(`"${begun.pairingCode}"`);
      expect(entry!.pairingHash).toMatch(/^[a-f0-9]{64}$/);
      const unkeyed = (value: string) => createHash("sha256").update(value).digest("hex");
      expect(entry!.pairingHash).not.toBe(unkeyed(`${begun.requestId}\0${begun.pairingCode}`));
      expect(entry!.pairingHash).not.toBe(unkeyed(begun.pairingCode));
      expect(stored).not.toContain(begun.claimSecret);
    }).pipe(Effect.provide(Layer.merge(createTestLayer(), email.layer)));
  });

  it.effect("refuses a stored request that carries no pairing digest", () => {
    const stores = createDefaultCeremonyStores();
    const svc = createAuthService({ ...config, ceremonyStores: stores });
    const email = makeLogEmailLive();
    return Effect.gen(function* () {
      const begun = yield* settle(
        svc.beginRegistration("nodigest@example.com", "nodigest", "1990-01-01"),
      );
      const link = latestLinkTo(email.recorded(), "nodigest@example.com")!;
      const entry = (yield* Effect.promise(() => stores.emailLinks.get(begun.requestId)))!;
      const { pairingHash: _dropped, ...withoutDigest } = entry;
      yield* Effect.promise(() =>
        stores.emailLinks.set(begun.requestId, withoutDigest as typeof entry, 600_000),
      );

      const answer = yield* svc.confirmEmailLink(link.requestId, {
        linkSecret: link.linkSecret,
        pairingPick: begun.pairingCode,
      });
      expect(answer).toBe("expired");
    }).pipe(Effect.provide(Layer.merge(createTestLayer(), email.layer)));
  });

  it.effect("a handle taken while the person waited answers conflict and frees the address", () => {
    const stores = createDefaultCeremonyStores();
    const svc = createAuthService({ ...config, ceremonyStores: stores });
    const email = makeLogEmailLive();
    return Effect.gen(function* () {
      const begun = yield* settle(
        svc.beginRegistration("toctou@example.com", "toctouuser", "1990-01-01"),
      );
      const link = latestLinkTo(email.recorded(), "toctou@example.com")!;
      yield* svc.confirmEmailLink(link.requestId, {
        linkSecret: link.linkSecret,
        pairingPick: begun.pairingCode,
      });
      yield* svc.registerProfile("someone-else@example.com", "toctouuser");

      const done = yield* settle(svc.registrationStatus(begun.requestId, begun.claimSecret));
      expect(done).toEqual({ status: "conflict" });
      // The pending entry is gone, so the address can take a new sign-up.
      expect(
        yield* Effect.promise(() => stores.pendingRegistrations.get("toctou@example.com")),
      ).toBeNull();
      // The request is over, and the account that took the handle is untouched.
      expect(yield* settle(svc.registrationStatus(begun.requestId, begun.claimSecret))).toEqual({
        status: "expired",
      });
      expect(yield* svc.findProfileByEmail("toctou@example.com")).toBeNull();
      expect((yield* svc.findProfileByHandle("toctouuser"))?.email).toBe(
        "someone-else@example.com",
      );
    }).pipe(Effect.provide(Layer.merge(createTestLayer(), email.layer)));
  });

  // A non-uniqueness constraint failure at the write must surface as
  // DatabaseError, never be folded into the conflict a genuine duplicate
  // answers. The insert's foreign keys are consistent by construction, so a
  // trigger stands in for "some other constraint failed", raising a
  // constraint-worded message that does not contain "UNIQUE". It refuses the
  // first statement, as D1 refuses the whole batch: bun:sqlite runs the two
  // inserts one after the other, with no batch to undo the first. The request
  // stays claimed, and the next poll inserts with the same ids and finishes.
  it.effect(
    "a database fault after the claim answers DatabaseError, and the next poll finishes",
    () => {
      const email = makeLogEmailLive();
      const { layer: dbLayer, sqlite } = createTestLayerWithSqlite();
      const layer = Layer.merge(dbLayer, email.layer);
      const svc = createAuthService(config);
      return Effect.gen(function* () {
        const begun = yield* settle(
          svc.beginRegistration("regfault@example.com", "regfaultuser", "1990-01-01"),
        );
        const link = latestLinkTo(email.recorded(), "regfault@example.com")!;
        yield* svc.confirmEmailLink(link.requestId, {
          linkSecret: link.linkSecret,
          pairingPick: begun.pairingCode,
        });
        sqlite.run(`
        CREATE TRIGGER reject_accounts_insert_regfault BEFORE INSERT ON accounts
        BEGIN SELECT RAISE(ABORT, 'CHECK constraint failed: accounts'); END;
      `);
        const err = yield* Effect.flip(
          settle(svc.registrationStatus(begun.requestId, begun.claimSecret)),
        );
        expect(err._tag).toBe("DatabaseError");

        sqlite.run("DROP TRIGGER reject_accounts_insert_regfault");
        const done = yield* settle(svc.registrationStatus(begun.requestId, begun.claimSecret));
        expect(done.status === "complete" && done.handle).toBe("regfaultuser");
      }).pipe(Effect.provide(layer));
    },
  );

  // The address is free, so this begin is the one that mails a link; it
  // answers before the send does, as the taken and pending branches answer
  // without one. A begin that waited would answer later for a free address
  // than for a taken one.
  it.live("a free address is answered without waiting on the send", () => {
    const svc = createAuthService({ ...config, ceremonyStores: createDefaultCeremonyStores() });
    return Effect.gen(function* () {
      const sending = yield* Deferred.make<void>();
      const hangingEmailLayer = Layer.succeed(EmailService, {
        send: () => Deferred.succeed(sending, undefined).pipe(Effect.andThen(Effect.never)),
      });
      const answer = yield* svc
        .beginRegistration("quick@example.com", "quickmail", "1990-01-01")
        .pipe(
          Effect.provide(Layer.merge(createTestLayer(), hangingEmailLayer)),
          Effect.timeout("2 seconds"),
        );
      expect(answer.requestId).toMatch(/^signup_/);
      yield* Deferred.await(sending).pipe(Effect.timeout("2 seconds"));
    });
  });

  // A refused send leaves the request live: the tab's Resend on the same
  // request is the retry, and its link confirms.
  it.effect("a refused send leaves the request live, and a Resend's link finishes it", () => {
    let refuseNext = true;
    const email = makeLogEmailLive();
    const refusingOnce = Layer.succeed(EmailService, {
      send: (input) =>
        refuseNext
          ? Effect.sync(() => (refuseNext = false)).pipe(
              Effect.andThen(
                Effect.fail(new EmailError({ reason: "dispatch_failed", cause: 403 })),
              ),
            )
          : Effect.gen(function* () {
              const svc = yield* EmailService;
              return yield* svc.send(input);
            }).pipe(Effect.provide(email.layer)),
    });
    const svc = createAuthService(config);
    return Effect.gen(function* () {
      const begun = yield* settle(
        svc.beginRegistration("refused@example.com", "refused", "1990-01-01"),
      );
      expect(email.recorded()).toEqual([]);
      expect(yield* settle(svc.resendRegistration(begun.requestId, begun.claimSecret))).toEqual({
        status: "sent",
      });
      const link = latestLinkTo(email.recorded(), "refused@example.com")!;
      yield* svc.confirmEmailLink(link.requestId, {
        linkSecret: link.linkSecret,
        pairingPick: begun.pairingCode,
      });
      const done = yield* settle(svc.registrationStatus(begun.requestId, begun.claimSecret));
      expect(done.status).toBe("complete");
    }).pipe(Effect.provide(Layer.merge(createTestLayer(), refusingOnce)));
  });
});

describe("findProfileByEmail + findProfileByHandle", () => {
  it.effect("returns null when user does not exist", () =>
    Effect.gen(function* () {
      const byEmail = yield* auth.findProfileByEmail("nobody@example.com");
      const byHandle = yield* auth.findProfileByHandle("nobody");
      expect(byEmail).toBeNull();
      expect(byHandle).toBeNull();
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("finds user by email and by handle", () =>
    Effect.gen(function* () {
      yield* auth.registerProfile("heidi@example.com", "heidi");
      const byEmail = yield* auth.findProfileByEmail("heidi@example.com");
      const byHandle = yield* auth.findProfileByHandle("heidi");
      expect(byEmail).not.toBeNull();
      expect(byHandle).not.toBeNull();
      expect(byEmail!.id).toBe(byHandle!.id);
    }).pipe(Effect.provide(createTestLayer())),
  );
});

describe("issueTokens", () => {
  it.effect("issueTokens returns access + refresh tokens with handle in payload", () =>
    Effect.gen(function* () {
      const profile = yield* auth.registerProfile("ivan@example.com", "ivan", "Ivan");
      const tokens = yield* auth.issueTokens(
        profile.id,
        profile.accountId,
        profile.email,
        profile.handle,
        profile.displayName,
      );
      expect(tokens.accessToken).toBeTruthy();
      expect(tokens.refreshToken).toBeTruthy();
      expect(tokens.expiresIn).toBe(300);

      // Verify claims include handle and displayName
      const claims = yield* auth.verifyAccessToken(tokens.accessToken);
      expect(claims.handle).toBe("ivan");
      expect(claims.displayName).toBe("Ivan");
    }).pipe(Effect.provide(createTestLayer())),
  );
});

// ---------------------------------------------------------------------------
// Issuer pinning + clock tolerance on access tokens
// ---------------------------------------------------------------------------
describe("issuer pinning + clock tolerance", () => {
  it.effect("access tokens decode with iss === issuerUrl", () =>
    Effect.gen(function* () {
      const profile = yield* auth.registerProfile("iss-ok@example.com", "issok");
      const tokens = yield* auth.issueTokens(
        profile.id,
        profile.accountId,
        profile.email,
        profile.handle,
        profile.displayName,
      );
      const { decodeJwt } = yield* Effect.tryPromise(() => import("jose"));
      expect(decodeJwt(tokens.accessToken).iss).toBe(config.issuerUrl);
      // And it still verifies through the service.
      const claims = yield* auth.verifyAccessToken(tokens.accessToken);
      expect(claims.handle).toBe("issok");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("a token with a wrong iss is rejected", () =>
    Effect.gen(function* () {
      const profile = yield* auth.registerProfile("iss-wrong@example.com", "isswrong");
      const { SignJWT } = yield* Effect.tryPromise(() => import("jose"));
      const wrongIss = yield* Effect.tryPromise(() =>
        new SignJWT({
          sub: profile.id,
          aud: "osn-access",
          email: profile.email,
          handle: profile.handle,
        })
          .setProtectedHeader({ alg: "ES256", kid: config.jwtKid })
          .setIssuedAt()
          .setIssuer("https://evil.example.com")
          .setExpirationTime(Math.floor(Date.now() / 1000) + 300)
          .sign(config.jwtPrivateKey),
      );
      const error = yield* Effect.flip(auth.verifyAccessToken(wrongIss));
      expect(error._tag).toBe("AuthError");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("a token ~20s in the future verifies; ~90s does not (30s tolerance)", () =>
    Effect.gen(function* () {
      const profile = yield* auth.registerProfile("iss-skew@example.com", "issskew");
      const { SignJWT } = yield* Effect.tryPromise(() => import("jose"));
      const nowSec = Math.floor(Date.now() / 1000);
      // Use `nbf` (not-before) to model a token minted on a clock running
      // fast: jose applies `clockTolerance` to the nbf check, so an nbf 20s in
      // the future is tolerated while 90s is not.
      const mint = (nbfOffset: number) =>
        Effect.tryPromise(() =>
          new SignJWT({
            sub: profile.id,
            aud: "osn-access",
            email: profile.email,
            handle: profile.handle,
          })
            .setProtectedHeader({ alg: "ES256", kid: config.jwtKid })
            .setIssuedAt(nowSec)
            .setNotBefore(nowSec + nbfOffset)
            .setIssuer(config.issuerUrl)
            .setExpirationTime(nowSec + nbfOffset + 300)
            .sign(config.jwtPrivateKey),
        );

      // nbf 20s in the future → inside the 30s clockTolerance → accepted.
      const near = yield* mint(20);
      const nearClaims = yield* auth.verifyAccessToken(near);
      expect(nearClaims.handle).toBe("issskew");

      // nbf 90s in the future → outside tolerance → "not yet valid" → rejected.
      const far = yield* mint(90);
      const error = yield* Effect.flip(auth.verifyAccessToken(far));
      expect(error._tag).toBe("AuthError");
    }).pipe(Effect.provide(createTestLayer())),
  );
});

describe("passkey registration", () => {
  it.effect("beginPasskeyRegistration returns options with @handle as userName", () =>
    Effect.gen(function* () {
      const profile = yield* auth.registerProfile("passkey@example.com", "passkeyuser");
      const result = yield* auth.beginPasskeyRegistration(profile.accountId);
      expect(result.options).toBeTruthy();
      expect(result.options.challenge).toBeTruthy();
      expect(result.options.user.name).toBe("@passkeyuser");
      // WebAuthn userID must be passkeyUserId (UUID), never accountId
      const decoded = new TextDecoder().decode(
        Uint8Array.from(atob(result.options.user.id), (c) => c.charCodeAt(0)),
      );
      expect(decoded).not.toBe(profile.accountId);
      expect(decoded).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    }).pipe(Effect.provide(createTestLayer())),
  );

  // Pins the WebAuthn-option posture (M-PK):
  //   • `residentKey: "preferred"` — FIDO2 security keys without a resident-
  //     key slot still register (as non-discoverable), so identified login
  //     works for them.
  //   • `userVerification: "required"` — must match the verifier (which
  //     sets `requireUserVerification: true`). Obsolete UP-only U2F tokens
  //     cannot register, which is intentional — they would fail at
  //     verification time anyway.
  it.effect("beginPasskeyRegistration uses residentKey 'preferred' + UV 'required'", () =>
    Effect.gen(function* () {
      const profile = yield* auth.registerProfile("pk-opts@example.com", "pkopts");
      const result = yield* auth.beginPasskeyRegistration(profile.accountId);
      expect(result.options.authenticatorSelection).toMatchObject({
        residentKey: "preferred",
        userVerification: "required",
      });
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("beginPasskeyRegistration fails for an unknown accountId", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(auth.beginPasskeyRegistration("acc_nonexistent"));
      expect(error._tag).toBe("AuthError");
    }).pipe(Effect.provide(createTestLayer())),
  );
});

describe("passkey login", () => {
  // Single-use challenge invariant: verifyPasskeyAssertion gates on the
  // in-memory `loginChallenges` entry BEFORE any DB work. Without a fresh
  // beginPasskeyLogin to populate it, complete must fail — which is the
  // same guard that prevents a captured assertion from being replayed
  // after the legitimate call has consumed its challenge.
  it.effect("completePasskeyLoginDirect rejects when no login challenge is live", () =>
    Effect.gen(function* () {
      yield* auth.registerProfile("pk-replay@example.com", "pkreplay");

      const bogusAssertion = {
        id: "x",
        rawId: "x",
        response: {},
        type: "public-key",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test shim; real AuthenticationResponseJSON is exhaustive
      } as any;

      // No beginPasskeyLogin call — the challenge guard must be the first
      // failure point, not the passkey DB lookup.
      const error = yield* Effect.flip(
        auth.completePasskeyLoginDirect({
          identifier: "pk-replay@example.com",
          assertion: bogusAssertion,
        }),
      );
      expect(error._tag).toBe("AuthError");
      expect(error.message).toContain("Challenge");
    }).pipe(Effect.provide(createTestLayer())),
  );

  // Discoverable flow — beginPasskeyLogin(null) must return options plus a
  // server-minted challengeId. The identifier-less path is how
  // conditional-UI autofill drives sign-in.
  it.effect("beginPasskeyLogin(null) returns options and the challenge as its id", () =>
    Effect.gen(function* () {
      const result = yield* auth.beginPasskeyLogin(null);
      expect(result.options.challenge).toBeTruthy();
      // The challenge proves itself (nonce, expiry, MAC: 56 bytes, base64url),
      // so the id the client round-trips is the challenge.
      expect(result.challengeId).toBe(result.options.challenge);
      expect(result.challengeId).toMatch(/^[A-Za-z0-9_-]{75}$/);
    }).pipe(Effect.provide(createTestLayer())),
  );

  // Pins the asymmetry the service comments rely on: identifier-less login
  // enforces UV (the whole ceremony's correctness depends on it without a
  // claimed identity), identified login accepts UP-only (FIDO2 keys without
  // a PIN still work because the identifier binds the assertion).
  it.effect("beginPasskeyLogin(null) keeps userVerification 'required'", () =>
    Effect.gen(function* () {
      const result = yield* auth.beginPasskeyLogin(null);
      expect(result.options.userVerification).toBe("required");
    }).pipe(Effect.provide(createTestLayer())),
  );

  // Identified login must match the verifier (`requireUserVerification:
  // true`), so options sets `userVerification: "required"`. The
  // identifier-less flow above is identical — the two must not diverge.
  it.effect("beginPasskeyLogin(identifier) uses userVerification 'required'", () =>
    Effect.gen(function* () {
      const profile = yield* auth.registerProfile("pk-login-opts@example.com", "pkloginopts");
      const { db } = yield* Db;
      yield* Effect.tryPromise(() =>
        db.insert(passkeys).values({
          id: "pk_aaaaaaaaaaaa",
          accountId: profile.accountId,
          credentialId: "cred-login-opts",
          publicKey: "AAAA",
          counter: 0,
          transports: null,
          createdAt: new Date(),
          label: null,
          lastUsedAt: null,
          aaguid: null,
          backupEligible: false,
          backupState: false,
          updatedAt: null,
        }),
      );
      const result = yield* auth.beginPasskeyLogin("pk-login-opts@example.com");
      expect(result.options.userVerification).toBe("required");
    }).pipe(Effect.provide(createTestLayer())),
  );

  // The challengeId variant of completePasskeyLoginDirect must apply the
  // same challenge guard as the identified flow — an unknown id fails
  // fast, before any DB / credential lookup.
  it.effect("completePasskeyLoginDirect rejects an unknown challengeId before DB work", () =>
    Effect.gen(function* () {
      const bogusAssertion = {
        id: "x",
        rawId: "x",
        response: {},
        type: "public-key",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test shim
      } as any;
      const error = yield* Effect.flip(
        auth.completePasskeyLoginDirect({
          challengeId: "00000000-0000-0000-0000-000000000000",
          assertion: bogusAssertion,
        }),
      );
      expect(error._tag).toBe("AuthError");
      expect(error.message).toContain("Challenge");
    }).pipe(Effect.provide(createTestLayer())),
  );
});

describe("token refresh", () => {
  it.effect("refreshTokens issues new tokens from a valid refresh token", () =>
    Effect.gen(function* () {
      const profile = yield* auth.registerProfile("quinn@example.com", "quinn");
      const tokens = yield* auth.issueTokens(
        profile.id,
        profile.accountId,
        profile.email,
        profile.handle,
        profile.displayName,
      );
      const refreshed = yield* auth.refreshTokens(tokens.refreshToken);
      expect(refreshed.accessToken).toBeTruthy();
      expect(refreshed.expiresIn).toBe(300);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("refreshTokens fails with an invalid token", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(auth.refreshTokens("not.a.token"));
      expect(error._tag).toBe("AuthError");
    }).pipe(Effect.provide(createTestLayer())),
  );
});

describe("verifyAccessToken", () => {
  it.effect("verifies a valid access token and returns all claims", () =>
    Effect.gen(function* () {
      const profile = yield* auth.registerProfile("rose@example.com", "rose", "Rose");
      const tokens = yield* auth.issueTokens(
        profile.id,
        profile.accountId,
        profile.email,
        profile.handle,
        profile.displayName,
      );
      const claims = yield* auth.verifyAccessToken(tokens.accessToken);
      expect(claims.profileId).toBe(profile.id);
      expect(claims.email).toBe("rose@example.com");
      expect(claims.handle).toBe("rose");
      expect(claims.displayName).toBe("Rose");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("displayName is null when not set", () =>
    Effect.gen(function* () {
      const profile = yield* auth.registerProfile("sam@example.com", "sam");
      const tokens = yield* auth.issueTokens(
        profile.id,
        profile.accountId,
        profile.email,
        profile.handle,
        profile.displayName,
      );
      const claims = yield* auth.verifyAccessToken(tokens.accessToken);
      expect(claims.displayName).toBeNull();
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("fails on a tampered token", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(auth.verifyAccessToken("not.a.token"));
      expect(error._tag).toBe("AuthError");
    }).pipe(Effect.provide(createTestLayer())),
  );

  // Regression pin: a JWT signed with the same key but lacking the
  // `aud: "osn-access"` claim (e.g. a step-up token or any future token
  // type) must not authenticate access-token routes.
  it.effect("rejects a token without aud: 'osn-access'", () =>
    Effect.gen(function* () {
      const { SignJWT } = yield* Effect.tryPromise(() => import("jose"));
      // Carry the correct `iss` so the token passes the issuer check and
      // actually reaches the aud-pinning branch this test is pinning. (A
      // missing/wrong `iss` is rejected earlier — separately covered below.)
      const forged = yield* Effect.tryPromise(() =>
        new SignJWT({ sub: "usr_forged00000", email: "x@x.com", handle: "x" })
          .setProtectedHeader({ alg: "ES256", kid: config.jwtKid })
          .setIssuedAt()
          .setIssuer(config.issuerUrl)
          .setExpirationTime(Math.floor(Date.now() / 1000) + 300)
          .sign(config.jwtPrivateKey),
      );
      const error = yield* Effect.flip(auth.verifyAccessToken(forged));
      expect(error._tag).toBe("AuthError");
      expect(error.message).toContain("Invalid token claims");
    }).pipe(Effect.provide(createTestLayer())),
  );

  // jose checks `exp` only when the claim is present, so a token minted
  // without one would authenticate for as long as the signing key lives —
  // no expiry, and nothing else in the verifier looks at token age.
  // `requiredClaims: ["exp"]` is what makes this a rejection.
  it.effect("rejects a token with no exp claim", () =>
    Effect.gen(function* () {
      const { SignJWT } = yield* Effect.tryPromise(() => import("jose"));
      const everlasting = yield* Effect.tryPromise(() =>
        new SignJWT({ sub: "usr_forged00000", email: "x@x.com", handle: "x", aud: "osn-access" })
          .setProtectedHeader({ alg: "ES256", kid: config.jwtKid })
          .setIssuedAt()
          .setIssuer(config.issuerUrl)
          .sign(config.jwtPrivateKey),
      );
      const error = yield* Effect.flip(auth.verifyAccessToken(everlasting));
      expect(error._tag).toBe("AuthError");
      expect(error.message).toContain("Invalid or expired access token");
    }).pipe(Effect.provide(createTestLayer())),
  );
});

// ---------------------------------------------------------------------------
// Local-mode LogEmailLive behaviour (replaces the old in-auth.ts debug log)
// ---------------------------------------------------------------------------
// The EmailService layer decides whether to actually dispatch or just log.
// In local dev + tests we provide `LogEmailLive`, which:
//
//   1. Emits a single `Effect.logDebug` line with `template`, `subject`, `to`
//      — no OTP code in the log message.
//   2. Records the full rendered payload (including the code) into an
//      in-memory ring buffer readable via `recorded()` — that's how test
//      helpers extract the code without relying on log parsing.
//   3. Never emits "[REDACTED]" — defence against a future PR that
//      accidentally annotates `Effect.annotateLogs({ code })`.
// ---------------------------------------------------------------------------

describe("LogEmailLive local-mode behaviour", () => {
  /**
   * Install a capture logger in place of Effect's default, returning an
   * array that will be populated with every emitted message string.
   */
  function captureLogs() {
    const captured: string[] = [];
    const sinkLogger = Logger.make<unknown, void>((options) => {
      const msg = Array.isArray(options.message)
        ? options.message.join(" ")
        : String(options.message);
      captured.push(msg);
    });
    const loggerLayer = Logger.layer([sinkLogger]);
    return { captured, loggerLayer };
  }

  it.effect("beginRegistration logs template+subject+to, and records the rendered body", () => {
    const { svc, recorded, layer } = makeAuth();
    const { captured: logLines, loggerLayer } = captureLogs();
    return Effect.gen(function* () {
      yield* settle(
        svc
          .beginRegistration("dev@example.com", "devuser", "1990-01-01", "Dev User")
          .pipe(
            Effect.provide(loggerLayer),
            Effect.provideService(References.MinimumLogLevel, "Debug"),
          ),
      );

      // Log line: template + subject + to, and nothing of the link.
      const emailLogs = logLines.filter((l) => l.includes("[email:log]"));
      expect(emailLogs.length).toBe(1);
      expect(emailLogs[0]).toContain("template=link-registration");
      expect(emailLogs[0]).toContain('subject="Confirm your Musubi email"');
      expect(emailLogs[0]).toContain("to=dev@example.com");
      expect(emailLogs[0]).not.toContain("/verify/");
      expect(emailLogs[0]).not.toMatch(/[a-f0-9]{64}/); // no link secret
      expect(emailLogs[0]).not.toContain("[REDACTED]");

      // Recorder has the link for test-side replay.
      expect(latestLinkTo(recorded(), "dev@example.com")).not.toBeNull();
    }).pipe(Effect.provide(layer));
  });
});

// ---------------------------------------------------------------------------
// Two-tier token model
// ---------------------------------------------------------------------------

describe("two-tier token model", () => {
  it.effect("verifyRefreshToken resolves the accountId from a session token", () =>
    Effect.gen(function* () {
      const profile = yield* auth.registerProfile("tier@example.com", "tier", "Tier");
      const tokens = yield* auth.issueTokens(
        profile.id,
        profile.accountId,
        profile.email,
        profile.handle,
        profile.displayName,
      );
      // Session token (opaque) should resolve to the correct accountId
      const { accountId } = yield* auth.verifyRefreshToken(tokens.refreshToken);
      expect(accountId).toBe(profile.accountId);
      // Access token sub should still be profileId
      const claims = yield* auth.verifyAccessToken(tokens.accessToken);
      expect(claims.profileId).toBe(profile.id);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("session token is opaque with ses_ prefix", () =>
    Effect.gen(function* () {
      const profile = yield* auth.registerProfile("sesprefix@example.com", "sesprefix");
      const tokens = yield* auth.issueTokens(
        profile.id,
        profile.accountId,
        profile.email,
        profile.handle,
        profile.displayName,
      );
      expect(tokens.refreshToken).toMatch(/^ses_[0-9a-f]{40}$/);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("refreshTokens resolves the default profile from account-scoped session token", () =>
    Effect.gen(function* () {
      const profile = yield* auth.registerProfile("refresh2@example.com", "refresh2");
      const tokens = yield* auth.issueTokens(
        profile.id,
        profile.accountId,
        profile.email,
        profile.handle,
        profile.displayName,
      );
      const refreshed = yield* auth.refreshTokens(tokens.refreshToken);
      const claims = yield* auth.verifyAccessToken(refreshed.accessToken);
      expect(claims.profileId).toBe(profile.id);
      expect(claims.handle).toBe("refresh2");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("C2: refreshTokens rotates the session token (returns a new one)", () =>
    Effect.gen(function* () {
      const profile = yield* auth.registerProfile("sametoken@example.com", "sametoken");
      const tokens = yield* auth.issueTokens(
        profile.id,
        profile.accountId,
        profile.email,
        profile.handle,
        profile.displayName,
      );
      const refreshed = yield* auth.refreshTokens(tokens.refreshToken);
      // New token must be different from the original
      expect(refreshed.refreshToken).not.toBe(tokens.refreshToken);
      expect(refreshed.refreshToken).toMatch(/^ses_[0-9a-f]{40}$/);
      // New token must be valid
      const { accountId } = yield* auth.verifyRefreshToken(refreshed.refreshToken);
      expect(accountId).toBe(profile.accountId);
      // Old token must be invalid (rotated out)
      const err = yield* Effect.flip(auth.verifyRefreshToken(tokens.refreshToken));
      expect(err._tag).toBe("AuthError");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("findDefaultProfile returns the default profile for an account", () =>
    Effect.gen(function* () {
      const profile = yield* auth.registerProfile("default@example.com", "defaultp");
      const found = yield* auth.findDefaultProfile(profile.accountId);
      expect(found).not.toBeNull();
      expect(found!.id).toBe(profile.id);
      expect(found!.isDefault).toBe(true);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("findDefaultProfile returns null for a nonexistent account", () =>
    Effect.gen(function* () {
      const found = yield* auth.findDefaultProfile("acc_nonexistent");
      expect(found).toBeNull();
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("rejects a random string used as a session token", () =>
    Effect.gen(function* () {
      const profile = yield* auth.registerProfile("typemix@example.com", "typemix");
      const tokens = yield* auth.issueTokens(
        profile.id,
        profile.accountId,
        profile.email,
        profile.handle,
        profile.displayName,
      );
      // An access token (JWT) is not a valid session token — must be rejected
      const err = yield* Effect.flip(auth.verifyRefreshToken(tokens.accessToken));
      expect(err._tag).toBe("AuthError");
      expect(err.message).toContain("Invalid or expired session");
    }).pipe(Effect.provide(createTestLayer())),
  );
});

// ---------------------------------------------------------------------------
// Profile switching
// ---------------------------------------------------------------------------

describe("switchProfile", () => {
  /** A session on the profile's account: the hash the route's gate resolves. */
  const sessionOf = (profile: {
    id: string;
    accountId: string;
    email: string;
    handle: string;
    displayName: string | null;
  }) =>
    auth
      .issueTokens(
        profile.id,
        profile.accountId,
        profile.email,
        profile.handle,
        profile.displayName,
      )
      .pipe(Effect.map((t) => auth.hashSessionToken(t.refreshToken)));

  it.effect("issues new access token for target profile", () =>
    Effect.gen(function* () {
      const profile = yield* auth.registerProfile("switch@example.com", "switchme");
      // Switch to self (same profile) — should work fine
      const result = yield* auth.switchProfile(
        profile.accountId,
        profile.id,
        yield* sessionOf(profile),
      );
      expect(result.accessToken).toBeTruthy();
      expect(result.expiresIn).toBe(300);
      expect(result.profile.id).toBe(profile.id);
      expect(result.profile.handle).toBe("switchme");

      // Verify the new access token is valid
      const claims = yield* auth.verifyAccessToken(result.accessToken);
      expect(claims.profileId).toBe(profile.id);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("fails when target profile does not exist", () =>
    Effect.gen(function* () {
      const profile = yield* auth.registerProfile("switch2@example.com", "switch2");
      const error = yield* Effect.flip(
        auth.switchProfile(profile.accountId, "usr_nonexistent", yield* sessionOf(profile)),
      );
      expect(error._tag).toBe("AuthError");
      expect(error.message).toContain("Profile not found");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("fails when target profile belongs to a different account", () =>
    Effect.gen(function* () {
      const alice = yield* auth.registerProfile("alice_switch@example.com", "alice_switch");
      const bob = yield* auth.registerProfile("bob_switch@example.com", "bob_switch");
      // Try to switch to Bob's profile using Alice's accountId
      const error = yield* Effect.flip(
        auth.switchProfile(alice.accountId, bob.id, yield* sessionOf(alice)),
      );
      expect(error._tag).toBe("AuthError");
      expect(error.message).toContain("does not belong to this account");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("fails when account does not exist", () =>
    Effect.gen(function* () {
      // No account, so no session of it either: any hash will do.
      const error = yield* Effect.flip(
        auth.switchProfile("acc_nonexistent", "usr_any", "0".repeat(64)),
      );
      expect(error._tag).toBe("AuthError");
    }).pipe(Effect.provide(createTestLayer())),
  );
});

// ---------------------------------------------------------------------------
// listAccountProfiles
// ---------------------------------------------------------------------------

describe("listAccountProfiles", () => {
  it.effect("returns all profiles for the account", () =>
    Effect.gen(function* () {
      const profile = yield* auth.registerProfile("listme@example.com", "listme", "List Me");
      const result = yield* auth.listAccountProfiles(profile.accountId);
      expect(result.profiles).toHaveLength(1);
      expect(result.profiles[0]!.id).toBe(profile.id);
      expect(result.profiles[0]!.handle).toBe("listme");
      expect(result.profiles[0]!.displayName).toBe("List Me");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("fails for nonexistent account", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(auth.listAccountProfiles("acc_nonexistent"));
      expect(error._tag).toBe("AuthError");
    }).pipe(Effect.provide(createTestLayer())),
  );
});

// ---------------------------------------------------------------------------
// Server-side sessions (Copenhagen Book C1)
// ---------------------------------------------------------------------------

describe("server-side sessions (C1)", () => {
  it.effect("invalidateSession makes the session token unusable", () =>
    Effect.gen(function* () {
      const profile = yield* auth.registerProfile("revoke@example.com", "revoke");
      const tokens = yield* auth.issueTokens(
        profile.id,
        profile.accountId,
        profile.email,
        profile.handle,
        profile.displayName,
      );

      // Session works before invalidation
      const { accountId } = yield* auth.verifyRefreshToken(tokens.refreshToken);
      expect(accountId).toBe(profile.accountId);

      // Invalidate
      yield* auth.invalidateSession(tokens.refreshToken);

      // Session no longer works
      const error = yield* Effect.flip(auth.verifyRefreshToken(tokens.refreshToken));
      expect(error._tag).toBe("AuthError");
      expect(error.message).toContain("Invalid or expired session");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("invalidateSession is idempotent (no error on double-invalidate)", () =>
    Effect.gen(function* () {
      const profile = yield* auth.registerProfile("idem@example.com", "idem");
      const tokens = yield* auth.issueTokens(
        profile.id,
        profile.accountId,
        profile.email,
        profile.handle,
        profile.displayName,
      );
      yield* auth.invalidateSession(tokens.refreshToken);
      // Second invalidation should not throw
      yield* auth.invalidateSession(tokens.refreshToken);
      // ...and the session stays revoked rather than being resurrected by the
      // repeat call — the token is still dead afterwards.
      const err = yield* Effect.flip(auth.refreshTokens(tokens.refreshToken));
      expect(err._tag).toBe("AuthError");
      // Pin the message too: AuthError alone would also match a malformed
      // token or a signing-key fault, which is not what this test claims.
      expect(err.message).toContain("Invalid or expired session");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("invalidated session cannot be used for refreshTokens", () =>
    Effect.gen(function* () {
      const profile = yield* auth.registerProfile("norefresh@example.com", "norefresh");
      const tokens = yield* auth.issueTokens(
        profile.id,
        profile.accountId,
        profile.email,
        profile.handle,
        profile.displayName,
      );
      yield* auth.invalidateSession(tokens.refreshToken);

      const error = yield* Effect.flip(auth.refreshTokens(tokens.refreshToken));
      expect(error._tag).toBe("AuthError");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("each issueTokens call creates a distinct session", () =>
    Effect.gen(function* () {
      const profile = yield* auth.registerProfile("distinct@example.com", "distinct");
      const t1 = yield* auth.issueTokens(
        profile.id,
        profile.accountId,
        profile.email,
        profile.handle,
        profile.displayName,
      );
      const t2 = yield* auth.issueTokens(
        profile.id,
        profile.accountId,
        profile.email,
        profile.handle,
        profile.displayName,
      );
      // Different session tokens
      expect(t1.refreshToken).not.toBe(t2.refreshToken);

      // Invalidating one doesn't affect the other
      yield* auth.invalidateSession(t1.refreshToken);
      const { accountId } = yield* auth.verifyRefreshToken(t2.refreshToken);
      expect(accountId).toBe(profile.accountId);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("expired session is cleaned up and rejected on verify", () =>
    Effect.gen(function* () {
      // Use a 0-second TTL to create an instantly-expired session
      const svc = createAuthService({ ...config, refreshTokenTtl: 0 });
      const profile = yield* svc.registerProfile("expired@example.com", "expired");
      const tokens = yield* svc.issueTokens(
        profile.id,
        profile.accountId,
        profile.email,
        profile.handle,
        profile.displayName,
      );

      // Should be expired immediately
      const error = yield* Effect.flip(svc.verifyRefreshToken(tokens.refreshToken));
      expect(error._tag).toBe("AuthError");
      expect(error.message).toContain("Invalid or expired session");
    }).pipe(Effect.provide(createTestLayer())),
  );
});

// ---------------------------------------------------------------------------
// Refresh token rotation + reuse detection
// ---------------------------------------------------------------------------

describe("refresh token rotation (C2)", () => {
  it.effect("refreshed token can be used for a second refresh (chain)", () =>
    Effect.gen(function* () {
      const profile = yield* auth.registerProfile("chain@example.com", "chain");
      const tokens = yield* auth.issueTokens(
        profile.id,
        profile.accountId,
        profile.email,
        profile.handle,
        profile.displayName,
      );
      const r1 = yield* auth.refreshTokens(tokens.refreshToken);
      const r2 = yield* auth.refreshTokens(r1.refreshToken);
      expect(r2.refreshToken).not.toBe(r1.refreshToken);
      expect(r2.accessToken).toBeTruthy();
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect(
    "replaying a rotated-out token WITHIN the grace window is a benign race (family preserved)",
    () =>
      Effect.gen(function* () {
        // Concurrency tolerance: a legitimate client (multi-tab reload, a
        // bootstrap racing a 401-refresh, a retried grant) replays the
        // just-rotated token within ROTATION_GRACE_MS. This must NOT revoke the
        // family — otherwise the user is logged out across every device. The
        // losing grant still fails; the winning rotation (r1) stays valid.
        const profile = yield* auth.registerProfile("reuse-grace@example.com", "reusegrace");
        const tokens = yield* auth.issueTokens(
          profile.id,
          profile.accountId,
          profile.email,
          profile.handle,
          profile.displayName,
        );

        const r1 = yield* auth.refreshTokens(tokens.refreshToken);

        // Immediate replay of the rotated-out token — inside the grace window.
        const err1 = yield* Effect.flip(auth.refreshTokens(tokens.refreshToken));
        expect(err1._tag).toBe("AuthError");

        // The winning rotation's session SURVIVES — the family was NOT revoked.
        const stillValid = yield* auth.verifyRefreshToken(r1.refreshToken);
        expect(stillValid.accountId).toBe(profile.accountId);
      }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect(
    "replaying a rotated-out token OUTSIDE the grace window revokes the family (C2)",
    () => {
      const { layer, sqlite } = createTestLayerWithSqlite();
      return Effect.gen(function* () {
        // A genuine reuse: a stolen rotated token replayed long after rotation
        // (outside ROTATION_GRACE_MS). Force "outside grace" deterministically
        // by moving the rotation record's timestamp back to epoch 0.
        const profile = yield* auth.registerProfile("reuse-old@example.com", "reuseold");
        const tokens = yield* auth.issueTokens(
          profile.id,
          profile.accountId,
          profile.email,
          profile.handle,
          profile.displayName,
        );

        // Rotate once — old token is now rotated out (recorded in rotated_sessions).
        const r1 = yield* auth.refreshTokens(tokens.refreshToken);
        sqlite.run("UPDATE rotated_sessions SET rotated_at = 0");

        // Replay the old token — outside grace ⇒ genuine reuse ⇒ family revocation.
        const err1 = yield* Effect.flip(auth.refreshTokens(tokens.refreshToken));
        expect(err1._tag).toBe("AuthError");

        // The new token (r1) is also revoked (whole family gone).
        const err2 = yield* Effect.flip(auth.verifyRefreshToken(r1.refreshToken));
        expect(err2._tag).toBe("AuthError");
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("verifyRefreshToken returns familyId and sessionId", () =>
    Effect.gen(function* () {
      const profile = yield* auth.registerProfile("family@example.com", "family");
      const tokens = yield* auth.issueTokens(
        profile.id,
        profile.accountId,
        profile.email,
        profile.handle,
        profile.displayName,
      );
      const result = yield* auth.verifyRefreshToken(tokens.refreshToken);
      expect(result.accountId).toBe(profile.accountId);
      expect(result.familyId).toMatch(/^sfam_/);
      expect(result.sessionId).toBeTruthy();
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("verifyRefreshToken's authentication time is a fresh session's creation time", () => {
    const { layer, sqlite } = createTestLayerWithSqlite();
    return Effect.gen(function* () {
      const profile = yield* auth.registerProfile("verify-meta@example.com", "verifymeta");
      const tokens = yield* auth.issueTokens(
        profile.id,
        profile.accountId,
        profile.email,
        profile.handle,
        profile.displayName,
      );

      const result = yield* auth.verifyRefreshToken(tokens.refreshToken);
      const row = sqlite
        .query("SELECT created_at AS createdAt FROM sessions WHERE id = ?")
        .get(result.sessionId) as { createdAt: number };
      // Freshly issued: the ceremony time is the row's creation time.
      expect(result.authenticatedAt).toBe(row.createdAt);
    }).pipe(Effect.provide(layer));
  });

  it.effect("rotation carries uaLabel, ipHash and authenticatedAt onto the new row", () => {
    const { layer, sqlite } = createTestLayerWithSqlite();
    // A pepper is required for `ipHash` to be stored at all (context.hashIp).
    const svc = createAuthService({ ...config, sessionIpPepper: "x".repeat(32) });
    const device = (sessionId: string) =>
      sqlite
        .query("SELECT ua_label AS uaLabel, ip_hash AS ipHash FROM sessions WHERE id = ?")
        .get(sessionId) as { uaLabel: string | null; ipHash: string | null };
    return Effect.gen(function* () {
      const profile = yield* svc.registerProfile("rot-carry@example.com", "rotcarry");
      const tokens = yield* svc.issueTokens(
        profile.id,
        profile.accountId,
        profile.email,
        profile.handle,
        profile.displayName,
        undefined,
        { uaLabel: "Safari on iOS", ip: "203.0.113.9" },
      );
      const before = yield* svc.verifyRefreshToken(tokens.refreshToken);
      const beforeDevice = device(before.sessionId);

      const rotated = yield* svc.refreshTokens(tokens.refreshToken);
      const after = yield* svc.verifyRefreshToken(rotated.refreshToken);

      expect(after.sessionId).not.toBe(before.sessionId);
      expect(after.familyId).toBe(before.familyId);
      expect(beforeDevice.ipHash).toMatch(/^[a-f0-9]{64}$/);
      expect(device(after.sessionId)).toEqual({
        uaLabel: "Safari on iOS",
        ipHash: beforeDevice.ipHash,
      });
      // `auth_time` survives the silent rotation (OIDC max_age honesty).
      expect(after.authenticatedAt).toBe(before.authenticatedAt);
    }).pipe(Effect.provide(layer));
  });
});

// ---------------------------------------------------------------------------
// Session invalidation on security events
// ---------------------------------------------------------------------------

describe("invalidateOtherAccountSessions", () => {
  it.effect("revokes all sessions except the specified one", () =>
    Effect.gen(function* () {
      const profile = yield* auth.registerProfile("h1@example.com", "h1user");

      const t1 = yield* auth.issueTokens(
        profile.id,
        profile.accountId,
        profile.email,
        profile.handle,
        profile.displayName,
      );
      const t2 = yield* auth.issueTokens(
        profile.id,
        profile.accountId,
        profile.email,
        profile.handle,
        profile.displayName,
      );

      // Keep t1's session, revoke t2's
      const { sessionId } = yield* auth.verifyRefreshToken(t1.refreshToken);
      yield* auth.invalidateOtherAccountSessions(profile.accountId, sessionId);

      // t1 still works
      yield* auth.verifyRefreshToken(t1.refreshToken);

      // t2 is revoked
      const err = yield* Effect.flip(auth.verifyRefreshToken(t2.refreshToken));
      expect(err._tag).toBe("AuthError");
    }).pipe(Effect.provide(createTestLayer())),
  );
});
