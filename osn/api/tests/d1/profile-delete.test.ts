import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from "bun:test";

import type { D1Database as DrizzleD1 } from "@cloudflare/workers-types";
import { accounts, users } from "@osn/db/schema";
import { Db } from "@osn/db/service";
import { createSchemaSql } from "@osn/db/testing";
import { createD1Db } from "@shared/db-utils";
import { eq } from "drizzle-orm";
import { Effect, Layer } from "effect";
import { Miniflare } from "miniflare";

import { createAuthService } from "../../src/services/auth";
import { createProfileService } from "../../src/services/profile";
import { makeTestAuthConfig } from "../helpers/auth-config";
import { holdQueries } from "../helpers/held-query";

/**
 * A profile delete on real D1 (Miniflare), where its batch commits whole or
 * not at all: another delete or default change landing between its reads and
 * its batch leaves the account with exactly one default profile, and never
 * with no profile. Each test holds one request's batch and runs the other
 * first.
 */

setDefaultTimeout(30_000);

let mf: Miniflare;
let db: ReturnType<typeof createD1Db>;
let hold: ReturnType<typeof holdQueries>["hold"];
let layer: Layer.Layer<Db>;
let profiles: ReturnType<typeof createProfileService>;

const run = <A, E>(eff: Effect.Effect<A, E, Db>): Promise<A> =>
  Effect.runPromise(eff.pipe(Effect.provide(layer)));

beforeAll(async () => {
  mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } };",
    d1Databases: { DB: ":memory:" },
  });
  const d1 = (await mf.getD1Database("DB")) as unknown as DrizzleD1;
  for (const stmt of createSchemaSql()) {
    await d1.prepare(stmt).run();
  }
  db = createD1Db(d1);
  const held = holdQueries(db);
  hold = held.hold;
  layer = Layer.succeed(Db, { db: held.db });
  profiles = createProfileService(createAuthService(await makeTestAuthConfig()));
});

afterAll(async () => {
  await mf?.dispose();
});

const newId = (prefix: string) => `${prefix}${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;

/** An account whose profiles are created a second apart, in order; the first is the default. */
async function account(...handles: string[]) {
  const accountId = newId("acc_");
  await db.insert(accounts).values({
    id: accountId,
    email: `${handles[0]}@example.com`,
    passkeyUserId: crypto.randomUUID(),
    createdAt: new Date(1_000),
    updatedAt: new Date(1_000),
  });
  const ids: string[] = [];
  for (const [i, handle] of handles.entries()) {
    const id = newId("usr_");
    await db.insert(users).values({
      id,
      accountId,
      handle,
      displayName: null,
      avatarUrl: null,
      isDefault: i === 0,
      createdAt: new Date((i + 1) * 1_000),
      updatedAt: new Date((i + 1) * 1_000),
    });
    ids.push(id);
  }
  return { accountId, ids };
}

/** Each of the account's profiles and whether it is the default. */
async function defaults(accountId: string) {
  const rows = await db
    .select({ id: users.id, isDefault: users.isDefault })
    .from(users)
    .where(eq(users.accountId, accountId));
  return Object.fromEntries(rows.map((r) => [r.id, r.isDefault]));
}

describe("deleteProfile against another request on D1", () => {
  it("two deletes of an account's last two profiles leave one, still the default", async () => {
    const { accountId, ids } = await account("d1pair_main", "d1pair_alt");
    const [main, alt] = ids as [string, string];

    const batch = hold(/^delete from "connections"/);
    const first = run(Effect.result(profiles.deleteProfile(accountId, main)));
    await batch.reached;
    expect(await run(profiles.deleteProfile(accountId, alt))).toEqual({ defaultProfileId: main });
    batch.release();

    expect(await first).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "AuthError", message: "Cannot delete the last profile" },
    });
    expect(await defaults(accountId)).toEqual({ [main]: true });
  });

  it("a delete of the default landing after another profile is made the default keeps that one", async () => {
    const { accountId, ids } = await account("d1swap_main", "d1swap_older", "d1swap_chosen");
    const [main, older, chosen] = ids as [string, string, string];

    const batch = hold(/^delete from "connections"/);
    const deleting = run(Effect.result(profiles.deleteProfile(accountId, main)));
    await batch.reached;
    await run(profiles.setDefaultProfile(accountId, chosen));
    batch.release();

    expect(await deleting).toMatchObject({
      _tag: "Success",
      success: { defaultProfileId: chosen },
    });
    expect(await defaults(accountId)).toEqual({ [older]: false, [chosen]: true });
  });
});
