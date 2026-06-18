import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import { Miniflare } from "miniflare";

import { DDL } from "./db/setup";
import handler from "./index";

// Boot-time behaviour of the Worker entry point. The organiser dashboard must
// serve ANY authenticated OSN user with NO special bootstrap config — there is
// no global boot gate. Previously `ensureBootstrapOwner` THREW (⇒ 503) in any
// deployed env unless `BOOTSTRAP_OWNER_PROFILE_ID` named a real `usr_*`; that
// gate is gone now that multi-wedding + create-wedding exist. These tests boot
// the real `handler.fetch` against a workerd-backed D1 (Miniflare) in a
// deployed-tier env (`OSN_ENV=production`) with NO bootstrap owner set and
// assert the app boots + routes — i.e. it never fail-closes at the edge with a
// 503 for the missing var.

let mf: Miniflare;
let DB: D1Database;
let savedOsnEnv: string | undefined;

const MF_HOOK_TIMEOUT_MS = 30_000;

const BASE_ENV = {
  WEB_ORIGIN: "https://app.example.com",
  OSN_JWKS_URL: "https://id.example.com/.well-known/jwks.json",
  OSN_AUDIENCE: "osn-access",
};

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as ExecutionContext;

beforeAll(async () => {
  // Deployed tier — under the OLD gate this is exactly the case that 503'd when
  // BOOTSTRAP_OWNER_PROFILE_ID was unset (the legacy fixup keyed off
  // process.env.OSN_ENV). It must now boot cleanly with no bootstrap config.
  savedOsnEnv = process.env.OSN_ENV;
  process.env.OSN_ENV = "production";
  delete process.env.BOOTSTRAP_OWNER_PROFILE_ID;

  mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } };",
    d1Databases: { DB: "cire-test-index" },
  });
  DB = await mf.getD1Database("DB");
  // Apply the schema the migrations would produce — crucially with NO seeded
  // bootstrap wedding row, mirroring a deployed D1 after migration 0015. D1's
  // exec runs newline-separated statements in one round-trip; collapse internal
  // whitespace so each statement is on a single line as exec expects.
  const ddl = DDL.split(";")
    .map((s) => s.trim().replace(/\s+/g, " "))
    .filter(Boolean)
    .join(";\n");
  await DB.exec(ddl);
}, MF_HOOK_TIMEOUT_MS);

afterAll(async () => {
  await mf?.dispose();
  if (savedOsnEnv === undefined) delete process.env.OSN_ENV;
  else process.env.OSN_ENV = savedOsnEnv;
});

describe("Worker boot (no bootstrap-owner config)", () => {
  it("boots + serves WITHOUT BOOTSTRAP_OWNER_PROFILE_ID in a deployed env (no 503)", async () => {
    const env = { ...BASE_ENV, DB } as unknown as Parameters<typeof handler.fetch>[1];
    const res = await handler.fetch!(
      new Request("https://api.example.com/api/organiser/weddings"),
      env,
      ctx,
    );
    // The old boot gate would 503 here ("Worker misconfigured: ..."). Now the
    // app boots and the route's own auth gate answers 401 (no token) — proving
    // the edge handler served the request rather than fail-closing on a missing
    // bootstrap owner.
    expect(res.status).not.toBe(503);
    expect(res.status).toBe(401);
  });

  it("still fail-closes 503 when a genuinely required binding/var is missing", async () => {
    // WEB_ORIGIN omitted — the real misconfiguration guard must still fire.
    const env = {
      DB,
      OSN_JWKS_URL: BASE_ENV.OSN_JWKS_URL,
      OSN_AUDIENCE: BASE_ENV.OSN_AUDIENCE,
    } as unknown as Parameters<typeof handler.fetch>[1];
    const res = await handler.fetch!(
      new Request("https://api.example.com/api/organiser/weddings"),
      env,
      ctx,
    );
    expect(res.status).toBe(503);
  });
});
