import { afterAll, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";

import type {
  D1Database as DrizzleD1,
  ExecutionContext,
  ScheduledController,
} from "@cloudflare/workers-types";
import { createSchemaSql } from "@osn/db/testing";
import { Miniflare } from "miniflare";

import { handler, type Env } from "../../src/index";

/**
 * The 6-hourly cron's deletion sweeps on real D1, through the Worker's own
 * `scheduled` handler: each run erases at most `OSN_DELETION_FANOUT_MAX_JOBS`
 * accounts, 4 when the setting is unset or not a whole number from 1 to 200 —
 * the number the Workers Free query budget rests on — and deletion app
 * settings that cannot be right skip the fan-out alone, never the hard delete.
 */

const MF_TIMEOUT_MS = 30_000;
setDefaultTimeout(MF_TIMEOUT_MS);

let mf: Miniflare | undefined;
let d1: DrizzleD1;

beforeEach(async () => {
  await mf?.dispose();
  mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } };",
    d1Databases: { DB: ":memory:" },
  });
  d1 = (await mf.getD1Database("DB")) as unknown as DrizzleD1;
  for (const stmt of createSchemaSql()) {
    await d1.prepare(stmt).run();
  }
});

afterAll(async () => {
  await mf?.dispose();
});

const DAY = 86_400;

/**
 * An account whose deletion window passed a day ago, its job marked done by
 * every app (`ready`) or still pending at every app.
 */
async function dueAccount(name: string, ready: boolean): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const mark = ready ? now - DAY : null;
  await d1.batch([
    d1
      .prepare(
        `INSERT INTO accounts (id, email, passkey_user_id, created_at, updated_at, deleted_at)
         VALUES (?1, ?2, ?3, 0, 0, ?4)`,
      )
      .bind(`acc_${name}`, `${name}@example.com`, `pku_${name}`, now - 8 * DAY),
    d1
      .prepare(
        `INSERT INTO deletion_jobs (account_id, soft_deleted_at, hard_delete_at, pulse_done_at, zap_done_at)
         VALUES (?1, ?2, ?3, ?4, ?4)`,
      )
      .bind(`acc_${name}`, now - 8 * DAY, now - DAY, mark),
  ]);
}

const accountsLeft = async (): Promise<number> =>
  (await d1.prepare("SELECT count(*) AS n FROM accounts").first<{ n: number }>())?.n ?? -1;

const marksOf = async (name: string) =>
  d1
    .prepare(
      "SELECT pulse_done_at AS pulse, zap_done_at AS zap FROM deletion_jobs WHERE account_id = ?",
    )
    .bind(`acc_${name}`)
    .first<{ pulse: number | null; zap: number | null }>();

async function runCron(env: Partial<Env>): Promise<void> {
  const pending: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (p: Promise<unknown>) => pending.push(p),
    passThroughOnException: () => {},
    props: {},
  } as unknown as ExecutionContext;
  const event = { scheduledTime: Date.now(), cron: "0 */6 * * *", noRetry: () => {} };
  await handler.scheduled(
    event as unknown as ScheduledController,
    { DB: d1, OSN_ENV: "local", ...env } as Env,
    ctx,
  );
  await Promise.all(pending);
}

describe("the cron's deletion sweeps on D1", () => {
  it.each([
    ["unset", undefined, 4],
    ["not a whole number", "abc", 4],
    ["zero", "0", 4],
    ["2", "2", 2],
  ])(
    "with OSN_DELETION_FANOUT_MAX_JOBS %s, erases at most that many accounts a run",
    async (_label, setting, erased) => {
      for (const n of [1, 2, 3, 4, 5]) await dueAccount(`cap${n}`, true);
      await runCron({ OSN_DELETION_FANOUT_MAX_JOBS: setting });
      expect(await accountsLeft()).toBe(5 - erased);
    },
  );

  it("skips the fan-out, and still runs the hard delete, when the deletion app settings are wrong", async () => {
    await dueAccount("done", true);
    await dueAccount("waiting", false);
    await runCron({ OSN_DELETION_ABSENT_APPS: "nope" });
    // The hard delete ran: the account every app was done with is gone.
    expect(await accountsLeft()).toBe(1);
    // The fan-out did not: on a local run it would have marked both apps skipped.
    expect(await marksOf("waiting")).toEqual({ pulse: null, zap: null });

    await runCron({});
    const marked = await marksOf("waiting");
    expect(marked?.pulse).toBeGreaterThan(0);
    expect(marked?.zap).toBeGreaterThan(0);
  });
});
