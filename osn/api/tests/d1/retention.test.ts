import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from "bun:test";

import type {
  D1Database as DrizzleD1,
  ExecutionContext,
  ScheduledController,
} from "@cloudflare/workers-types";
import { createSchemaSql } from "@osn/db/testing";
import { Miniflare } from "miniflare";

import { handler } from "../../src/index";
import {
  EMAIL_CHANGE_RETENTION_SECONDS,
  SECURITY_EVENT_RETENTION_SECONDS,
} from "../../src/services/retention";

/**
 * The 6-hourly cron on real D1 runs the retention sweeps of `security_events`,
 * `email_changes` and `handle_holds`: each deletes the rows past its window
 * through its `rowid` subquery, and keeps the rest.
 */

const MF_TIMEOUT_MS = 30_000;
setDefaultTimeout(MF_TIMEOUT_MS);

let mf: Miniflare;
let d1: DrizzleD1;

beforeAll(async () => {
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

const keys = async (sql: string): Promise<string[]> =>
  ((await d1.prepare(sql).all<{ k: string }>()).results ?? []).map((r) => r.k).toSorted();

describe("the 6-hourly cron's retention sweeps on D1", () => {
  it("deletes rows past each window and keeps the rest", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const day = 86_400;
    const oldEvent = nowSec - SECURITY_EVENT_RETENTION_SECONDS - day;
    const freshEvent = nowSec - SECURITY_EVENT_RETENTION_SECONDS + day;
    const oldChange = nowSec - EMAIL_CHANGE_RETENTION_SECONDS - day;
    const freshChange = nowSec - EMAIL_CHANGE_RETENTION_SECONDS + day;
    await d1.batch([
      d1
        .prepare(
          `INSERT INTO accounts (id, email, passkey_user_id, created_at, updated_at)
           VALUES ('acc_pending', 'pending@example.com', 'pk-user-pending', 0, 0)`,
        )
        .bind(),
      d1
        .prepare(
          `INSERT INTO security_events (id, account_id, kind, created_at)
           VALUES ('sev_old', 'acc_gone', 'email_changed', ?1),
                  ('sev_fresh', 'acc_gone', 'email_changed', ?2)`,
        )
        .bind(oldEvent, freshEvent),
      d1
        .prepare(
          `INSERT INTO email_changes (id, account_id, previous_email, new_email, completed_at)
           VALUES ('ech_old', 'acc_gone', 'a@example.com', 'b@example.com', ?1),
                  ('ech_fresh', 'acc_gone', 'a@example.com', 'b@example.com', ?2)`,
        )
        .bind(oldChange, freshChange),
      d1
        .prepare(
          `INSERT INTO handle_holds (handle, account_id, release_at, created_at)
           VALUES ('hold_released', NULL, ?1, 0),
                  ('hold_erased', NULL, ?2, 0),
                  ('hold_pending', 'acc_pending', NULL, 0)`,
        )
        .bind(nowSec - 60, nowSec + day),
    ]);
    const pending: Promise<unknown>[] = [];
    const ctx = {
      waitUntil: (p: Promise<unknown>) => void pending.push(p),
      passThroughOnException: () => {},
      props: {},
    } as unknown as ExecutionContext;
    const event = { scheduledTime: Date.now(), cron: "0 */6 * * *", noRetry: () => {} };

    await handler.scheduled(
      event as unknown as ScheduledController,
      { DB: d1, OSN_ENV: "local" },
      ctx,
    );
    await Promise.all(pending);

    expect(await keys("SELECT id AS k FROM security_events")).toEqual(["sev_fresh"]);
    expect(await keys("SELECT id AS k FROM email_changes")).toEqual(["ech_fresh"]);
    expect(await keys("SELECT handle AS k FROM handle_holds")).toEqual([
      "hold_erased",
      "hold_pending",
    ]);
  });
});
