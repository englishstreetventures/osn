import { describe, expect } from "vitest";
import { it } from "@effect/vitest";
import { Effect, Either } from "effect";
import { createTestLayer, seedChat, seedMember, seedMessage } from "../helpers/db";
import { sendMessage, listMessages } from "../../src/services/messages";

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
      expect(msg.senderUserId).toBe("usr_alice");
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

      yield* sendMessage(chat.id, "usr_alice", {
        ciphertext: "bXNnMQ==",
        nonce: "bm9uY2Ux",
      });
      // Small delay to ensure ordering by createdAt.
      yield* Effect.promise(() => new Promise((r) => setTimeout(r, 10)));
      yield* sendMessage(chat.id, "usr_alice", {
        ciphertext: "bXNnMg==",
        nonce: "bm9uY2Uy",
      });

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
});
