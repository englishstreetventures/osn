import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from "bun:test";

import type { D1Database, ExecutionContext, R2Bucket } from "@cloudflare/workers-types";
import { makeDbD1Live } from "@osn/db/service";
import { createSchemaSql } from "@osn/db/testing";
import { generateArcKeyPair } from "@shared/crypto/jwk";
import { makeLogEmailLive } from "@shared/email";
import { Effect, Layer } from "effect";
import { exportJWK } from "jose";
import { Miniflare } from "miniflare";

import { buildAppDeps } from "../../src/build-deps";
import { handler, type Env } from "../../src/index";
import { createInMemoryCoordination } from "../../src/lib/coordination/memory";
import { createAuthService } from "../../src/services/auth";
import { createProfileService } from "../../src/services/profile";
import { createFakeNamespace } from "../helpers/coordination-namespace";

/**
 * The Worker's own `fetch` hands its `DELETION_RECORDS` binding to the routes,
 * so a profile deletion lands in the bucket production binds. Every other
 * deletion-record test builds the routes with an in-memory store, and the
 * end-to-end suite runs the Bun entry, so without this a broken binding would
 * show first as every deletion answering 503 on dev.
 */

setDefaultTimeout(30_000);

const ORIGIN = "http://localhost:5173";
const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString("base64");

let mf: Miniflare;
let env: Env;
let bucket: R2Bucket;

beforeAll(async () => {
  mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } };",
    d1Databases: { DB: ":memory:" },
    r2Buckets: ["DELETION_RECORDS"],
  });
  const d1 = (await mf.getD1Database("DB")) as unknown as D1Database;
  for (const stmt of createSchemaSql()) {
    // eslint-disable-next-line no-await-in-loop -- DDL in foreign-key order
    await d1.prepare(stmt).run();
  }
  bucket = (await mf.getR2Bucket("DELETION_RECORDS")) as unknown as R2Bucket;
  const { privateKey, publicKey } = await generateArcKeyPair();
  env = {
    DB: d1,
    COORDINATION: createFakeNamespace().ns,
    DELETION_RECORDS: bucket,
    OSN_JWT_PRIVATE_KEY: b64(await exportJWK(privateKey)),
    OSN_JWT_PUBLIC_KEY: b64(await exportJWK(publicKey)),
    TRUSTED_PROXY_COUNT: "1",
    OSN_CORS_ORIGIN: ORIGIN,
  } as Env;
});

afterAll(async () => {
  await mf?.dispose();
});

describe("the Worker entry's deletion records", () => {
  it("records a profile deletion in the bucket bound as DELETION_RECORDS", async () => {
    // An account with two profiles, written to the same D1 database, and an
    // access token signed with the key the Worker reads from `env`.
    const layer = Layer.merge(makeDbD1Live(env.DB as D1Database), makeLogEmailLive().layer);
    const built = await buildAppDeps(env as Record<string, string | undefined>, {
      coordination: () => createInMemoryCoordination(),
      dbAndEmailLayer: layer,
      observabilityLayer: Layer.empty,
      includeObservabilityPlugin: false,
    });
    const auth = createAuthService(built.deps.authConfig);
    const run = <A, E>(effect: Effect.Effect<A, E, never>) => Effect.runPromise(effect);
    const profile = await run(
      auth.registerProfile("entry@example.com", "entry").pipe(Effect.provide(layer)),
    );
    const alt = await run(
      createProfileService(auth)
        .createProfile(profile.accountId, "entry_alt")
        .pipe(Effect.provide(layer)),
    );
    const { accessToken } = await run(
      auth
        .issueTokens(profile.id, profile.accountId, profile.email, profile.handle, null)
        .pipe(Effect.provide(layer)),
    );

    const ctx = {
      waitUntil: () => {},
      passThroughOnException: () => {},
      props: {},
    } as unknown as ExecutionContext;
    const res = await handler.fetch(
      new Request("http://localhost/profiles/delete", {
        method: "POST",
        headers: {
          authorization: `Bearer ${accessToken}`,
          "content-type": "application/json",
          "x-forwarded-for": "203.0.113.9",
          origin: ORIGIN,
        },
        body: JSON.stringify({ profile_id: alt.id }),
      }),
      env,
      ctx,
    );
    expect(res.status).toBe(200);

    const listed = await bucket.list({ prefix: "records/" });
    expect(listed.objects).toHaveLength(1);
    const stored = await bucket.get(listed.objects[0]!.key);
    expect(JSON.parse((await stored?.text()) ?? "null")).toEqual({
      v: 1,
      kind: "profile_deleted",
      at: expect.any(Number),
      accountId: profile.accountId,
      profileId: alt.id,
    });
  });
});
