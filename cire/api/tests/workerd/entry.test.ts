import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import type { D1Database } from "@cloudflare/workers-types";
import type { HubStub } from "@shared/realtime/server";
import { Miniflare } from "miniflare";

import { createD1Db } from "../../src/db";
import { DDL } from "../../src/db/setup";
import { ddlStatements } from "../test-helpers/ddl-statements";
import { fullWeddingKeys, fullWeddingStatements } from "../test-helpers/full-wedding";
import { seedOrganiserSession } from "../test-helpers/organiser-session";
import { readZip } from "../test-helpers/zip";

/**
 * The Worker module (`src/entry.ts`) evaluated on real workerd, with the hub
 * bound as wrangler binds it. Every other cire-api test runs the handler under
 * Bun, which never evaluates the module the way a deploy does, and a dry run
 * does not evaluate it at all — so without this the first evaluation would be
 * the dev deploy. The hub runs in the same script, so its isolate evaluates
 * the whole graph too.
 */

const HOOK_TIMEOUT_MS = 60_000;
const wrangler = Bun.TOML.parse(
  await Bun.file(new URL("../../wrangler.toml", import.meta.url)).text(),
) as { compatibility_date: string; compatibility_flags: string[] };
let mf: Miniflare;

beforeAll(async () => {
  // Wrangler's own bundle, the artefact a deploy uploads: the same dry run as
  // `bun run build`, written to a directory of this test's own.
  const outdir = `${import.meta.dirname}/../../.wrangler/entry-test`;
  const build = Bun.spawnSync(["bunx", "wrangler", "deploy", "--dry-run", "--outdir", outdir], {
    cwd: `${import.meta.dirname}/../..`,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (build.exitCode !== 0) throw new Error(`wrangler build failed: ${build.stderr.toString()}`);
  mf = new Miniflare({
    modules: true,
    scriptPath: `${outdir}/entry.js`,
    compatibilityDate: wrangler.compatibility_date,
    compatibilityFlags: wrangler.compatibility_flags,
    d1Databases: { DB: "cire-test-entry" },
    durableObjects: { REALTIME_HUB: { className: "TopicHub", useSQLite: true } },
    bindings: {
      OSN_ENV: "local",
      WEB_ORIGIN: "https://invite.example.test,https://host.example.test",
      OSN_JWKS_URL: "https://id.example.test/.well-known/jwks.json",
      OSN_ISSUER_URL: "https://id.example.test",
      OSN_AUDIENCE: "osn-access",
    },
  });
}, HOOK_TIMEOUT_MS);

afterAll(async () => {
  await mf?.dispose();
});

describe("src/entry.ts on workerd", () => {
  it("evaluates, and answers /realtime before the app", async () => {
    const res = await mf.dispatchFetch(
      `https://api.example.test/realtime/${encodeURIComponent("cire:wedding:wed_1")}`,
      { headers: { Upgrade: "websocket", Origin: "https://host.example.test" } },
    );
    // No session: the realtime route's own 401, with no body. The Elysia app
    // would have answered 404 with a JSON body.
    expect(res.status).toBe(401);
    expect(await res.text()).toBe("");
  });

  // Under `bun test` the app runs Elysia's Bun adapter; on workerd it runs the
  // web-standard one, which builds error answers and copies headers onto a
  // handler's own Response in code of its own.
  it.each([
    ["the not-found answer", "/nope", 404],
    ["a Response a handler builds", "/api/auth/oidc/start", 302],
  ])("sends nosniff on %s", async (_name, path, status) => {
    const res = await mf.dispatchFetch(`https://api.example.test${path}`, { redirect: "manual" });
    expect(res.status).toBe(status);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("runs the hub class it exports, with the whole module evaluated in its isolate", async () => {
    const hub = await mf.getDurableObjectNamespace("REALTIME_HUB");
    const stub = hub.get(hub.idFromName("cire:wedding:wed_1")) as unknown as HubStub;
    expect(
      await stub.publish(
        { topic: "cire:wedding:wed_1", kind: "members-changed", at: 1 },
        { evict: [], revoke: [] },
      ),
    ).toBe(0);
  });
});

/**
 * W1 in `NEW-FEAT.md`: the whole-wedding archive from the same bundle, under
 * the compatibility flags the production stack deploys with
 * (`cire/infra/src/declaration.ts`), not the ones `wrangler.toml` names. Only
 * workerd shows that `node:zlib`'s `crc32` and the streamed body both work in
 * the Worker: every other archive test runs under Bun.
 */
describe("the wedding archive on workerd", () => {
  const PRODUCTION_FLAGS = [
    "nodejs_compat",
    "nodejs_compat_populate_process_env",
    "legacy_module_registry",
  ];
  const W = "wed_workerd";
  const OWNER = "usr_workerd_owner";
  let archiveMf: Miniflare;
  let cookie: string;

  beforeAll(async () => {
    archiveMf = new Miniflare({
      modules: true,
      scriptPath: `${import.meta.dirname}/../../.wrangler/entry-test/entry.js`,
      compatibilityDate: wrangler.compatibility_date,
      compatibilityFlags: PRODUCTION_FLAGS,
      d1Databases: { DB: "cire-test-archive" },
      r2Buckets: ["ASSETS", "SHEETS"],
      durableObjects: { REALTIME_HUB: { className: "TopicHub", useSQLite: true } },
      bindings: {
        OSN_ENV: "local",
        WEB_ORIGIN: "https://invite.example.test,https://host.example.test",
        OSN_JWKS_URL: "https://id.example.test/.well-known/jwks.json",
        OSN_ISSUER_URL: "https://id.example.test",
        OSN_AUDIENCE: "osn-access",
      },
    });
    const d1 = (await archiveMf.getD1Database("DB")) as unknown as D1Database;
    for (const statement of ddlStatements(DDL)) await d1.prepare(statement).run();
    const db = createD1Db(d1);
    for (const statement of fullWeddingStatements(W, { owner: OWNER })) await db.run(statement);
    cookie = `cire_org_session=${await seedOrganiserSession(db, OWNER)}`;
    const assets = await archiveMf.getR2Bucket("ASSETS");
    for (const key of fullWeddingKeys(W).assets) {
      await assets.put(key, new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3]), {
        httpMetadata: { contentType: "image/jpeg" },
      });
    }
    const sheets = await archiveMf.getR2Bucket("SHEETS");
    for (const key of fullWeddingKeys(W).sheets) await sheets.put(key, `Sheet,${key}\n`);
  }, HOOK_TIMEOUT_MS);

  afterAll(async () => {
    await archiveMf?.dispose();
  });

  it("W1: streams an owner's archive whose every entry checks", async () => {
    const res = await archiveMf.dispatchFetch(
      `https://api.example.test/api/organiser/weddings/${W}/archive`,
      { method: "POST", headers: { cookie, Origin: "https://host.example.test" } },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zip");
    const entries = readZip(new Uint8Array(await res.arrayBuffer()));
    const names = entries.map((entry) => entry.name);
    expect(names).toContain(`cire-wedding-slug-${W}/manifest.json`);
    expect(names.filter((name) => name.includes("/files/"))).toHaveLength(7);
    expect(entries.every((entry) => entry.crcMatches)).toBe(true);
  });
});
