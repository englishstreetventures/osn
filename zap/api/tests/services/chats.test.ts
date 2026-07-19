import { it } from "@effect/vitest";
import { Effect, Either } from "effect";
import { describe, expect, beforeEach, afterEach } from "vitest";

import {
  createChat,
  getChat,
  listChats,
  updateChat,
  addMember,
  removeMember,
  getChatMembers,
  provisionC2bChat,
} from "../../src/services/chats";
import { setConsentGate, resetConsentGate } from "../../src/services/consent";
import { createTestLayer, seedChat, seedMember } from "../helpers/db";

describe("chats service", () => {
  // The CRUD suite exercises membership/admin logic, not the social graph, so
  // default the consent gate to always-allow. The dedicated consent suite
  // below overrides it per-case. Reset after each test so leakage can't mask
  // a fail-closed regression.
  beforeEach(() => setConsentGate(() => Promise.resolve(true)));
  afterEach(() => resetConsentGate());

  it.effect("createChat creates a group chat with creator as admin", () =>
    Effect.gen(function* () {
      const chat = yield* createChat({ type: "group", title: "Test Group" }, "usr_alice");
      expect(chat.id).toMatch(/^chat_/);
      expect(chat.type).toBe("group");
      expect(chat.title).toBe("Test Group");
      expect(chat.createdByProfileId).toBe("usr_alice");

      // Creator should be an admin member.
      const { members } = yield* getChatMembers(chat.id);
      expect(members).toHaveLength(1);
      expect(members[0]!.profileId).toBe("usr_alice");
      expect(members[0]!.role).toBe("admin");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("createChat creates a DM with exactly two members", () =>
    Effect.gen(function* () {
      const chat = yield* createChat({ type: "dm", memberProfileIds: ["usr_bob"] }, "usr_alice");
      expect(chat.type).toBe("dm");
      expect(chat.title).toBeNull();
      const { members } = yield* getChatMembers(chat.id);
      expect(members).toHaveLength(2);
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
        { type: "group", title: "With Members", memberProfileIds: ["usr_bob", "usr_charlie"] },
        "usr_alice",
      );
      const { members } = yield* getChatMembers(chat.id);
      expect(members).toHaveLength(3); // alice (admin) + bob + charlie
      const userIds = members.map((m) => m.profileId).toSorted();
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

      const { chats: result } = yield* listChats("usr_alice");
      expect(result).toHaveLength(2);
      const ids = result.map((c) => c.id).toSorted();
      expect(ids).toEqual([chat1.id, chat2.id].toSorted());
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("listChats returns empty for user with no chats", () =>
    Effect.gen(function* () {
      const { chats: result } = yield* listChats("usr_nobody");
      expect(result).toHaveLength(0);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("updateChat updates title", () =>
    Effect.gen(function* () {
      const chat = yield* seedChat({
        type: "group",
        title: "Old Title",
        createdByProfileId: "usr_alice",
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
      expect(member.profileId).toBe("usr_bob");
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
      const { members } = yield* getChatMembers(chat.id);
      expect(members).toHaveLength(1);
      expect(members[0]!.profileId).toBe("usr_alice");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("removeMember allows self-removal (leaving)", () =>
    Effect.gen(function* () {
      const chat = yield* seedChat({ type: "group" });
      yield* seedMember(chat.id, "usr_alice", "admin");
      yield* seedMember(chat.id, "usr_bob");
      yield* removeMember(chat.id, "usr_bob", "usr_bob");
      const { members } = yield* getChatMembers(chat.id);
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

      const { chats: result } = yield* listChats("usr_nobody");
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
      const { members } = yield* getChatMembers(chat.id);
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

  // ── Z3/Z4 consent matrix ────────────────────────────────────────────────

  it.effect("addMember allowed when the actor and target are connected", () =>
    Effect.gen(function* () {
      setConsentGate(() => Promise.resolve(true));
      const chat = yield* seedChat({ type: "group" });
      yield* seedMember(chat.id, "usr_alice", "admin");
      const member = yield* addMember(chat.id, "usr_bob", "usr_alice");
      expect(member.profileId).toBe("usr_bob");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("addMember rejected with ConsentDenied when not connected", () =>
    Effect.gen(function* () {
      setConsentGate(() => Promise.resolve(false));
      const chat = yield* seedChat({ type: "group" });
      yield* seedMember(chat.id, "usr_alice", "admin");
      const result = yield* Effect.either(addMember(chat.id, "usr_bob", "usr_alice"));
      expect(Either.isLeft(result)).toBe(true);
      if (Either.isLeft(result)) {
        expect(result.left._tag).toBe("ConsentDenied");
        if (result.left._tag === "ConsentDenied") {
          expect(result.left.reason).toBe("not_connected");
        }
      }
      // No member should have been inserted.
      const { members } = yield* getChatMembers(chat.id);
      expect(members).toHaveLength(1);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("addMember fails closed (ConsentDenied/graph_unreachable) when the graph throws", () =>
    Effect.gen(function* () {
      setConsentGate(() => Promise.reject(new Error("ECONNREFUSED")));
      const chat = yield* seedChat({ type: "group" });
      yield* seedMember(chat.id, "usr_alice", "admin");
      const result = yield* Effect.either(addMember(chat.id, "usr_bob", "usr_alice"));
      expect(Either.isLeft(result)).toBe(true);
      if (Either.isLeft(result)) {
        expect(result.left._tag).toBe("ConsentDenied");
        if (result.left._tag === "ConsentDenied") {
          expect(result.left.reason).toBe("graph_unreachable");
        }
      }
      const { members } = yield* getChatMembers(chat.id);
      expect(members).toHaveLength(1);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect(
    "createChat rejects when an initial member is not connected (no chat left behind)",
    () =>
      Effect.gen(function* () {
        setConsentGate(() => Promise.resolve(false));
        const result = yield* Effect.either(
          createChat({ type: "group", title: "Spam", memberProfileIds: ["usr_bob"] }, "usr_alice"),
        );
        expect(Either.isLeft(result)).toBe(true);
        if (Either.isLeft(result)) {
          expect(result.left._tag).toBe("ConsentDenied");
        }
        // The chat must not have been created.
        const { chats: mine } = yield* listChats("usr_alice");
        expect(mine).toHaveLength(0);
      }).pipe(Effect.provide(createTestLayer())),
  );

  // ── Z3 DM member-count invariant ────────────────────────────────────────

  it.effect("createChat rejects a DM with no other member", () =>
    Effect.gen(function* () {
      const result = yield* Effect.either(createChat({ type: "dm" }, "usr_alice"));
      expect(Either.isLeft(result)).toBe(true);
      if (Either.isLeft(result)) {
        expect(result.left._tag).toBe("InvalidDmMembership");
      }
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("createChat rejects a DM with more than two members", () =>
    Effect.gen(function* () {
      const result = yield* Effect.either(
        createChat({ type: "dm", memberProfileIds: ["usr_bob", "usr_charlie"] }, "usr_alice"),
      );
      expect(Either.isLeft(result)).toBe(true);
      if (Either.isLeft(result)) {
        expect(result.left._tag).toBe("InvalidDmMembership");
      }
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("addMember rejects widening a DM into a group", () =>
    Effect.gen(function* () {
      const chat = yield* seedChat({ type: "dm" });
      yield* seedMember(chat.id, "usr_alice", "admin");
      yield* seedMember(chat.id, "usr_bob");
      const result = yield* Effect.either(addMember(chat.id, "usr_charlie", "usr_alice"));
      expect(Either.isLeft(result)).toBe(true);
      if (Either.isLeft(result)) {
        expect(result.left._tag).toBe("InvalidDmMembership");
      }
    }).pipe(Effect.provide(createTestLayer())),
  );

  // ── Z5 last-admin invariant ─────────────────────────────────────────────

  it.effect("removeMember rejects removing the only admin", () =>
    Effect.gen(function* () {
      const chat = yield* seedChat({ type: "group" });
      yield* seedMember(chat.id, "usr_alice", "admin");
      yield* seedMember(chat.id, "usr_bob");
      const result = yield* Effect.either(removeMember(chat.id, "usr_alice", "usr_alice"));
      expect(Either.isLeft(result)).toBe(true);
      if (Either.isLeft(result)) {
        expect(result.left._tag).toBe("LastAdmin");
      }
      const { members } = yield* getChatMembers(chat.id);
      expect(members).toHaveLength(2);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("removeMember allows removing an admin when another admin remains", () =>
    Effect.gen(function* () {
      const chat = yield* seedChat({ type: "group" });
      yield* seedMember(chat.id, "usr_alice", "admin");
      yield* seedMember(chat.id, "usr_bob", "admin");
      yield* removeMember(chat.id, "usr_alice", "usr_bob");
      const { members } = yield* getChatMembers(chat.id);
      expect(members).toHaveLength(1);
      expect(members[0]!.profileId).toBe("usr_bob");
    }).pipe(Effect.provide(createTestLayer())),
  );

  // ── P-W1 listChats pagination ───────────────────────────────────────────

  it.effect("listChats applies the default limit (50) and returns newest first", () =>
    Effect.gen(function* () {
      const base = Date.now();
      for (let i = 0; i < 55; i++) {
        const chat = yield* seedChat({
          type: "group",
          title: `Chat ${i}`,
          createdAt: new Date(base + i * 1000),
        });
        yield* seedMember(chat.id, "usr_alice");
      }
      const { chats: page } = yield* listChats("usr_alice");
      expect(page).toHaveLength(50);
      // Newest first — the oldest 5 fall off the first page.
      expect(page[0]!.title).toBe("Chat 54");
      expect(page[49]!.title).toBe("Chat 5");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("listChats respects an explicit limit and clamps above the max (100)", () =>
    Effect.gen(function* () {
      const base = Date.now();
      for (let i = 0; i < 105; i++) {
        const chat = yield* seedChat({
          type: "group",
          title: `Chat ${i}`,
          createdAt: new Date(base + i * 1000),
        });
        yield* seedMember(chat.id, "usr_alice");
      }
      const { chats: small } = yield* listChats("usr_alice", { limit: 2 });
      expect(small).toHaveLength(2);
      expect(small[0]!.title).toBe("Chat 104");
      expect(small[1]!.title).toBe("Chat 103");

      const { chats: clamped } = yield* listChats("usr_alice", { limit: 9999 });
      expect(clamped).toHaveLength(100);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("listChats supports cursor-based pagination", () =>
    Effect.gen(function* () {
      const base = Date.now();
      for (let i = 0; i < 5; i++) {
        const chat = yield* seedChat({
          type: "group",
          title: `Chat ${i}`,
          createdAt: new Date(base + i * 1000),
        });
        yield* seedMember(chat.id, "usr_alice");
      }
      const page1 = yield* listChats("usr_alice", { limit: 2 });
      expect(page1.chats.map((c) => c.title)).toEqual(["Chat 4", "Chat 3"]);
      // P-I4: continuation metadata — nextCursor is the last row of the page.
      expect(page1.hasMore).toBe(true);
      expect(page1.nextCursor).toBe(page1.chats[1]!.id);

      const page2 = yield* listChats("usr_alice", { limit: 2, cursor: page1.nextCursor! });
      expect(page2.chats.map((c) => c.title)).toEqual(["Chat 2", "Chat 1"]);
      expect(page2.hasMore).toBe(true);

      const page3 = yield* listChats("usr_alice", { limit: 2, cursor: page2.nextCursor! });
      expect(page3.chats.map((c) => c.title)).toEqual(["Chat 0"]);
      expect(page3.hasMore).toBe(false);
      expect(page3.nextCursor).toBeNull();

      // Cursor at the oldest chat: past the end — empty page, not an error.
      const page4 = yield* listChats("usr_alice", { limit: 2, cursor: page3.chats[0]!.id });
      expect(page4.chats).toHaveLength(0);
      expect(page4.hasMore).toBe(false);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("listChats does not skip chats created in the same second (P-W2)", () =>
    Effect.gen(function* () {
      // Creation bursts share a second-resolution createdAt; the composite
      // (createdAt, id) cursor must still walk every chat exactly once.
      const ts = new Date(Math.floor(Date.now() / 1000) * 1000);
      const ids: string[] = [];
      for (let i = 0; i < 5; i++) {
        const chat = yield* seedChat({ type: "group", title: `Burst ${i}`, createdAt: ts });
        yield* seedMember(chat.id, "usr_alice");
        ids.push(chat.id);
      }
      const seen: string[] = [];
      let cursor: string | undefined;
      for (;;) {
        const page = yield* listChats("usr_alice", { limit: 2, cursor });
        seen.push(...page.chats.map((c) => c.id));
        if (!page.hasMore) break;
        cursor = page.nextCursor!;
      }
      // Every burst chat appears exactly once — no drops, no repeats.
      expect(seen.toSorted()).toEqual(ids.toSorted());
      expect(new Set(seen).size).toBe(ids.length);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("listChats rejects an unknown cursor instead of returning page 1", () =>
    Effect.gen(function* () {
      const chat = yield* seedChat({ type: "group" });
      yield* seedMember(chat.id, "usr_alice");
      const result = yield* Effect.either(
        listChats("usr_alice", { cursor: "chat_does_not_exist" }),
      );
      expect(Either.isLeft(result)).toBe(true);
      if (Either.isLeft(result)) {
        expect(result.left._tag).toBe("ValidationError");
      }
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("listChats rejects a cursor naming a chat the caller is not a member of", () =>
    Effect.gen(function* () {
      const mine = yield* seedChat({ type: "group", title: "Mine" });
      yield* seedMember(mine.id, "usr_alice");
      const foreign = yield* seedChat({ type: "group", title: "Not Mine" });
      yield* seedMember(foreign.id, "usr_bob", "admin");

      // A cursor minted from someone else's chat must not paginate (or probe)
      // the caller's list.
      const result = yield* Effect.either(listChats("usr_alice", { cursor: foreign.id }));
      expect(Either.isLeft(result)).toBe(true);
      if (Either.isLeft(result)) {
        expect(result.left._tag).toBe("ValidationError");
      }
    }).pipe(Effect.provide(createTestLayer())),
  );

  // ── P-W2 addMember member-count invariant (COUNT(*) path) ────────────────

  it.effect("addMember rejects with MemberLimitReached at the member cap", () =>
    Effect.gen(function* () {
      const chat = yield* seedChat({ type: "group" });
      yield* seedMember(chat.id, "usr_alice", "admin");
      // Fill to the 500-member cap (alice + 499 others).
      for (let i = 0; i < 499; i++) {
        yield* seedMember(chat.id, `usr_filler_${i}`);
      }
      const result = yield* Effect.either(addMember(chat.id, "usr_overflow", "usr_alice"));
      expect(Either.isLeft(result)).toBe(true);
      if (Either.isLeft(result)) {
        expect(result.left._tag).toBe("MemberLimitReached");
      }
    }).pipe(Effect.provide(createTestLayer())),
  );

  // ── P-W4 getChatMembers pagination ────────────────────────────────────────

  it.effect("getChatMembers applies the default limit (100)", () =>
    Effect.gen(function* () {
      const chat = yield* seedChat({ type: "group" });
      for (let i = 0; i < 105; i++) {
        yield* seedMember(chat.id, `usr_member_${i}`);
      }
      const { members: page } = yield* getChatMembers(chat.id);
      expect(page).toHaveLength(100);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("getChatMembers pages with limit/offset without overlap or gaps", () =>
    Effect.gen(function* () {
      const chat = yield* seedChat({ type: "group" });
      yield* seedMember(chat.id, "usr_alice", "admin");
      for (let i = 0; i < 4; i++) {
        yield* seedMember(chat.id, `usr_member_${i}`);
      }
      const { members: all } = yield* getChatMembers(chat.id);
      expect(all).toHaveLength(5);

      const { members: page1 } = yield* getChatMembers(chat.id, { limit: 2, offset: 0 });
      const { members: page2 } = yield* getChatMembers(chat.id, { limit: 2, offset: 2 });
      const { members: page3 } = yield* getChatMembers(chat.id, { limit: 2, offset: 4 });
      expect(page1.map((m) => m.id)).toEqual(all.slice(0, 2).map((m) => m.id));
      expect(page2.map((m) => m.id)).toEqual(all.slice(2, 4).map((m) => m.id));
      expect(page3.map((m) => m.id)).toEqual(all.slice(4, 5).map((m) => m.id));
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("getChatMembers returns empty for an offset beyond the end", () =>
    Effect.gen(function* () {
      const chat = yield* seedChat({ type: "group" });
      yield* seedMember(chat.id, "usr_alice", "admin");
      const { members: page } = yield* getChatMembers(chat.id, { limit: 10, offset: 50 });
      expect(page).toHaveLength(0);
    }).pipe(Effect.provide(createTestLayer())),
  );

  // ── c2b provisioning (Task 3) ───────────────────────────────────────────

  it.effect("provisionC2bChat creates a class='c2b', type='group' chat with all members", () =>
    Effect.gen(function* () {
      const chat = yield* provisionC2bChat({
        memberProfileIds: ["usr_a", "usr_b"],
        createdByProfileId: "usr_a",
      });
      expect(chat.class).toBe("c2b");
      expect(chat.type).toBe("group");
      // Both members present.
      const { members } = yield* getChatMembers(chat.id);
      expect(members).toHaveLength(2);
      const profileIds = members.map((m) => m.profileId).toSorted();
      expect(profileIds).toEqual(["usr_a", "usr_b"]);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("provisionC2bChat rejects <2 members", () =>
    Effect.gen(function* () {
      const result = yield* Effect.either(
        provisionC2bChat({ memberProfileIds: ["usr_a"], createdByProfileId: "usr_a" }),
      );
      expect(Either.isLeft(result)).toBe(true);
      if (Either.isLeft(result)) {
        expect(result.left._tag).toBe("ValidationError");
      }
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("provisionC2bChat includes a title when provided", () =>
    Effect.gen(function* () {
      const chat = yield* provisionC2bChat({
        memberProfileIds: ["usr_a", "usr_b"],
        createdByProfileId: "usr_a",
        title: "Enquiry #1",
      });
      expect(chat.title).toBe("Enquiry #1");
    }).pipe(Effect.provide(createTestLayer())),
  );
});
