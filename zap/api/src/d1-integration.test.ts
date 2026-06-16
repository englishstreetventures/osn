import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";

import type { D1Database as DrizzleD1 } from "@cloudflare/workers-types";
import { createD1Db } from "@shared/db-utils";
import { chatMembers, chats, messages } from "@zap/db/schema";
import * as schema from "@zap/db/schema";
import { Db } from "@zap/db/service";
import { createSchemaSql } from "@zap/db/testing";
import { Effect, Layer } from "effect";
import { Miniflare } from "miniflare";

import { createChat, listChats } from "./services/chats";
import { listMessages, sendMessage } from "./services/messages";

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
let rawDb: ReturnType<typeof createD1Db<typeof schema>>;

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
  rawDb = createD1Db(d1, schema);
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
});

describe("zap/api over real D1 (Miniflare)", () => {
  it("createChat then listChats round-trips across async D1", async () => {
    const chat = await run(createChat({ type: "group", title: "Trip" }, ALICE));
    expect(chat.type).toBe("group");
    expect(chat.title).toBe("Trip");

    const mine = await run(listChats(ALICE));
    expect(mine).toHaveLength(1);
    expect(mine[0]!.id).toBe(chat.id);
  });

  it("sendMessage then listMessages persists via the async driver", async () => {
    const chat = await run(createChat({ type: "dm" }, ALICE));
    // Bob must be a member to read; Alice (creator) is an admin member already.
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
});
