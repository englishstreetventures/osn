import { it } from "@effect/vitest";
import { Effect, Either } from "effect";
import { describe, expect } from "vitest";

import { provisionC2bChat } from "../../src/services/chats";
import {
  sendMessage,
  listMessages,
  sendC2bMessage,
  listC2bMessages,
} from "../../src/services/messages";
import { createTestLayer, seedChat, seedC2bMessage, seedMember, seedMessage } from "../helpers/db";

describe("messages service", () => {
  it.effect("sendMessage stores an encrypted message", () =>
    Effect.gen(function* () {
      const chat = yield* seedChat({ type: "group" });
      yield* seedMember(chat.id, "usr_alice", "admin");

      const msg = yield* sendMessage(chat.id, "usr_alice", {
        ciphertext: "dGVzdCBtZXNzYWdl",
        nonce: "YWJjZGVmMTIzNDU2",
      });
      expect(msg.id).toMatch(/^msg_/);
      expect(msg.chatId).toBe(chat.id);
      expect(msg.senderProfileId).toBe("usr_alice");
      expect(msg.ciphertext).toBe("dGVzdCBtZXNzYWdl");
      expect(msg.nonce).toBe("YWJjZGVmMTIzNDU2");
      expect(msg.createdAt).toBeInstanceOf(Date);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("sendMessage fails for non-member", () =>
    Effect.gen(function* () {
      const chat = yield* seedChat({ type: "group" });
      yield* seedMember(chat.id, "usr_alice", "admin");

      const result = yield* Effect.either(
        sendMessage(chat.id, "usr_bob", { ciphertext: "dGVzdA==", nonce: "bm9uY2U=" }),
      );
      expect(Either.isLeft(result)).toBe(true);
      if (Either.isLeft(result)) {
        expect(result.left._tag).toBe("NotChatMember");
      }
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("sendMessage fails for nonexistent chat", () =>
    Effect.gen(function* () {
      const result = yield* Effect.either(
        sendMessage("chat_nope", "usr_alice", { ciphertext: "dGVzdA==", nonce: "bm9uY2U=" }),
      );
      expect(Either.isLeft(result)).toBe(true);
      if (Either.isLeft(result)) {
        expect(result.left._tag).toBe("ChatNotFound");
      }
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("listMessages returns messages in reverse chronological order", () =>
    Effect.gen(function* () {
      const chat = yield* seedChat({ type: "group" });
      yield* seedMember(chat.id, "usr_alice", "admin");

      // Seeded a second apart, not sent 10ms apart. `created_at` has second
      // resolution, so a 10ms gap stored the same value for both and the test
      // was really asserting insertion order — which the list query never
      // promised and, since it now tiebreaks on the random `id`, no longer
      // happens to give. Within one second the order is unspecified; see
      // xchromo/osn-tracker for the ordering finding.
      const base = new Date(1_756_500_000_000);
      yield* seedMessage(chat.id, "usr_alice", "bXNnMQ==", new Date(base.getTime()));
      yield* seedMessage(chat.id, "usr_alice", "bXNnMg==", new Date(base.getTime() + 1000));

      const msgs = yield* listMessages(chat.id, "usr_alice");
      expect(msgs).toHaveLength(2);
      // Newest first.
      expect(msgs[0]!.ciphertext).toBe("bXNnMg==");
      expect(msgs[1]!.ciphertext).toBe("bXNnMQ==");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("listMessages respects limit", () =>
    Effect.gen(function* () {
      const chat = yield* seedChat({ type: "group" });
      yield* seedMember(chat.id, "usr_alice", "admin");

      for (let i = 0; i < 5; i++) {
        yield* sendMessage(chat.id, "usr_alice", {
          ciphertext: `bXNn${i}`,
          nonce: `bm9uY2U${i}`,
        });
      }

      const msgs = yield* listMessages(chat.id, "usr_alice", { limit: 2 });
      expect(msgs).toHaveLength(2);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("listMessages fails for non-member", () =>
    Effect.gen(function* () {
      const chat = yield* seedChat({ type: "group" });
      yield* seedMember(chat.id, "usr_alice", "admin");

      const result = yield* Effect.either(listMessages(chat.id, "usr_bob"));
      expect(Either.isLeft(result)).toBe(true);
      if (Either.isLeft(result)) {
        expect(result.left._tag).toBe("NotChatMember");
      }
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("listMessages returns empty for chat with no messages", () =>
    Effect.gen(function* () {
      const chat = yield* seedChat({ type: "group" });
      yield* seedMember(chat.id, "usr_alice", "admin");

      const msgs = yield* listMessages(chat.id, "usr_alice");
      expect(msgs).toHaveLength(0);
    }).pipe(Effect.provide(createTestLayer())),
  );

  // ── Validation error paths (T-E2) ────────────────────────────────────

  it.effect("sendMessage fails with ValidationError for oversized ciphertext", () =>
    Effect.gen(function* () {
      const chat = yield* seedChat({ type: "group" });
      yield* seedMember(chat.id, "usr_alice", "admin");

      const result = yield* Effect.either(
        sendMessage(chat.id, "usr_alice", {
          ciphertext: "X".repeat(262_145), // exceeds MAX_CIPHERTEXT_LENGTH
          nonce: "bm9uY2U=",
        }),
      );
      expect(Either.isLeft(result)).toBe(true);
      if (Either.isLeft(result)) {
        expect(result.left._tag).toBe("ValidationError");
      }
    }).pipe(Effect.provide(createTestLayer())),
  );

  // ── Cursor pagination (T-U1) ─────────────────────────────────────────

  it.effect("listMessages supports cursor-based pagination", () =>
    Effect.gen(function* () {
      const chat = yield* seedChat({ type: "group" });
      yield* seedMember(chat.id, "usr_alice", "admin");

      // Seed 5 messages with distinct second-granularity timestamps
      // (SQLite stores timestamps as integer seconds).
      const baseTime = new Date("2030-01-01T00:00:00.000Z").getTime();
      for (let i = 0; i < 5; i++) {
        yield* seedMessage(
          chat.id,
          "usr_alice",
          `msg${i}`,
          new Date(baseTime + i * 1000), // 1 second apart
        );
      }

      // First page: get 2 newest messages.
      const page1 = yield* listMessages(chat.id, "usr_alice", { limit: 2 });
      expect(page1).toHaveLength(2);
      // Newest first — should be msg4, msg3.
      expect(page1[0]!.ciphertext).toBe("msg4");
      expect(page1[1]!.ciphertext).toBe("msg3");

      // Second page: use last message ID as cursor.
      const cursor = page1[1]!.id;
      const page2 = yield* listMessages(chat.id, "usr_alice", { limit: 2, cursor });
      expect(page2).toHaveLength(2);
      expect(page2[0]!.ciphertext).toBe("msg2");
      expect(page2[1]!.ciphertext).toBe("msg1");

      // Third page: should get only 1 remaining message.
      const cursor2 = page2[1]!.id;
      const page3 = yield* listMessages(chat.id, "usr_alice", { limit: 2, cursor: cursor2 });
      expect(page3).toHaveLength(1);
      expect(page3[0]!.ciphertext).toBe("msg0");
    }).pipe(Effect.provide(createTestLayer())),
  );

  // ── Z6 cursor scoping ────────────────────────────────────────────────────

  it.effect("listMessages rejects an unknown cursor instead of returning page 1", () =>
    Effect.gen(function* () {
      const chat = yield* seedChat({ type: "group" });
      yield* seedMember(chat.id, "usr_alice", "admin");
      yield* seedMessage(chat.id, "usr_alice", "msg0", new Date("2030-01-01T00:00:00Z"));

      const result = yield* Effect.either(
        listMessages(chat.id, "usr_alice", { cursor: "msg_does_not_exist" }),
      );
      expect(Either.isLeft(result)).toBe(true);
      if (Either.isLeft(result)) {
        expect(result.left._tag).toBe("ValidationError");
      }
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("listMessages rejects a cursor that belongs to a different chat", () =>
    Effect.gen(function* () {
      const chatA = yield* seedChat({ type: "group" });
      const chatB = yield* seedChat({ type: "group" });
      yield* seedMember(chatA.id, "usr_alice", "admin");
      yield* seedMember(chatB.id, "usr_alice", "admin");

      yield* seedMessage(chatA.id, "usr_alice", "a0", new Date("2030-01-01T00:00:00Z"));
      const foreign = yield* seedMessage(
        chatB.id,
        "usr_alice",
        "b0",
        new Date("2030-01-01T00:00:00Z"),
      );

      // A cursor minted in chat B must not paginate chat A.
      const result = yield* Effect.either(
        listMessages(chatA.id, "usr_alice", { cursor: foreign.id }),
      );
      expect(Either.isLeft(result)).toBe(true);
      if (Either.isLeft(result)) {
        expect(result.left._tag).toBe("ValidationError");
      }
    }).pipe(Effect.provide(createTestLayer())),
  );

  // ── c2b message functions (Task 3) ────────────────────────────────────────

  it.effect("sendC2bMessage stores plaintext body, null ciphertext/nonce", () =>
    Effect.gen(function* () {
      const chat = yield* provisionC2bChat({
        memberProfileIds: ["usr_a", "usr_b"],
        createdByProfileId: "usr_a",
      });
      const msg = yield* sendC2bMessage(chat.id, "usr_a", { body: "hello" });
      expect(msg.body).toBe("hello");
      expect(msg.ciphertext).toBeNull();
      expect(msg.nonce).toBeNull();
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("sendC2bMessage fails NotC2bChat on a c2c chat", () =>
    Effect.gen(function* () {
      const chat = yield* seedChat({ type: "group" });
      yield* seedMember(chat.id, "usr_alice", "admin");
      const result = yield* Effect.either(sendC2bMessage(chat.id, "usr_alice", { body: "hello" }));
      expect(Either.isLeft(result)).toBe(true);
      if (Either.isLeft(result)) {
        expect(result.left._tag).toBe("NotC2bChat");
      }
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("sendC2bMessage fails NotChatMember for a non-member sender", () =>
    Effect.gen(function* () {
      const chat = yield* provisionC2bChat({
        memberProfileIds: ["usr_a", "usr_b"],
        createdByProfileId: "usr_a",
      });
      const result = yield* Effect.either(
        sendC2bMessage(chat.id, "usr_outsider", { body: "hello" }),
      );
      expect(Either.isLeft(result)).toBe(true);
      if (Either.isLeft(result)) {
        expect(result.left._tag).toBe("NotChatMember");
      }
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("sendC2bMessage fails ValidationError for empty body", () =>
    Effect.gen(function* () {
      const chat = yield* provisionC2bChat({
        memberProfileIds: ["usr_a", "usr_b"],
        createdByProfileId: "usr_a",
      });
      const result = yield* Effect.either(sendC2bMessage(chat.id, "usr_a", { body: "" }));
      expect(Either.isLeft(result)).toBe(true);
      if (Either.isLeft(result)) {
        expect(result.left._tag).toBe("ValidationError");
      }
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("listC2bMessages returns bodies newest-first", () =>
    Effect.gen(function* () {
      const chat = yield* provisionC2bChat({
        memberProfileIds: ["usr_a", "usr_b"],
        createdByProfileId: "usr_a",
      });
      // Seeded a second apart — see the c2c ordering test above for why a
      // 10ms gap does not order anything.
      const base = new Date(1_756_500_000_000);
      yield* seedC2bMessage(chat.id, "usr_a", "first", new Date(base.getTime()));
      yield* seedC2bMessage(chat.id, "usr_b", "second", new Date(base.getTime() + 1000));

      const msgs = yield* listC2bMessages(chat.id);
      expect(msgs).toHaveLength(2);
      // Newest first.
      expect(msgs[0]!.body).toBe("second");
      expect(msgs[1]!.body).toBe("first");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("listC2bMessages fails NotC2bChat on a c2c chat", () =>
    Effect.gen(function* () {
      const chat = yield* seedChat({ type: "group" });
      const result = yield* Effect.either(listC2bMessages(chat.id));
      expect(Either.isLeft(result)).toBe(true);
      if (Either.isLeft(result)) {
        expect(result.left._tag).toBe("NotC2bChat");
      }
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("listC2bMessages fails ChatNotFound for missing chat", () =>
    Effect.gen(function* () {
      const result = yield* Effect.either(listC2bMessages("chat_nonexistent"));
      expect(Either.isLeft(result)).toBe(true);
      if (Either.isLeft(result)) {
        expect(result.left._tag).toBe("ChatNotFound");
      }
    }).pipe(Effect.provide(createTestLayer())),
  );

  // Same contract as listMessages. Falling back to page 1 sends a paginating
  // caller round the same page for ever, and it cannot tell that from a
  // genuinely short history.
  it.effect("listC2bMessages rejects an unknown before cursor", () =>
    Effect.gen(function* () {
      const chat = yield* provisionC2bChat({
        memberProfileIds: ["usr_a", "usr_b"],
        createdByProfileId: "usr_a",
      });
      yield* sendC2bMessage(chat.id, "usr_a", { body: "first" });

      const result = yield* Effect.either(listC2bMessages(chat.id, { before: "msg_nope" }));
      expect(Either.isLeft(result)).toBe(true);
      if (Either.isLeft(result)) {
        expect(result.left._tag).toBe("ValidationError");
      }
    }).pipe(Effect.provide(createTestLayer())),
  );

  // A cursor belonging to a different chat is unknown *to this chat*, so it
  // takes the same branch — the lookup is scoped by chatId.
  it.effect("listC2bMessages rejects a cursor from another chat", () =>
    Effect.gen(function* () {
      const mine = yield* provisionC2bChat({
        memberProfileIds: ["usr_a", "usr_b"],
        createdByProfileId: "usr_a",
      });
      const theirs = yield* provisionC2bChat({
        memberProfileIds: ["usr_c", "usr_d"],
        createdByProfileId: "usr_c",
      });
      yield* sendC2bMessage(mine.id, "usr_a", { body: "mine" });
      const other = yield* sendC2bMessage(theirs.id, "usr_c", { body: "theirs" });

      const result = yield* Effect.either(listC2bMessages(mine.id, { before: other.id }));
      expect(Either.isLeft(result)).toBe(true);
      if (Either.isLeft(result)) {
        expect(result.left._tag).toBe("ValidationError");
      }
    }).pipe(Effect.provide(createTestLayer())),
  );

  // Both send paths now return the row they wrote instead of reading it back.
  // That is only safe while the returned object matches what the database
  // actually stored — including `createdAt`, which is stored as whole seconds.
  it.effect("sendC2bMessage returns exactly what a later read returns", () =>
    Effect.gen(function* () {
      const chat = yield* provisionC2bChat({
        memberProfileIds: ["usr_a", "usr_b"],
        createdByProfileId: "usr_a",
      });
      const returned = yield* sendC2bMessage(chat.id, "usr_a", { body: "hello" });
      const [stored] = yield* listC2bMessages(chat.id);
      expect(stored).toEqual(returned);
      expect(returned.createdAt.getTime() % 1000).toBe(0);
    }).pipe(Effect.provide(createTestLayer())),
  );

  // The keyset's whole point: a page boundary that lands inside a run of
  // messages sharing one second must not skip the rest of that second.
  // `created_at` has second resolution, so a strict `createdAt <` alone lost
  // them for ever — proven here by paging through five messages written at the
  // same instant and asserting every one comes back exactly once.
  it.effect("listC2bMessages pages through messages sharing one second", () =>
    Effect.gen(function* () {
      const chat = yield* provisionC2bChat({
        memberProfileIds: ["usr_a", "usr_b"],
        createdByProfileId: "usr_a",
      });
      const sameSecond = new Date(1_756_500_000_000);
      for (const body of ["m1", "m2", "m3", "m4", "m5"]) {
        yield* seedC2bMessage(chat.id, "usr_a", body, sameSecond);
      }

      const seen: string[] = [];
      let before: string | undefined;
      for (let page = 0; page < 5; page++) {
        const rows = yield* listC2bMessages(chat.id, { limit: 2, before });
        if (rows.length === 0) break;
        seen.push(...rows.map((r) => r.body!));
        before = rows[rows.length - 1]!.id;
      }

      expect(seen).toHaveLength(5);
      expect(seen.toSorted()).toEqual(["m1", "m2", "m3", "m4", "m5"]);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("listMessages pages through messages sharing one second", () =>
    Effect.gen(function* () {
      const chat = yield* seedChat({ type: "group" });
      yield* seedMember(chat.id, "usr_alice", "admin");
      const sameSecond = new Date(1_756_500_000_000);
      for (const text of ["c1", "c2", "c3", "c4", "c5"]) {
        yield* seedMessage(chat.id, "usr_alice", text, sameSecond);
      }

      const seen: string[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 5; page++) {
        const rows = yield* listMessages(chat.id, "usr_alice", { limit: 2, cursor });
        if (rows.length === 0) break;
        seen.push(...rows.map((r) => r.ciphertext!));
        cursor = rows[rows.length - 1]!.id;
      }

      expect(seen).toHaveLength(5);
      expect(seen.toSorted()).toEqual(["c1", "c2", "c3", "c4", "c5"]);
    }).pipe(Effect.provide(createTestLayer())),
  );

  // The happy path of the cursor branch. Every other `before:` case in this
  // file is a rejection, so without this the `conditions.push(...)` line has no
  // coverage at all — replacing the whole block with an unconditional failure
  // left the suite green.
  it.effect("listC2bMessages returns the page after a valid cursor", () =>
    Effect.gen(function* () {
      const chat = yield* provisionC2bChat({
        memberProfileIds: ["usr_a", "usr_b"],
        createdByProfileId: "usr_a",
      });
      const base = new Date(1_756_500_000_000);
      yield* seedC2bMessage(chat.id, "usr_a", "oldest", new Date(base.getTime()));
      yield* seedC2bMessage(chat.id, "usr_a", "middle", new Date(base.getTime() + 1000));
      yield* seedC2bMessage(chat.id, "usr_a", "newest", new Date(base.getTime() + 2000));

      const page1 = yield* listC2bMessages(chat.id, { limit: 2 });
      expect(page1.map((m) => m.body)).toEqual(["newest", "middle"]);

      const page2 = yield* listC2bMessages(chat.id, { limit: 2, before: page1[1]!.id });
      expect(page2.map((m) => m.body)).toEqual(["oldest"]);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("sendMessage returns exactly what a later read returns", () =>
    Effect.gen(function* () {
      const chat = yield* seedChat({ type: "group" });
      yield* seedMember(chat.id, "usr_alice", "admin");
      const returned = yield* sendMessage(chat.id, "usr_alice", {
        ciphertext: "dGVzdCBtZXNzYWdl",
        nonce: "YWJjZGVmMTIzNDU2",
      });
      const [stored] = yield* listMessages(chat.id, "usr_alice");
      expect(stored).toEqual(returned);
      expect(returned.createdAt.getTime() % 1000).toBe(0);
    }).pipe(Effect.provide(createTestLayer())),
  );
});
