import { it } from "@effect/vitest";
import { chatMembers, chats, messages } from "@zap/db/schema";
import { Db } from "@zap/db/service";
import { eq } from "drizzle-orm";
import { Effect, Fiber, Layer } from "effect";
import { describe, expect } from "vitest";

import { DELETED_SENDER, purgeAccount } from "../../src/services/accountErasure";
import {
  createTestDb,
  createTestLayer,
  seedC2bChat,
  seedC2bMessage,
  seedChat,
  seedMember,
  seedMessage,
} from "../helpers/db";
import { holdQueries } from "../helpers/held-query";

/**
 * What an OSN account deletion does to the person's Zap data: their
 * memberships go; a chat left with no one goes with its messages; what they
 * sent that stays with others no longer names them, and a plain-text body
 * they wrote is wiped, while an end-to-end message keeps its ciphertext.
 */

const ME = "usr_me";
const ALSO_ME = "usr_me_too";
const THEM = "usr_them";

const rows = Effect.gen(function* () {
  const { db } = yield* Db;
  const [c, m, msg] = yield* Effect.promise(() =>
    Promise.all([
      db.select().from(chats),
      db.select().from(chatMembers),
      db.select().from(messages),
    ]),
  );
  return { chats: c, members: m, messages: msg };
});

describe("zap account erasure", () => {
  it.effect("removes the memberships and deletes a chat left with no one, with its messages", () =>
    Effect.gen(function* () {
      const alone = yield* seedChat({ type: "group", createdByProfileId: ME });
      yield* seedMember(alone.id, ME, "admin");
      yield* seedMember(alone.id, ALSO_ME);
      yield* seedMessage(alone.id, THEM, "b2xk", new Date());

      const result = yield* purgeAccount("acc_me", [ME, ALSO_ME]);

      const after = yield* rows;
      expect(after).toEqual({ chats: [], members: [], messages: [] });
      expect(result).toEqual({ alreadyProcessed: false, kept: [] });
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect(
    "keeps a chat with another member; what the person sent there no longer names them",
    () =>
      Effect.gen(function* () {
        const shared = yield* seedChat({ type: "dm", createdByProfileId: ME });
        yield* seedMember(shared.id, ME);
        yield* seedMember(shared.id, THEM);
        const mine = yield* seedMessage(shared.id, ME, "Y2lwaGVy", new Date());
        const theirs = yield* seedMessage(shared.id, THEM, "dGhlaXJz", new Date());

        const result = yield* purgeAccount("acc_me", [ME]);

        const after = yield* rows;
        expect(after.chats).toEqual([
          expect.objectContaining({ id: shared.id, createdByProfileId: DELETED_SENDER }),
        ]);
        expect(after.members.map((m) => m.profileId)).toEqual([THEM]);
        const kept = after.messages.find((m) => m.id === mine.id);
        expect(kept).toMatchObject({
          senderProfileId: DELETED_SENDER,
          ciphertext: "Y2lwaGVy",
          body: null,
        });
        expect(after.messages.find((m) => m.id === theirs.id)).toMatchObject({
          senderProfileId: THEM,
          ciphertext: "dGhlaXJz",
        });
        expect(result.kept).toEqual([
          {
            what: "Encrypted messages you sent in chats that still have other members, without your name",
            erasedOn: null,
            requestUrl: null,
          },
        ]);
      }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect(
    "wipes the body of a plain-text message the person wrote, and leaves another person's",
    () =>
      Effect.gen(function* () {
        const c2b = yield* seedC2bChat({ type: "group", createdByProfileId: THEM });
        yield* seedMember(c2b.id, ME);
        yield* seedMember(c2b.id, THEM);
        const mine = yield* seedC2bMessage(c2b.id, ME, "my address is 1 Main St");
        const theirs = yield* seedC2bMessage(c2b.id, THEM, "thanks");

        const result = yield* purgeAccount("acc_me", [ME]);

        const after = yield* rows;
        expect(after.messages.find((m) => m.id === mine.id)).toMatchObject({
          senderProfileId: DELETED_SENDER,
          body: null,
        });
        expect(after.messages.find((m) => m.id === theirs.id)).toMatchObject({
          senderProfileId: THEM,
          body: "thanks",
        });
        // No end-to-end message of theirs stays: nothing to report.
        expect(result.kept).toEqual([]);
      }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("a repeat writes nothing and answers what the first kept", () =>
    Effect.gen(function* () {
      const shared = yield* seedChat({ type: "dm", createdByProfileId: ME });
      yield* seedMember(shared.id, ME);
      yield* seedMember(shared.id, THEM);
      yield* seedMessage(shared.id, ME, "Y2lwaGVy", new Date());

      const first = yield* purgeAccount("acc_me", [ME]);
      const second = yield* purgeAccount("acc_me", [ME]);
      expect(second).toEqual({ alreadyProcessed: true, kept: first.kept });
      expect(first.kept).toHaveLength(1);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("an empty profile list erases nothing and records the account", () =>
    Effect.gen(function* () {
      const shared = yield* seedChat({ type: "dm", createdByProfileId: THEM });
      yield* seedMember(shared.id, THEM);
      expect(yield* purgeAccount("acc_none", [])).toEqual({ alreadyProcessed: false, kept: [] });
      expect((yield* rows).members).toHaveLength(1);
      expect((yield* purgeAccount("acc_none", [])).alreadyProcessed).toBe(true);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.live("a member who joins a chat between the read and the batch keeps it", () => {
    const { db } = createTestDb();
    const { db: heldDb, hold } = holdQueries(db);
    const layer = Layer.succeed(Db, { db: heldDb });
    return Effect.gen(function* () {
      const chat = yield* seedChat({ type: "group", createdByProfileId: ME });
      yield* seedMember(chat.id, ME, "admin");
      yield* seedMessage(chat.id, ME, "Y2lwaGVy", new Date());

      const batch = hold(/^delete from "messages"/);
      const purge = yield* Effect.forkChild(purgeAccount("acc_me", [ME]));
      yield* Effect.promise(() => batch.reached);
      yield* Effect.promise(() =>
        db
          .insert(chatMembers)
          .values({ id: "cmem_late", chatId: chat.id, profileId: THEM, role: "member" }),
      );
      batch.release();
      const result = yield* Fiber.join(purge);

      // The message stays with the member who joined, and the answer says so.
      expect(result.kept).toHaveLength(1);
      const after = yield* rows;
      expect(after.chats.map((c) => c.id)).toEqual([chat.id]);
      expect(after.members.map((m) => m.profileId)).toEqual([THEM]);
      expect(after.messages).toEqual([
        expect.objectContaining({ senderProfileId: DELETED_SENDER }),
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.live(
    "a member who leaves a chat between the read and the batch takes the kept message with the chat",
    () => {
      const { db } = createTestDb();
      const { db: heldDb, hold } = holdQueries(db);
      const layer = Layer.succeed(Db, { db: heldDb });
      return Effect.gen(function* () {
        const chat = yield* seedChat({ type: "group", createdByProfileId: THEM });
        yield* seedMember(chat.id, ME);
        yield* seedMember(chat.id, THEM, "admin");
        yield* seedMessage(chat.id, ME, "Y2lwaGVy", new Date());

        const batch = hold(/^delete from "messages"/);
        const purge = yield* Effect.forkChild(purgeAccount("acc_me", [ME]));
        yield* Effect.promise(() => batch.reached);
        yield* Effect.promise(() => db.delete(chatMembers).where(eq(chatMembers.profileId, THEM)));
        batch.release();
        const result = yield* Fiber.join(purge);

        expect(result.kept).toEqual([]);
        expect(yield* rows).toEqual({ chats: [], members: [], messages: [] });
      }).pipe(Effect.provide(layer));
    },
  );

  it.live("two overlapping erasures of one account both answer what was kept", () => {
    const { db } = createTestDb();
    const { db: heldDb, hold } = holdQueries(db);
    const layer = Layer.succeed(Db, { db: heldDb });
    return Effect.gen(function* () {
      const chat = yield* seedChat({ type: "group", createdByProfileId: THEM });
      yield* seedMember(chat.id, ME);
      yield* seedMember(chat.id, THEM, "admin");
      yield* seedMessage(chat.id, ME, "Y2lwaGVy", new Date());

      // The first call has read; the second runs whole before it writes.
      const batch = hold(/^delete from "messages"/);
      const first = yield* Effect.forkChild(purgeAccount("acc_me", [ME]));
      yield* Effect.promise(() => batch.reached);
      const second = yield* purgeAccount("acc_me", [ME]);
      batch.release();
      const answered = yield* Fiber.join(first);

      expect(second.kept).toHaveLength(1);
      expect(answered.kept).toEqual(second.kept);
    }).pipe(Effect.provide(layer));
  });

  it.effect("binds each list once per statement, whatever its length", () =>
    Effect.gen(function* () {
      const { db } = yield* Db;
      const ids = Array.from({ length: 100 }, (_, i) => `usr_p${i}`);
      const chat = yield* seedChat({ type: "group", createdByProfileId: THEM });
      yield* seedMember(chat.id, THEM);
      for (const id of ids.slice(0, 3)) yield* seedMember(chat.id, id);
      yield* purgeAccount("acc_many", ids);
      expect(
        yield* Effect.promise(() =>
          db.select().from(chatMembers).where(eq(chatMembers.chatId, chat.id)),
        ),
      ).toHaveLength(1);
    }).pipe(Effect.provide(createTestLayer())),
  );
});
