/**
 * Cire organiser portal: an owner signs in through osn-api, opens a Gold
 * wedding's empty checklist, previews the starter checklist and adds every task
 * it ticks. Each lands in cire-api's `tasks` table, seeded from the template and
 * due a set time before the wedding date.
 *
 * The wedding (`CIRE_ORGANISER.checklist`) is dated 2099-06-20, far past the
 * suite clock, so no item's due date has passed and the dialog ticks them all.
 * How many the starter holds is read off the dialog rather than written here,
 * so a starter edit changes the count without breaking the flow.
 */

import type { Page } from "@playwright/test";

import { CIRE_ORGANISER, DB_FILES, ORIGINS, REALTIME_KEEPALIVE } from "../../src/config";
import { expect, onSuiteClock, queryOne, signInToCireHost, test } from "../support/fixtures";

const { weddingId, firstItem } = CIRE_ORGANISER.checklist;

/**
 * Counts, in each document `page` loads, the frames its push sockets (path
 * `/realtime/…`) receive that are the keepalive's answer, and exposes the
 * count as `__e2ePushPongs`. The hub stand-in counts the pings it receives;
 * this shows its answer reached the page.
 */
async function countPushPongs(page: Page): Promise<void> {
  await page.addInitScript(
    ({ pong, path }) => {
      let received = 0;
      const dispatch = EventTarget.prototype.dispatchEvent;
      EventTarget.prototype.dispatchEvent = function (this: EventTarget, event: Event): boolean {
        if (
          event instanceof MessageEvent &&
          event.data === pong &&
          this instanceof WebSocket &&
          new URL(this.url).pathname.startsWith(path)
        ) {
          received += 1;
        }
        return dispatch.call(this, event);
      };
      Object.defineProperty(globalThis, "__e2ePushPongs", { get: () => received });
    },
    { pong: REALTIME_KEEPALIVE.pong, path: "/realtime/" },
  );
}

/** The current document's count from `countPushPongs`. */
const pushPongs = (page: Page): Promise<number> =>
  page.evaluate(() => Number(Reflect.get(globalThis, "__e2ePushPongs") ?? 0));

test("cire-checklist-starter", async ({ page, flow }) => {
  await countPushPongs(page);
  await signInToCireHost(flow, page);

  await flow.step("open the wedding's checklist", async () => {
    await page.goto(`${ORIGINS.cireHost}/#/w/${weddingId}/checklist`);
    await expect(page.getByRole("button", { name: "Preview the starter checklist" })).toBeVisible();
  });

  const offered = await flow.step("preview the starter checklist", async () => {
    await page.getByRole("button", { name: "Preview the starter checklist" }).click();
    const dialog = page.getByRole("dialog", { name: "Starter checklist" });
    const add = dialog.getByRole("button", { name: /^Add \d+ tasks$/ });
    await expect(add).toBeEnabled();
    await expect(dialog.getByRole("checkbox", { name: firstItem.title })).toBeChecked();
    return Number((await add.textContent())?.match(/\d+/)?.[0] ?? 0);
  });
  flow.check("the dialog ticks a task to add", true, offered > 0);

  const applied = await flow.step("add the ticked tasks", async () => {
    const response = page.waitForResponse(
      (r) =>
        r.request().method() === "POST" &&
        r.url() ===
          `${ORIGINS.cireApi}/api/organiser/weddings/${weddingId}/tasks/templates/starter`,
    );
    await page.getByRole("button", { name: `Add ${offered} tasks` }).click();
    const status = (await response).status();
    await expect(page.getByRole("dialog", { name: "Starter checklist" })).toBeHidden();
    await expect(page.getByText(`Added ${offered} tasks to your checklist.`)).toBeVisible();
    return status;
  });
  flow.check("starter applied", 200, applied);

  await flow.step("see the first task on the checklist", async () => {
    const row = page.getByRole("listitem").filter({ hasText: firstItem.title });
    await expect(row).toContainText(`due ${firstItem.dueAt}`);
  });

  const added = queryOne<{ n: number }>(
    DB_FILES.cire,
    "SELECT count(*) AS n FROM tasks WHERE wedding_id = ? AND template_id = 'starter'",
    weddingId,
  );
  flow.check("tasks rows from the starter, one per ticked item", offered, added?.n ?? -1);
  const first = queryOne<{
    title: string;
    timeframe_bucket: string;
    due_at: string | null;
    due_source: string;
    status: string;
    created_at: number;
  }>(
    DB_FILES.cire,
    "SELECT title, timeframe_bucket, due_at, due_source, status, created_at FROM tasks WHERE wedding_id = ? AND template_id = 'starter' AND template_item = ?",
    weddingId,
    firstItem.key,
  );
  flow.check("first task's title", firstItem.title, first?.title ?? "missing");
  flow.check(
    "first task's bucket",
    firstItem.timeframeBucket,
    first?.timeframe_bucket ?? "missing",
  );
  flow.check("first task due a year before the wedding", firstItem.dueAt, first?.due_at ?? "none");
  flow.check("first task's due date follows the wedding date", "template", first?.due_source ?? "");
  flow.check("first task is open", "open", first?.status ?? "missing");
  flow.check("tasks row written on the suite clock", true, onSuiteClock(first?.created_at));

  // Last, so the page clock's jump moves nothing a step above reads. Over one
  // ping interval the checklist page runs only toast and layout timers, the
  // command palette's warm-up import and the socket's ping; none calls the API.
  const keepalive = await flow.step("let one push keepalive interval pass", async () => {
    await page.clock.runFor(REALTIME_KEEPALIVE.intervalMs);
    // The ping and its answer cross the test runner a moment after the tick.
    await expect
      .poll(() => pushPongs(page))
      .toBeGreaterThanOrEqual(1)
      .catch(() => undefined);
    return { pings: flow.realtimePings(), pongs: await pushPongs(page) };
  });
  flow.check("portal: the hub stand-in received the socket's ping", true, keepalive.pings >= 1);
  flow.check("portal: the socket received the stand-in's pong", true, keepalive.pongs >= 1);
});
