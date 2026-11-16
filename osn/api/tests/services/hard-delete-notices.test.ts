import { it, expect, describe } from "@effect/vitest";
import { accounts, deletionJobs, organisationMembers, organisations } from "@osn/db/schema";
import { Db } from "@osn/db/service";
import { EmailError, EmailService } from "@shared/email";
import { eq } from "drizzle-orm";
import { Effect, Layer } from "effect";
import { beforeAll } from "vitest";

import { makeHeldHandleDigest } from "../../src/lib/handle-hold";
import * as accountErasure from "../../src/services/account-erasure";
import { createAuthService } from "../../src/services/auth";
import { createOrganisationService } from "../../src/services/organisation";
import { makeTestAuthConfig } from "../helpers/auth-config";
import { createTestLayerWithSqlite } from "../helpers/db";
import { everyAppDone } from "../helpers/deletion-apps";

/**
 * The hard delete's emails: `account-deleted` to the address the account had,
 * built from what the job held before the batch took it, and one
 * `organisation-ownership-received` to each member an organisation passed to.
 * They go only once the batch has removed the account, and a mail transport
 * that fails never holds up an erasure.
 */

const digest = makeHeldHandleDigest(undefined);
const notices = { appUrl: "https://app.example.test", instanceName: "Acme" };

let auth: ReturnType<typeof createAuthService>;
beforeAll(async () => {
  auth = createAuthService(await makeTestAuthConfig());
});

const orgs = createOrganisationService({ heldHandleDigest: digest });

/** Soft-deletes `accountId`, marks every app done with `appOutcomes`, and answers when its window has closed. */
const scheduleAndFinishApps = (accountId: string, appOutcomes: unknown) =>
  Effect.gen(function* () {
    yield* accountErasure.requestErasure({ accountId, cancel: null, heldHandleDigest: digest });
    yield* everyAppDone(accountId);
    const { db } = yield* Db;
    yield* Effect.promise(() =>
      db
        .update(deletionJobs)
        .set({ appOutcomes: JSON.stringify(appOutcomes) })
        .where(eq(deletionJobs.accountId, accountId)),
    );
    const [job] = yield* Effect.promise(() =>
      db.select().from(deletionJobs).where(eq(deletionJobs.accountId, accountId)),
    );
    return (job!.hardDeleteAt + 1) * 1_000;
  });

describe("hard-delete notices", () => {
  it.effect(
    "tell the old address what was held, kept and passed on, and each heir it now owns",
    () => {
      const { layer, email } = createTestLayerWithSqlite();
      return Effect.gen(function* () {
        const alice = yield* auth.registerProfile("alice@example.com", "alice");
        const bob = yield* auth.registerProfile("bob@example.com", "bob");
        const acme = yield* orgs.createOrganisation(alice.id, "acme", "Acme <Co>");
        yield* orgs.addMember(acme.id, alice.id, bob.id, "member");
        yield* orgs.createOrganisation(alice.id, "alone", "Alone");

        const nowMs = yield* scheduleAndFinishApps(alice.accountId, {
          pulse: {
            status: "done",
            kept: [
              {
                what: "Your event Launch, for its guests.",
                erasedOn: 1_900_000_000,
                requestUrl: "https://pulse.example.test/request",
              },
            ],
          },
          zap: { status: "skipped" },
          cire: { status: "done", kept: [] },
        });
        const result = yield* accountErasure.runHardDeleteSweep({ nowMs, notices });
        expect(result).toEqual({ purged: 1 });

        const deleted = email.recorded().filter((m) => m.template === "account-deleted");
        expect(deleted.map((m) => m.to)).toEqual(["alice@example.com"]);
        expect(deleted[0]!.text).toContain("@alice");
        expect(deleted[0]!.text).toContain("Pulse: Your event Launch, for its guests.");
        expect(deleted[0]!.text).toContain("https://pulse.example.test/request");
        expect(deleted[0]!.text).toContain("Acme <Co> (@acme) now belongs to @bob.");
        expect(deleted[0]!.text).toContain("Alone (@alone) was deleted.");

        const heirs = email
          .recorded()
          .filter((m) => m.template === "organisation-ownership-received");
        expect(heirs.map((m) => m.to)).toEqual(["bob@example.com"]);
        expect(heirs[0]!.text).toContain("https://app.example.test/organisations/acme?decline=1");
        // Named by its handle alone: the name is text its members wrote.
        expect(heirs[0]!.text).not.toContain("Acme <Co>");

        // The heir may decline it from now.
        const { db } = yield* Db;
        const [row] = yield* Effect.promise(() =>
          db
            .select({ ownerId: organisations.ownerId, inherited: organisations.ownerInheritedAt })
            .from(organisations)
            .where(eq(organisations.id, acme.id)),
        );
        expect(row).toEqual({ ownerId: bob.id, inherited: Math.floor(nowMs / 1_000) });
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("go once when two passes run the batch over one account", () => {
    // Red on sending from a pass whose batch removed nothing: once the
    // fan-out has claimed the job, both passes skip the claim and run it.
    const { layer, email } = createTestLayerWithSqlite();
    return Effect.gen(function* () {
      const alice = yield* auth.registerProfile("alice@example.com", "alice");
      const nowMs = yield* scheduleAndFinishApps(alice.accountId, {});
      const { db } = yield* Db;
      yield* Effect.promise(() =>
        db
          .update(deletionJobs)
          .set({ purgeStartedAt: Math.floor(nowMs / 1_000) - 1 })
          .where(eq(deletionJobs.accountId, alice.accountId)),
      );

      yield* Effect.all(
        [
          accountErasure.runHardDeleteSweep({ nowMs, notices }),
          accountErasure.runHardDeleteSweep({ nowMs, notices }),
        ],
        { concurrency: "unbounded" },
      );

      expect(email.recorded().filter((m) => m.template === "account-deleted")).toHaveLength(1);
      const left = yield* Effect.promise(() =>
        db.select().from(accounts).where(eq(accounts.id, alice.accountId)),
      );
      expect(left).toEqual([]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("never hold up an erasure when the transport fails", () => {
    const { db } = createTestLayerWithSqlite();
    const failing = Layer.succeed(EmailService, {
      send: () => Effect.fail(new EmailError({ reason: "dispatch_failed" })),
      sendBatch: () => Effect.fail(new EmailError({ reason: "dispatch_failed" })),
    });
    const layer = Layer.merge(Layer.succeed(Db, { db }), failing);
    return Effect.gen(function* () {
      const alice = yield* auth.registerProfile("alice@example.com", "alice");
      const bob = yield* auth.registerProfile("bob@example.com", "bob");
      const carol = yield* auth.registerProfile("carol@example.com", "carol");
      const acme = yield* orgs.createOrganisation(alice.id, "acme", "Acme");
      yield* orgs.addMember(acme.id, alice.id, bob.id, "member");
      const nowMs = yield* scheduleAndFinishApps(alice.accountId, {});
      yield* scheduleAndFinishApps(carol.accountId, {});

      expect(yield* accountErasure.runHardDeleteSweep({ nowMs, notices })).toEqual({ purged: 2 });
      const left = yield* Effect.promise(() => db.select({ id: accounts.id }).from(accounts));
      expect(left.map((r) => r.id)).toEqual([bob.accountId]);
      const members = yield* Effect.promise(() =>
        db
          .select({ profileId: organisationMembers.profileId })
          .from(organisationMembers)
          .where(eq(organisationMembers.organisationId, acme.id)),
      );
      expect(members).toEqual([{ profileId: bob.id }]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("go nowhere from a sweep given no notices", () => {
    const { layer, email } = createTestLayerWithSqlite();
    return Effect.gen(function* () {
      const alice = yield* auth.registerProfile("alice@example.com", "alice");
      const nowMs = yield* scheduleAndFinishApps(alice.accountId, {});
      expect(yield* accountErasure.runHardDeleteSweep({ nowMs })).toEqual({ purged: 1 });
      expect(email.recorded().filter((m) => m.template === "account-deleted")).toEqual([]);
    }).pipe(Effect.provide(layer));
  });
});
