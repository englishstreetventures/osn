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
        `INSERT INTO deletion_jobs (account_id, soft_deleted_at, hard_delete_at, pulse_done_at, zap_done_at, cire_done_at)
         VALUES (?1, ?2, ?3, ?4, ?4, ?4)`,
      )
      .bind(`acc_${name}`, now - 8 * DAY, now - DAY, mark),
  ]);
}

const accountsLeft = async (): Promise<number> =>
  (await d1.prepare("SELECT count(*) AS n FROM accounts").first<{ n: number }>())?.n ?? -1;

const marksOf = async (name: string) =>
  d1
    .prepare(
      "SELECT pulse_done_at AS pulse, zap_done_at AS zap, cire_done_at AS cire FROM deletion_jobs WHERE account_id = ?",
    )
    .bind(`acc_${name}`)
    .first<{ pulse: number | null; zap: number | null; cire: number | null }>();

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
    expect(await marksOf("waiting")).toEqual({ pulse: null, zap: null, cire: null });

    await runCron({});
    const marked = await marksOf("waiting");
    expect(marked?.pulse).toBeGreaterThan(0);
    expect(marked?.zap).toBeGreaterThan(0);
    expect(marked?.cire).toBeGreaterThan(0);
  });
});

/**
 * The cron hands the hard delete its email transport and where its links
 * point: the account-deleted email reaches the provider, and an
 * organisation's heir is mailed a link on the app's first `OSN_ORIGIN`. A
 * transport that cannot be built never holds up an erasure.
 */
describe("the cron's hard delete mails, on D1", () => {
  /** A stand-in for Resend's `/emails` and `/emails/batch`, keeping what it was sent. */
  function mailStandIn() {
    const sent: Array<{ to: string[]; subject: string; text: string }> = [];
    const keep = (payload: { to?: string | string[]; subject?: string; text?: string }) =>
      sent.push({
        to: typeof payload.to === "string" ? [payload.to] : [...(payload.to ?? [])],
        subject: payload.subject ?? "",
        text: payload.text ?? "",
      });
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === "/emails") {
          keep((await request.json()) as Parameters<typeof keep>[0]);
          return Response.json({ id: `mail-${sent.length}` });
        }
        if (path === "/emails/batch") {
          const batch = (await request.json()) as Array<Parameters<typeof keep>[0]>;
          return Response.json({
            data: batch.map((m) => (keep(m), { id: `mail-${sent.length}` })),
          });
        }
        return new Response("not found", { status: 404 });
      },
    });
    return { sent, url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
  }

  /** `acc_<name>`'s profile owns `org_<name>`, whose other member, from `acc_<name>_heir`, is an admin. */
  async function ownsOrganisationWithHeir(name: string): Promise<void> {
    await d1.batch([
      d1
        .prepare(
          `INSERT INTO users (id, account_id, handle, is_default, created_at, updated_at) VALUES (?1, ?2, ?3, 1, 0, 0)`,
        )
        .bind(`usr_${name}`, `acc_${name}`, `deleted_${name}`),
      d1
        .prepare(
          `INSERT INTO accounts (id, email, passkey_user_id, created_at, updated_at) VALUES (?1, ?2, ?3, 0, 0)`,
        )
        .bind(`acc_${name}_heir`, `${name}.heir@example.com`, `pku_${name}_heir`),
      d1
        .prepare(
          `INSERT INTO users (id, account_id, handle, is_default, created_at, updated_at) VALUES (?1, ?2, ?3, 1, 0, 0)`,
        )
        .bind(`usr_${name}_heir`, `acc_${name}_heir`, `${name}_heir`),
      d1
        .prepare(
          `INSERT INTO organisations (id, handle, name, owner_id, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, 0, 0)`,
        )
        .bind(`org_${name}`, `${name}org`, `Org ${name}`, `usr_${name}`),
      d1
        .prepare(
          `INSERT INTO organisation_members (id, organisation_id, profile_id, role, created_at) VALUES (?1, ?2, ?3, 'admin', 1)`,
        )
        .bind(`orgm_${name}_heir`, `org_${name}`, `usr_${name}_heir`),
    ]);
  }

  it("mails the account's old address and the heir, with the heir's link on the app's origin", async () => {
    const mail = mailStandIn();
    try {
      await dueAccount("mailed", true);
      await ownsOrganisationWithHeir("mailed");
      await runCron({
        RESEND_API_KEY: "re_test",
        RESEND_API_URL: mail.url,
        OSN_EMAIL_FROM: "Acme <no-reply@example.test>",
        OSN_ORIGIN: "https://app.example.test,https://other.example.test",
      });
      expect(await accountsLeft()).toBe(1);
      const deleted = mail.sent.filter((m) => m.to.includes("mailed@example.com"));
      expect(deleted.map((m) => m.subject)).toEqual(["Your Musubi account has been deleted"]);
      const heir = mail.sent.filter((m) => m.to.includes("mailed.heir@example.com"));
      expect(heir).toHaveLength(1);
      expect(heir[0]!.text).toContain("https://app.example.test/organisations/mailedorg?decline=1");
    } finally {
      mail.stop();
    }
  });

  it("erases the account when the email transport cannot be built", async () => {
    await dueAccount("nomail", true);
    // Not a loopback origin: building the transport refuses it.
    await runCron({ RESEND_API_KEY: "re_test", RESEND_API_URL: "https://mail.example.test" });
    expect(await accountsLeft()).toBe(0);
  });
});
