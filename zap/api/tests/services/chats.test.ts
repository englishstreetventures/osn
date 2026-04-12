import { describe, expect } from "vitest";
import { it } from "@effect/vitest";
import { Effect, Either } from "effect";
import { createTestLayer, seedChat, seedMember } from "../helpers/db";
import {
  createChat,
  getChat,
  listChats,
  updateChat,
  addMember,
  removeMember,
  getChatMembers,
} from "../../src/services/chats";

describe("chats service", () => {
  it.effect("createChat creates a group chat with creator as admin", () =>
    Effect.gen(function* () {
      const chat = yield* createChat({ type: "group", title: "Test Group" }, "usr_alice");
      expect(chat.id).toMatch(/^chat_/);
      expect(chat.type).toBe("group");
      expect(chat.title).toBe("Test Group");
      expect(chat.createdByUserId).toBe("usr_alice");

      // Creator should be an admin member.
      const members = yield* getChatMembers(chat.id);
      expect(members).toHaveLength(1);
      expect(members[0]!.userId).toBe("usr_alice");
      expect(members[0]!.role).toBe("admin");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("createChat creates a DM", () =>
    Effect.gen(function* () {
      const chat = yield* createChat({ type: "dm" }, "usr_alice");
      expect(chat.type).toBe("dm");
      expect(chat.title).toBeNull();
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("createChat creates an event chat with eventId", () =>
    Effect.gen(function* () {
      const chat = yield* createChat(
        { type: "event", title: "Event Chat", eventId: "evt_abc123" },
        "usr_alice",
      );
      expect(chat.type).toBe("event");
      expect(chat.eventId).toBe("evt_abc123");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("createChat adds initial members", () =>
    Effect.gen(function* () {
      const chat = yield* createChat(
        { type: "group", title: "With Members", memberUserIds: ["usr_bob", "usr_charlie"] },
        "usr_alice",
      );
      const members = yield* getChatMembers(chat.id);
      expect(members).toHaveLength(3); // alice (admin) + bob + charlie
      const userIds = members.map((m) => m.userId).sort();
      expect(userIds).toEqual(["usr_alice", "usr_bob", "usr_charlie"]);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("getChat returns existing chat", () =>
    Effect.gen(function* () {
      const created = yield* seedChat({ type: "group", title: "Fetch Me" });
      const fetched = yield* getChat(created.id);
      expect(fetched.id).toBe(created.id);
      expect(fetched.title).toBe("Fetch Me");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("getChat fails with ChatNotFound for missing id", () =>
    Effect.gen(function* () {
      const result = yield* Effect.either(getChat("chat_nonexistent"));
      expect(Either.isLeft(result)).toBe(true);
      if (Either.isLeft(result)) {
        expect(result.left._tag).toBe("ChatNotFound");
      }
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("listChats returns only chats the user is a member of", () =>
    Effect.gen(function* () {
      const chat1 = yield* seedChat({ type: "group", title: "Chat 1" });
      const chat2 = yield* seedChat({ type: "group", title: "Chat 2" });
      yield* seedChat({ type: "group", title: "Chat 3" });

      yield* seedMember(chat1.id, "usr_alice", "admin");
      yield* seedMember(chat2.id, "usr_alice");

      const result = yield* listChats("usr_alice");
      expect(result).toHaveLength(2);
      const ids = result.map((c) => c.id).sort();
      expect(ids).toEqual([chat1.id, chat2.id].sort());
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("listChats returns empty for user with no chats", () =>
    Effect.gen(function* () {
      const result = yield* listChats("usr_nobody");
      expect(result).toHaveLength(0);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("updateChat updates title", () =>
    Effect.gen(function* () {
      const chat = yield* seedChat({
        type: "group",
        title: "Old Title",
        createdByUserId: "usr_alice",
      });
      yield* seedMember(chat.id, "usr_alice", "admin");
      const updated = yield* updateChat(chat.id, { title: "New Title" }, "usr_alice");
      expect(updated.title).toBe("New Title");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("updateChat fails for non-admin", () =>
    Effect.gen(function* () {
      const chat = yield* seedChat({ type: "group", title: "Admin Only" });
      yield* seedMember(chat.id, "usr_bob");
      const result = yield* Effect.either(updateChat(chat.id, { title: "Nope" }, "usr_bob"));
      expect(Either.isLeft(result)).toBe(true);
      if (Either.isLeft(result)) {
        expect(result.left._tag).toBe("NotChatAdmin");
      }
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("addMember adds a new member", () =>
    Effect.gen(function* () {
      const chat = yield* seedChat({ type: "group" });
      yield* seedMember(chat.id, "usr_alice", "admin");
      const member = yield* addMember(chat.id, "usr_bob", "usr_alice");
      expect(member.userId).toBe("usr_bob");
      expect(member.role).toBe("member");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("addMember fails with AlreadyMember for duplicate", () =>
    Effect.gen(function* () {
      const chat = yield* seedChat({ type: "group" });
      yield* seedMember(chat.id, "usr_alice", "admin");
      yield* seedMember(chat.id, "usr_bob");
      const result = yield* Effect.either(addMember(chat.id, "usr_bob", "usr_alice"));
      expect(Either.isLeft(result)).toBe(true);
      if (Either.isLeft(result)) {
        expect(result.left._tag).toBe("AlreadyMember");
      }
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("removeMember removes a member", () =>
    Effect.gen(function* () {
      const chat = yield* seedChat({ type: "group" });
      yield* seedMember(chat.id, "usr_alice", "admin");
      yield* seedMember(chat.id, "usr_bob");
      yield* removeMember(chat.id, "usr_bob", "usr_alice");
      const members = yield* getChatMembers(chat.id);
      expect(members).toHaveLength(1);
      expect(members[0]!.userId).toBe("usr_alice");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("removeMember allows self-removal (leaving)", () =>
    Effect.gen(function* () {
      const chat = yield* seedChat({ type: "group" });
      yield* seedMember(chat.id, "usr_alice", "admin");
      yield* seedMember(chat.id, "usr_bob");
      yield* removeMember(chat.id, "usr_bob", "usr_bob");
      const members = yield* getChatMembers(chat.id);
      expect(members).toHaveLength(1);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("removeMember fails with NotChatMember for non-member", () =>
    Effect.gen(function* () {
      const chat = yield* seedChat({ type: "group" });
      yield* seedMember(chat.id, "usr_alice", "admin");
      const result = yield* Effect.either(removeMember(chat.id, "usr_nobody", "usr_alice"));
      expect(Either.isLeft(result)).toBe(true);
      if (Either.isLeft(result)) {
        expect(result.left._tag).toBe("NotChatMember");
      }
    }).pipe(Effect.provide(createTestLayer())),
  );

  // ── Validation error paths (T-E1) ────────────────────────────────────

  it.effect("createChat fails with ValidationError for oversized title", () =>
    Effect.gen(function* () {
      const result = yield* Effect.either(
        createChat({ type: "group", title: "X".repeat(201) }, "usr_alice"),
      );
      expect(Either.isLeft(result)).toBe(true);
      if (Either.isLeft(result)) {
        expect(result.left._tag).toBe("ValidationError");
      }
    }).pipe(Effect.provide(createTestLayer())),
  );

  // ── Authorization edge cases (T-S2) ─────────────────────────────────

  it.effect("removeMember fails with NotChatAdmin when non-admin removes another member", () =>
    Effect.gen(function* () {
      const chat = yield* seedChat({ type: "group" });
      yield* seedMember(chat.id, "usr_alice", "admin");
      yield* seedMember(chat.id, "usr_bob");
      yield* seedMember(chat.id, "usr_charlie");
      // Bob (non-admin) tries to remove Charlie.
      const result = yield* Effect.either(removeMember(chat.id, "usr_charlie", "usr_bob"));
      expect(Either.isLeft(result)).toBe(true);
      if (Either.isLeft(result)) {
        expect(result.left._tag).toBe("NotChatAdmin");
      }
    }).pipe(Effect.provide(createTestLayer())),
  );

  // ── Membership filtering (T-S3) ─────────────────────────────────────

  it.effect("listChats returns empty when chats exist but user is not a member", () =>
    Effect.gen(function* () {
      // Seed chats with other users as members.
      const chat1 = yield* seedChat({ type: "group", title: "Not Mine" });
      const chat2 = yield* seedChat({ type: "dm" });
      yield* seedMember(chat1.id, "usr_bob", "admin");
      yield* seedMember(chat2.id, "usr_charlie", "admin");

      const result = yield* listChats("usr_nobody");
      expect(result).toHaveLength(0);
    }).pipe(Effect.provide(createTestLayer())),
  );

  // ── getChatMembers standalone (T-U2) ────────────────────────────────

  it.effect("getChatMembers returns all members", () =>
    Effect.gen(function* () {
      const chat = yield* seedChat({ type: "group" });
      yield* seedMember(chat.id, "usr_alice", "admin");
      yield* seedMember(chat.id, "usr_bob");
      yield* seedMember(chat.id, "usr_charlie");
      const members = yield* getChatMembers(chat.id);
      expect(members).toHaveLength(3);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("getChatMembers fails with ChatNotFound for missing chat", () =>
    Effect.gen(function* () {
      const result = yield* Effect.either(getChatMembers("chat_nonexistent"));
      expect(Either.isLeft(result)).toBe(true);
      if (Either.isLeft(result)) {
        expect(result.left._tag).toBe("ChatNotFound");
      }
    }).pipe(Effect.provide(createTestLayer())),
  );
});
