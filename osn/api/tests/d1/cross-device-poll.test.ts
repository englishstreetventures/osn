import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from "bun:test";

import type { D1Database as DrizzleD1 } from "@cloudflare/workers-types";
import { accounts, sessions } from "@osn/db/schema";
import { Db } from "@osn/db/service";
import { createSchemaSql } from "@osn/db/testing";
import { createD1Db } from "@shared/db-utils";
import { type EmailService, makeLogEmailLive } from "@shared/email";
import { eq } from "drizzle-orm";
import { Effect, Layer } from "effect";
import { Miniflare } from "miniflare";

import { createAuthService } from "../../src/services/auth";
import { hashSessionToken } from "../../src/services/auth/helpers";
import { makeTestAuthConfig } from "../helpers/auth-config";

/**
 * The cross-device poll on real D1. It turns the reserved row into device B's
 * session in one batch with the profile read, which D1 runs as one
 * transaction and answers with each statement's result. bun:sqlite runs the
 * statements one by one and shapes their results its own way, so what depends
 * on D1 is proven here: the batch's change count and the joined profile row
 * read as the poll expects, and the guard refuses a deleted account.
 */

const MF_TIMEOUT_MS = 30_000;
setDefaultTimeout(MF_TIMEOUT_MS);

let mf: Miniflare;
let db: ReturnType<typeof createD1Db>;
let layer: Layer.Layer<Db | EmailService>;
let auth: ReturnType<typeof createAuthService>;

const run = <A, E>(eff: Effect.Effect<A, E, Db | EmailService>) =>
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
  layer = Layer.merge(Layer.succeed(Db, { db }), makeLogEmailLive().layer);
  auth = createAuthService(await makeTestAuthConfig());
});

afterAll(async () => {
  await mf?.dispose();
});

/** An account and a cross-device request it has approved. */
async function approved(email: string, handle: string) {
  return run(
    Effect.gen(function* () {
      const profile = yield* auth.registerProfile(email, handle);
      const request = yield* auth.beginCrossDeviceLogin({ uaLabel: "Device B" });
      yield* auth.approveCrossDeviceLogin(request.requestId, request.cdlSecret, profile.accountId);
      return { profile, ...request };
    }),
  );
}

const rowsOf = (accountId: string) =>
  db.select().from(sessions).where(eq(sessions.accountId, accountId));

describe("the cross-device poll on D1", () => {
  it("turns the reserved row into device B's session, which refreshes", async () => {
    const { profile, requestId, cdlSecret } = await approved("cdl-d1@example.com", "cdld1");
    const poll = await run(auth.getCrossDeviceLoginStatus(requestId, cdlSecret));
    if (poll.status !== "approved") throw new Error(`poll answered ${poll.status}`);
    expect(poll.profile).toMatchObject({
      id: profile.id,
      handle: "cdld1",
      email: "cdl-d1@example.com",
    });
    const claims = JSON.parse(
      Buffer.from(poll.session.accessToken.split(".")[1]!, "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    expect(claims["sub"]).toBe(profile.id);

    const rows = await rowsOf(profile.accountId);
    expect(rows.map((row) => row.id)).toEqual([hashSessionToken(poll.session.refreshToken)]);
    expect(rows[0]!.familyId).toMatch(/^sfam_/);
    expect(rows[0]!.uaLabel).toBe("Device B");

    const rotated = await run(auth.refreshTokens(poll.session.refreshToken));
    expect(rotated.refreshToken).not.toBe(poll.session.refreshToken);
  });

  it("refuses an account scheduled for deletion, and leaves no row behind", async () => {
    const { profile, requestId, cdlSecret } = await approved(
      "cdl-d1-gone@example.com",
      "cdld1gone",
    );
    await db
      .update(accounts)
      .set({ deletedAt: Math.floor(Date.now() / 1000) })
      .where(eq(accounts.id, profile.accountId));

    const poll = await run(auth.getCrossDeviceLoginStatus(requestId, cdlSecret));
    expect(poll).toEqual({ status: "expired" });
    expect(await rowsOf(profile.accountId)).toEqual([]);
  });
});
