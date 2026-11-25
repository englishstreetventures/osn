/**
 * Musubi: the operator's change notice reaches every account once.
 *
 * The production operator workflow drives `POST
 * /internal/change-notices/:noticeId/send` on osn-api with its own bearer,
 * one batch a call; this flow makes the same calls against the stack's
 * osn-api, whose registry is the suite's own (`src/change-notices.json`,
 * through `OSN_CHANGE_NOTICES_FILE`), and reads what reached the mail
 * stand-in, which takes osn-api's real Resend transport.
 *
 * Without the bearer the route answers 401. A dry run counts the accounts it
 * would reach and sends nothing. Then calls of two addresses each run until
 * the route says the run is finished: each account the run covers gets the
 * notice exactly once, and no address outside it gets one, whatever earlier
 * flows left in the database. One address is armed to be refused, as Resend
 * refuses an invalid one in a permissive batch: the run counts it failed and
 * passes it. Each batch went under one idempotency key, in permissive
 * validation. A call after the end sends nothing. The flow ends on the email
 * as the stand-in received it.
 *
 * Every check compares what reached the stand-in with the database as read
 * now, never a fixed number, so the results are the same on every run.
 *
 * It mails every account the stack's osn-api holds, the seeded ones included,
 * so a later flow that reads an account's mail picks its own message, by
 * subject or by the link it carries, never the first one in the inbox.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  noticeDigest,
  parseChangeNotices,
} from "../../../../osn/api/src/services/change-notice-registry";
import {
  CHANGE_NOTICE_SECRET,
  CHANGE_NOTICES_FILE,
  DB_FILES,
  ORIGINS,
  SCREENSHOT_DIR,
} from "../../src/config";
import type { CapturedMail } from "../../src/mail";
import { queryOne, refuseNextMailTo, refusedMailCount, test } from "../support/fixtures";

const NOTICE_ID = "e2e-privacy";
const SUBJECT = "Changes to the Musubi privacy notice";
const SEND_URL = `${ORIGINS.osnApi}/internal/change-notices/${NOTICE_ID}/send`;

interface Answer {
  readonly status: number;
  readonly body: Readonly<Record<string, unknown>>;
}

/** The accounts a run that started at `startedAt` covers, by address, one per line. */
const audience = (startedAt: number): string[] =>
  (
    queryOne<{ emails: string | null }>(
      DB_FILES.osn,
      "SELECT group_concat(email, char(10)) AS emails FROM (SELECT email FROM accounts WHERE created_at <= ? AND processing_restricted_at IS NULL ORDER BY email)",
      startedAt,
    )?.emails ?? ""
  )
    .split("\n")
    .filter((email) => email !== "");

test("musubi-change-notice", async ({ page, flow }) => {
  const registry: unknown = JSON.parse(readFileSync(CHANGE_NOTICES_FILE, "utf8"));
  const expectDigest = await noticeDigest(parseChangeNotices(registry).get(NOTICE_ID)!);

  async function send(
    body: Record<string, unknown>,
    bearer = CHANGE_NOTICE_SECRET,
  ): Promise<Answer> {
    const response = await fetch(SEND_URL, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${bearer}` },
      body: JSON.stringify({ expect: expectDigest, ...body }),
    });
    flow.recordRequest("POST", SEND_URL, response.status);
    return { status: response.status, body: (await response.json()) as Answer["body"] };
  }

  const refusedWithout = await flow.step("a call without the bearer", () =>
    send({ dryRun: true }, "not-the-change-notice-secret-0123456789"),
  );
  flow.check("without the bearer: 401", 401, refusedWithout.status);

  const dry = await flow.step("a dry run counts, and sends nothing", () => send({ dryRun: true }));
  flow.check("dry run: 200", 200, dry.status);
  // Every account the database holds was made on osn-api's clock, so before
  // the dry run's now: the whole table, restricted ones aside.
  const everyone = audience(2 ** 31);
  flow.check(
    "dry run: counts every account the database holds",
    true,
    dry.body.toSend === everyone.length,
  );
  flow.check("dry run: nothing was started", true, dry.body.sentSoFar === 0);

  // One address Resend will refuse on its own, as it refuses an invalid one.
  const first = everyone[0] ?? "";
  flow.check("the database holds an account to arm", true, first !== "");
  await refuseNextMailTo(first);

  const answers = await flow.step("calls of two addresses until the run finishes", async () => {
    const got: Answer[] = [];
    for (let call = 0; call < 200; call += 1) {
      // oxlint-disable-next-line no-await-in-loop -- each call resumes where the last stopped
      const answer = await send({ dryRun: false, limit: 2 });
      got.push(answer);
      if (answer.status !== 200 || answer.body.finished === true) break;
    }
    return got;
  });
  flow.check(
    "every call: 200",
    true,
    answers.every((answer) => answer.status === 200),
  );
  flow.check("the last call: finished", true, answers.at(-1)?.body.finished === true);

  const after = await flow.step("a call after the end", () => send({ dryRun: false, limit: 2 }));
  flow.check(
    "after the end: finished, nothing sent",
    true,
    after.body.finished === true && after.body.sent === 0,
  );

  const run = queryOne<{ started_at: number; sent: number; failed: number; cursor: string | null }>(
    DB_FILES.osn,
    "SELECT started_at, sent, failed, cursor FROM change_notice_runs WHERE notice_id = ?",
    NOTICE_ID,
  );
  flow.check("the run's row exists", true, run !== undefined);
  const covered = audience(run?.started_at ?? 0);
  const mail = (await (await fetch(`${ORIGINS.mail}/__e2e/mail/all`)).json()) as CapturedMail[];
  const notices = mail.filter((message) => message.subject === SUBJECT);
  const recipients = notices.flatMap((message) => message.to).toSorted();
  const expected = covered.filter((email) => email !== first);

  flow.check(
    "each account the run covers got the notice once, but the refused one",
    true,
    JSON.stringify(recipients) === JSON.stringify(expected),
  );
  flow.check("the refused address got none", true, !recipients.includes(first));
  flow.check("the stand-in refused it once", 1, await refusedMailCount(first));
  flow.check("the run counted it failed", true, run?.failed === 1);
  flow.check("the run counted the rest sent", true, run?.sent === expected.length);
  flow.check("the finished run holds no account id", true, run?.cursor === null);
  flow.check(
    "each batch went under a change-notice key, in permissive validation",
    true,
    notices.length > 0 &&
      notices.every(
        (message) =>
          message.idempotencyKey.startsWith(`change-notice/${NOTICE_ID}/`) &&
          message.batchValidation === "permissive",
      ),
  );
  const perKey = new Map<string, number>();
  for (const message of notices) {
    perKey.set(message.idempotencyKey, (perKey.get(message.idempotencyKey) ?? 0) + 1);
  }
  flow.check(
    "no key carried more than one call's two addresses",
    true,
    [...perKey.values()].every((count) => count <= 2),
  );
  flow.check(
    "the email names the page, the day and the link",
    true,
    notices.every(
      (message) =>
        message.text.includes("1 January 2027") &&
        message.text.includes(`${ORIGINS.musubi}/privacy`),
    ),
  );

  await flow.step("the email as the stand-in received it", async () => {
    const html = notices[0]?.html ?? "";
    const dir = resolve(SCREENSHOT_DIR, "musubi-change-notice");
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, "change-notice.html"), html);
    await page.setContent(html);
    await page.screenshot({ path: resolve(dir, "change-notice.png"), fullPage: true });
  });
});
