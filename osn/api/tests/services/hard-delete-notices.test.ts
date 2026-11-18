import { it, expect, describe } from "@effect/vitest";
import { accounts, deletionJobs, organisationMembers, organisations } from "@osn/db/schema";
import { Db } from "@osn/db/service";
import { EmailError, EmailService } from "@shared/email";
import { eq } from "drizzle-orm";
import { Deferred, Effect, Fiber, Layer } from "effect";
import { TestClock } from "effect/testing";
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
 * that fails or hangs never holds up an erasure.
 */

const digest = makeHeldHandleDigest(undefined);
const notices = { appUrl: "https://app.example.test", instanceName: "Acme" };

let auth: ReturnType<typeof createAuthService>;
beforeAll(async () => {
  auth = createAuthService(await makeTestAuthConfig());
});

const orgs = createOrganisationService({ heldHandleDigest: digest });

/**
 * Soft-deletes `accountId` with `choices`, marks every app done with
 * `appOutcomes` (a string is stored as it is), and answers when its window
 * has closed.
 */
const scheduleAndFinishApps = (
  accountId: string,
  appOutcomes: unknown,
  choices?: accountErasure.ErasureChoices,
) =>
  Effect.gen(function* () {
    yield* accountErasure.requestErasure({
      accountId,
      cancel: null,
      heldHandleDigest: digest,
      choices,
    });
    yield* everyAppDone(accountId);
    const { db } = yield* Db;
    yield* Effect.promise(() =>
      db
        .update(deletionJobs)
        .set({
          appOutcomes: typeof appOutcomes === "string" ? appOutcomes : JSON.stringify(appOutcomes),
        })
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
        expect(deleted[0]!.text).toContain("@acme now belongs to @bob.");
        expect(deleted[0]!.text).toContain("@alone was deleted.");
        // Named by handle alone: any admin can rewrite the name.
        expect(deleted[0]!.text).not.toContain("Acme <Co>");
        expect(deleted[0]!.html).not.toContain("Acme &lt;Co&gt;");

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

  it.effect("give up on a transport that never answers, and finish the pass", () => {
    // Red without the send's timeout: the pass, and every account behind it,
    // would wait on the provider for ever.
    const { db } = createTestLayerWithSqlite();
    return Effect.gen(function* () {
      const reached = yield* Deferred.make<void>();
      const hanging = Layer.succeed(EmailService, {
        send: () => Deferred.succeed(reached, undefined).pipe(Effect.andThen(Effect.never)),
        sendBatch: () => Deferred.succeed(reached, undefined).pipe(Effect.andThen(Effect.never)),
      });
      const layer = Layer.merge(Layer.succeed(Db, { db }), hanging);
      yield* Effect.gen(function* () {
        const alice = yield* auth.registerProfile("alice@example.com", "alice");
        const bob = yield* auth.registerProfile("bob@example.com", "bob");
        const acme = yield* orgs.createOrganisation(alice.id, "acme", "Acme");
        yield* orgs.addMember(acme.id, alice.id, bob.id, "member");
        const nowMs = yield* scheduleAndFinishApps(alice.accountId, {});

        const sweep = yield* Effect.forkChild(
          accountErasure.runHardDeleteSweep({ nowMs, notices }),
        );
        yield* Deferred.await(reached);
        yield* TestClock.adjust("10 seconds");
        expect(yield* Fiber.join(sweep)).toEqual({ purged: 1 });
      }).pipe(Effect.provide(layer));
    });
  });

  it.effect("send at most ten ownership notices one by one on a transport with no batch", () => {
    // Each is a subrequest of its own there: 100 would overrun a Worker's
    // allowance for one invocation.
    const { db } = createTestLayerWithSqlite();
    const sent: string[] = [];
    const single = Layer.succeed(EmailService, {
      send: (input) => Effect.sync(() => void sent.push(input.template)),
    });
    const layer = Layer.merge(Layer.succeed(Db, { db }), single);
    return Effect.gen(function* () {
      const alice = yield* auth.registerProfile("alice@example.com", "alice");
      const bob = yield* auth.registerProfile("bob@example.com", "bob");
      for (let i = 0; i < 11; i++) {
        const org = yield* orgs.createOrganisation(alice.id, `org${i}`, `Org ${i}`);
        yield* orgs.addMember(org.id, alice.id, bob.id, "member");
      }
      const nowMs = yield* scheduleAndFinishApps(alice.accountId, {});
      expect(yield* accountErasure.runHardDeleteSweep({ nowMs, notices })).toEqual({ purged: 1 });

      expect(sent.filter((t) => t === "organisation-ownership-received")).toHaveLength(10);
      expect(sent.filter((t) => t === "account-deleted")).toHaveLength(1);
    }).pipe(Effect.provide(layer));
  });

  it.effect("say an organisation the person chose to delete was deleted, and mail no heir", () => {
    // Red on the batch's first read naming a successor for an organisation
    // the same batch deletes: the old owner would read that it passed on, and
    // the member would be mailed a link to decline something gone.
    const { layer, email } = createTestLayerWithSqlite();
    return Effect.gen(function* () {
      const alice = yield* auth.registerProfile("alice@example.com", "alice");
      const bob = yield* auth.registerProfile("bob@example.com", "bob");
      const acme = yield* orgs.createOrganisation(alice.id, "acme", "Acme");
      yield* orgs.addMember(acme.id, alice.id, bob.id, "admin");
      const nowMs = yield* scheduleAndFinishApps(
        alice.accountId,
        {},
        { [`osn:organisation:${acme.id}`]: { choice: "delete" } },
      );
      yield* accountErasure.runHardDeleteSweep({ nowMs, notices });

      const deleted = email.recorded().find((m) => m.template === "account-deleted");
      expect(deleted!.text).toContain("@acme was deleted.");
      expect(
        email.recorded().filter((m) => m.template === "organisation-ownership-received"),
      ).toEqual([]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("mail the successor the person named, not the admin the rule would pick", () => {
    const { layer, email } = createTestLayerWithSqlite();
    return Effect.gen(function* () {
      const alice = yield* auth.registerProfile("alice@example.com", "alice");
      const bob = yield* auth.registerProfile("bob@example.com", "bob");
      const carol = yield* auth.registerProfile("carol@example.com", "carol");
      const acme = yield* orgs.createOrganisation(alice.id, "acme", "Acme");
      yield* orgs.addMember(acme.id, alice.id, bob.id, "admin");
      yield* orgs.addMember(acme.id, alice.id, carol.id, "member");
      const nowMs = yield* scheduleAndFinishApps(
        alice.accountId,
        {},
        { [`osn:organisation:${acme.id}`]: { choice: "successor", successorProfileId: carol.id } },
      );
      yield* accountErasure.runHardDeleteSweep({ nowMs, notices });

      const heirs = email
        .recorded()
        .filter((m) => m.template === "organisation-ownership-received");
      expect(heirs.map((m) => m.to)).toEqual(["carol@example.com"]);
      const deleted = email.recorded().find((m) => m.template === "account-deleted");
      expect(deleted!.text).toContain("@acme now belongs to @carol.");
    }).pipe(Effect.provide(layer));
  });

  it.effect("still go when the job's outcomes do not read as the contract wrote them", () => {
    // A job's `app_outcomes` and `restore` may hold a shape this code never
    // wrote: the account is erased either way, and its email still goes.
    const { layer, email } = createTestLayerWithSqlite();
    return Effect.gen(function* () {
      const alice = yield* auth.registerProfile("alice@example.com", "alice");
      const nowMs = yield* scheduleAndFinishApps(alice.accountId, "not json");
      const { db } = yield* Db;
      yield* Effect.promise(() =>
        db
          .update(deletionJobs)
          .set({ restore: null })
          .where(eq(deletionJobs.accountId, alice.accountId)),
      );
      expect(yield* accountErasure.runHardDeleteSweep({ nowMs, notices })).toEqual({ purged: 1 });

      const deleted = email.recorded().filter((m) => m.template === "account-deleted");
      expect(deleted).toHaveLength(1);
      expect(deleted[0]!.text).toContain("No app kept anything of yours.");
    }).pipe(Effect.provide(layer));
  });

  it.effect("leave out a kept item an app wrote with no description", () => {
    const { layer, email } = createTestLayerWithSqlite();
    return Effect.gen(function* () {
      const alice = yield* auth.registerProfile("alice@example.com", "alice");
      const nowMs = yield* scheduleAndFinishApps(alice.accountId, {
        pulse: { status: "done", kept: [{ erasedOn: 1_900_000_000, requestUrl: null }] },
      });
      yield* accountErasure.runHardDeleteSweep({ nowMs, notices });

      const deleted = email.recorded().filter((m) => m.template === "account-deleted");
      expect(deleted).toHaveLength(1);
      expect(deleted[0]!.text).toContain("No app kept anything of yours.");
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
