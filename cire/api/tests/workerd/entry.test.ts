import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import { Miniflare } from "miniflare";

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
  const build = Bun.spawnSync(
    ["bunx", "wrangler", "deploy", "--dry-run", "--env", "dev", "--outdir", outdir],
    { cwd: `${import.meta.dirname}/../..`, stdout: "pipe", stderr: "pipe" },
  );
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

  it("runs the hub class it exports, with the whole module evaluated in its isolate", async () => {
    const hub = await mf.getDurableObjectNamespace("REALTIME_HUB");
    const stub = hub.get(hub.idFromName("cire:wedding:wed_1")) as unknown as {
      publish(signal: unknown, evict: readonly string[]): Promise<number>;
    };
    expect(
      await stub.publish({ topic: "cire:wedding:wed_1", kind: "members-changed", at: 1 }, []),
    ).toBe(0);
  });
});
