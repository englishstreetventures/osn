import { afterAll, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";

import type { D1Database, ExecutionContext } from "@cloudflare/workers-types";
import { createSchemaSql } from "@osn/db/testing";
import { Miniflare } from "miniflare";

import { handler, type Env } from "../../src/index";
import { _resetOutboundKeyForTests } from "../../src/lib/outbound-arc";
import { createFakeNamespace } from "../helpers/coordination-namespace";

/**
 * The Worker's own `fetch`, on a real D1 database. An isolate publishes its
 * outbound ARC key after its first request, whatever the route, through `ctx.waitUntil`,
 * and never again for that key; a publish that fails never touches the
 * answer. The deployed bundle on workerd does the same in
 * `worker-e2e.test.ts`.
 */

const MF_TIMEOUT_MS = 30_000;
setDefaultTimeout(MF_TIMEOUT_MS);

let mf: Miniflare | undefined;
let d1: D1Database;
let env: Env;

beforeEach(async () => {
  // The key is module state, so each case starts as a fresh isolate does.
  _resetOutboundKeyForTests();
  await mf?.dispose();
  mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } };",
    d1Databases: { DB: ":memory:" },
  });
  d1 = (await mf.getD1Database("DB")) as unknown as D1Database;
  for (const stmt of createSchemaSql()) {
    // eslint-disable-next-line no-await-in-loop -- DDL in foreign-key order
    await d1.prepare(stmt).run();
  }
  // Local tier: only the two bindings are required.
  env = { DB: d1, COORDINATION: createFakeNamespace().ns } as Env;
});

afterAll(async () => {
  await mf?.dispose();
  _resetOutboundKeyForTests();
});

/** One request through the handler, with what it handed to `waitUntil`. */
async function request(path: string): Promise<{ status: number; handed: Promise<unknown>[] }> {
  const handed: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (work: Promise<unknown>) => handed.push(work),
    passThroughOnException: () => {},
    props: {},
  } as unknown as ExecutionContext;
  const res = await handler.fetch(new Request(`http://localhost${path}`), env, ctx);
  return { status: res.status, handed };
}

const keyRows = async (): Promise<number> =>
  (await d1.prepare("SELECT count(*) AS n FROM arc_outbound_keys").first<{ n: number }>())?.n ?? -1;

describe("an isolate's outbound ARC key, on the Worker's fetch", () => {
  it("is published after the first request, whatever its route, and not again", async () => {
    const first = await request("/no-such-route");
    expect(first.status).toBe(404);
    expect(first.handed).toHaveLength(1);
    await Promise.all(first.handed);
    expect(await keyRows()).toBe(1);

    const second = await request("/");
    expect(second.status).toBe(200);
    expect(second.handed).toHaveLength(0);
    expect(await keyRows()).toBe(1);
  });

  it("a publish that fails leaves the answer alone and never rejects", async () => {
    await d1.prepare("DROP TABLE arc_outbound_keys").run();
    const res = await request("/");
    expect(res.status).toBe(200);
    expect(res.handed).toHaveLength(1);
    await expect(res.handed[0]!).resolves.toBeUndefined();
  });
});
