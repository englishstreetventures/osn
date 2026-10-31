import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";

import type { D1Database as DrizzleD1 } from "@cloudflare/workers-types";
import { createD1Db } from "@shared/db-utils";
import { chatMembers, chats, messages } from "@zap/db/schema";
import { Db } from "@zap/db/service";
import { createSchemaSql } from "@zap/db/testing";
import { eq, sql } from "drizzle-orm";
import { Effect, Layer } from "effect";
import { Miniflare } from "miniflare";

import { MAX_CHAT_MEMBERS } from "../../src/lib/limits";
import {
  addMember,
  createChat,
  getChatMembers,
  listChats,
  removeMember,
  updateChat,
} from "../../src/services/chats";
import { resetConsentGate, setConsentGate } from "../../src/services/consent";
import { listMessages, sendMessage } from "../../src/services/messages";
import { holdQueries } from "../helpers/held-query";

// Integration tests against a REAL (workerd-backed) D1 database via Miniflare.
// The rest of the Zap suite runs on synchronous bun:sqlite; these exercise the
// ASYNCHRONOUS D1 driver path that the `dev` / `staging` / `prod` environments
// actually use — awaited `.values()` / `.select()` through the broadened `Db`
// type. This is the only coverage of that path.

// Schema setup and FK-safe truncation are inherently sequential here.
/* eslint-disable no-await-in-loop */

const ALICE = "usr_alice";
const BOB = "usr_bob";

let mf: Miniflare;
let layer: Layer.Layer<Db>;
let rawDb: ReturnType<typeof createD1Db>;

const run = <A, E>(eff: Effect.Effect<A, E, Db>): Promise<A> =>
  Effect.runPromise(eff.pipe(Effect.provide(layer)));

beforeAll(async () => {
  mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } };",
    d1Databases: { DB: ":memory:" },
  });
  const d1 = (await mf.getD1Database("DB")) as unknown as DrizzleD1;
  // Apply the reflected schema statement-by-statement — D1's `exec` splits on
  // newlines, which breaks multi-line CREATE TABLEs, so prepare/run each.
  for (const stmt of createSchemaSql()) {
    await d1.prepare(stmt).run();
  }
  rawDb = createD1Db(d1);
  layer = Layer.succeed(Db, { db: rawDb });
});

afterAll(async () => {
  await mf?.dispose();
});

beforeEach(async () => {
  // FK-safe truncate keeps each test isolated on the shared D1.
  for (const table of [messages, chatMembers, chats]) {
    await rawDb.delete(table);
  }
  // Restore the real ARC-backed gate so a test that stubs it can't leak.
  resetConsentGate();
});

describe("zap/api over real D1 (Miniflare)", () => {
  it("createChat then listChats round-trips across async D1", async () => {
    const chat = await run(createChat({ type: "group", title: "Trip" }, ALICE));
    expect(chat.type).toBe("group");
    expect(chat.title).toBe("Trip");

    const mine = await run(listChats(ALICE));
    expect(mine.chats).toHaveLength(1);
    expect(mine.chats[0]!.id).toBe(chat.id);
  });

  it("sendMessage then listMessages persists via the async driver", async () => {
    // A DM is exactly two people, so the second member is required — a bare
    // `{ type: "dm" }` now fails `InvalidDmMembership`. Z4 then graph-gates every
    // member, fail-closed, so the consent gate has to be stubbed open (this suite
    // is about the async D1 driver, not the graph).
    setConsentGate(() => Promise.resolve(true));
    const chat = await run(createChat({ type: "dm", memberProfileIds: [BOB] }, ALICE));
    const sent = await run(
      sendMessage(chat.id, ALICE, { ciphertext: "deadbeef", nonce: "nonce123" }),
    );
    expect(sent.chatId).toBe(chat.id);

    const msgs = await run(listMessages(chat.id, ALICE));
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.ciphertext).toBe("deadbeef");
  });

  it("rejects a message from a non-member over async D1", async () => {
    const chat = await run(createChat({ type: "group", title: "Private" }, ALICE));
    await expect(
      run(sendMessage(chat.id, BOB, { ciphertext: "ff", nonce: "n" })),
    ).rejects.toThrow();
  });

  // The removal answers from its delete's change count, which D1 reports under
  // `meta.changes`: a removal that went through, and the last admin refused.
  it("removeMember removes a member, and refuses the last admin, over async D1", async () => {
    setConsentGate(() => Promise.resolve(true));
    const chat = await run(createChat({ type: "group", title: "Leaving" }, ALICE));
    await run(addMember(chat.id, BOB, ALICE));

    await run(removeMember(chat.id, BOB, ALICE));
    const refused = await run(Effect.flip(removeMember(chat.id, ALICE, ALICE)));
    expect(refused._tag).toBe("LastAdmin");

    const { members } = await run(getChatMembers(chat.id));
    expect(members.map((m) => [m.profileId, m.role])).toEqual([[ALICE, "admin"]]);
  });

  // The rename answers from its update's change count, which D1 reports under
  // `meta.changes`.
  it("updateChat renames the chat for its admin over async D1", async () => {
    const chat = await run(createChat({ type: "group", title: "Before" }, ALICE));

    expect((await run(updateChat(chat.id, { title: "After" }, ALICE))).title).toBe("After");
    const mine = await run(listChats(ALICE));
    expect(mine.chats[0]!.title).toBe("After");
  });

  // The add answers from its insert's change count, which D1 reports under
  // `meta.changes`: one for an add that went in, none for one the cap refused
  // at the write.
  it("addMember holds the member cap in its insert over async D1", async () => {
    setConsentGate(() => Promise.resolve(true));
    const chat = await run(createChat({ type: "group", title: "Full" }, ALICE));
    // Alice and the fillers: one member short of the cap.
    await rawDb.run(
      sql`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${MAX_CHAT_MEMBERS - 2})
          INSERT INTO chat_members (id, chat_id, profile_id, role, joined_at)
          SELECT 'cmem_seed_' || i, ${chat.id}, 'usr_seed_' || i, 'member', 0 FROM n`,
    );
    const queries = holdQueries(rawDb);
    const heldLayer = Layer.succeed(Db, { db: queries.db });
    const runHeld = <A, E>(eff: Effect.Effect<A, E, Db>): Promise<A> =>
      Effect.runPromise(eff.pipe(Effect.provide(heldLayer)));

    const insert = queries.hold(/^insert into "chat_members"/);
    const adding = runHeld(Effect.flip(addMember(chat.id, "usr_dave", ALICE)));
    await insert.reached;
    const erin = await runHeld(addMember(chat.id, "usr_erin", ALICE));
    insert.release();

    expect(erin.profileId).toBe("usr_erin");
    expect((await adding)._tag).toBe("MemberLimitReached");
    const members = await rawDb
      .select({ profileId: chatMembers.profileId })
      .from(chatMembers)
      .where(eq(chatMembers.chatId, chat.id));
    expect(members).toHaveLength(MAX_CHAT_MEMBERS);
    expect(members.map((m) => m.profileId)).not.toContain("usr_dave");
  });
});
