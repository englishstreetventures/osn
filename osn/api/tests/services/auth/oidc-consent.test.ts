/**
 * A re-approval of an OIDC consent writes the scope it merged from the row it
 * read, and only while the row is still as read. A revoke landing between the
 * read and the write must not bring the withdrawn scope back; a widen landing
 * there must not be lost. One retry reads the row again; a second miss fails
 * the request and writes nothing.
 */

import { it, expect, describe } from "@effect/vitest";
import { Db } from "@osn/db/service";
import { Effect, Fiber, Layer } from "effect";
import { beforeAll } from "vitest";

import { createAuthService } from "../../../src/services/auth";
import { createAuthContext } from "../../../src/services/auth/context";
import { createOidcModule } from "../../../src/services/auth/oidc";
import { createProfilesModule } from "../../../src/services/auth/profiles";
import { makeTestAuthConfig } from "../../helpers/auth-config";
import { createTestLayerWithSqlite } from "../../helpers/db";
import { holdQueries } from "../../helpers/held-query";

const CLIENT_ID = "cid_consent";

let auth: ReturnType<typeof createAuthService>;
let oidc: ReturnType<typeof createOidcModule>;

beforeAll(async () => {
  const config = await makeTestAuthConfig();
  auth = createAuthService(config);
  oidc = createOidcModule(createAuthContext(config), createProfilesModule());
});

function harness() {
  const { db, sqlite, email } = createTestLayerWithSqlite();
  sqlite.run(
    `INSERT INTO oauth_clients
       (id, client_id, name, logo_url, redirect_uris, client_secret_hash,
        sector_identifier, allowed_scopes, is_first_party, created_at, disabled_at)
     VALUES (?, ?, 'Consent RP', NULL, ?, NULL, 'rp.example', 'openid profile email', 0, ?, NULL)`,
    [`oc_${CLIENT_ID}`, CLIENT_ID, JSON.stringify(["https://rp.example/cb"]), 0],
  );
  const queries = holdQueries(db);
  return {
    layer: Layer.merge(Layer.succeed(Db, { db: queries.db }), email.layer),
    hold: queries.hold,
    consent: (accountId: string) => {
      const row = sqlite
        .query("SELECT scope, revoked_at AS revokedAt FROM oauth_consents WHERE account_id = ?")
        .get(accountId) as { scope: string; revokedAt: number | null } | null;
      return row && { scope: row.scope.split(" ").toSorted(), revokedAt: row.revokedAt };
    },
  };
}

/** The merge update every re-approval sends; the revoke's update sets `revoked_at` first. */
const MERGE = /^update "oauth_consents" set "profile_id"/;

const linked = (handle: string, scope: string) =>
  Effect.gen(function* () {
    const profile = yield* auth.registerProfile(`${handle}@example.com`, handle);
    yield* oidc.recordConsent(profile.accountId, CLIENT_ID, profile.id, scope);
    return profile;
  });

/** Rejects if `hold` is not reached within a second, so a missing retry fails the test. */
const reachedSoon = (reached: Promise<void>) =>
  Effect.promise(() =>
    Promise.race([
      reached.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1_000)),
    ]),
  );

describe("recordConsent: a re-approval and a change that lands before its write", () => {
  it.live("a revoke in between: the withdrawn scope stays withdrawn", () => {
    const h = harness();
    return Effect.gen(function* () {
      const profile = yield* linked("occ1", "openid profile");

      const merge = h.hold(MERGE);
      const approval = yield* Effect.forkChild(
        oidc.recordConsent(profile.accountId, CLIENT_ID, profile.id, "openid email"),
      );
      yield* Effect.promise(() => merge.reached);
      yield* oidc.revokeConsent(profile.accountId, CLIENT_ID);
      merge.release();

      expect(yield* Fiber.join(approval)).toBe(true);
      expect(h.consent(profile.accountId)).toEqual({ scope: ["email", "openid"], revokedAt: null });
    }).pipe(Effect.provide(h.layer));
  });

  it.live("a widen in between: both approvals' scopes stand", () => {
    const h = harness();
    return Effect.gen(function* () {
      const profile = yield* linked("occ2", "openid");

      const merge = h.hold(MERGE);
      const approval = yield* Effect.forkChild(
        oidc.recordConsent(profile.accountId, CLIENT_ID, profile.id, "openid email"),
      );
      yield* Effect.promise(() => merge.reached);
      yield* oidc.recordConsent(profile.accountId, CLIENT_ID, profile.id, "openid profile");
      merge.release();

      expect(yield* Fiber.join(approval)).toBe(false);
      expect(h.consent(profile.accountId)).toEqual({
        scope: ["email", "openid", "profile"],
        revokedAt: null,
      });
    }).pipe(Effect.provide(h.layer));
  });

  it.live("a change before each of two writes: the request fails and writes nothing", () => {
    const h = harness();
    return Effect.gen(function* () {
      const profile = yield* linked("occ3", "openid profile");

      const first = h.hold(MERGE);
      const approval = yield* Effect.forkChild(
        Effect.result(oidc.recordConsent(profile.accountId, CLIENT_ID, profile.id, "openid email")),
      );
      yield* Effect.promise(() => first.reached);
      yield* oidc.revokeConsent(profile.accountId, CLIENT_ID);
      const second = h.hold(MERGE);
      first.release();

      expect(yield* reachedSoon(second.reached)).toBe(true);
      // Another approval re-grants in between the retry's read and its write.
      yield* oidc.recordConsent(profile.accountId, CLIENT_ID, profile.id, "openid profile");
      second.release();

      const outcome = yield* Fiber.join(approval);
      expect(outcome._tag).toBe("Failure");
      if (outcome._tag === "Failure") expect(outcome.failure._tag).toBe("DatabaseError");
      expect(h.consent(profile.accountId)).toEqual({
        scope: ["openid", "profile"],
        revokedAt: null,
      });
    }).pipe(Effect.provide(h.layer));
  });
});
