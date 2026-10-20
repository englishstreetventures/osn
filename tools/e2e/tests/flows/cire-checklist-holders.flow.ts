/**
 * Cire organiser portal: an owner puts two people on a checklist task from its
 * assign popover, takes one off again, and sees the task's stack of faces and
 * cire-api's `task_assignees` rows agree. Then the owner removes the person
 * still holding it from the wedding: their assignment goes with their seat,
 * and the task stays.
 *
 * The wedding (`CIRE_ORGANISER.holders`) holds the owner, an editor and a
 * viewer. The local cire-api resolves no names, so each person shows, and is
 * found, by their profile id.
 */

import type { Page } from "@playwright/test";

import { CIRE_ORGANISER, DB_FILES, ORIGINS } from "../../src/config";
import {
  expect,
  onSuiteClock,
  queryOne,
  signInToCireHost,
  test,
  type Flow,
} from "../support/fixtures";

const { weddingId, taskId, taskTitle, editor, viewer } = CIRE_ORGANISER.holders;
const WEDDING_API = `${ORIGINS.cireApi}/api/organiser/weddings/${weddingId}`;

/** The task's holders in cire-api's database, by seat id, comma-joined; `""` for none. */
function holdersInDb(): string {
  const row = queryOne<{ ids: string | null }>(
    DB_FILES.cire,
    // Ordered by seat id: two seats put on in one second tie on `assigned_at`.
    "SELECT group_concat(host_id) AS ids FROM (SELECT host_id FROM task_assignees WHERE task_id = ? ORDER BY host_id)",
    taskId,
  );
  return row?.ids ?? "";
}

/** The seat ids on the task's stack of faces, in stack order, comma-joined. */
async function holdersOnStack(page: Page): Promise<string> {
  const trigger = page.getByRole("button", { name: `Assign people to ${taskTitle}` });
  const ids = await trigger
    .locator("[data-holder]")
    .evaluateAll((faces) => faces.map((face) => face.getAttribute("data-holder")));
  return ids.join(",");
}

/** Clicks a person in the open popover and waits for that one write to be answered. */
async function toggle(
  flow: Flow,
  page: Page,
  person: { readonly hostId: string; readonly profileId: string },
  method: "PUT" | "DELETE",
): Promise<number> {
  return flow.step(
    `${method === "PUT" ? "put" : "take"} ${person.profileId} ${method === "PUT" ? "on" : "off"} the task`,
    async () => {
      const response = page.waitForResponse(
        (r) =>
          r.request().method() === method &&
          r.url() === `${WEDDING_API}/tasks/${taskId}/assignees/${person.hostId}`,
      );
      const option = page.getByRole("option", { name: new RegExp(person.profileId) });
      await option.click();
      const status = (await response).status();
      await expect(option).toHaveAttribute("aria-selected", method === "PUT" ? "true" : "false");
      return status;
    },
  );
}

test("cire-checklist-holders", async ({ page, flow }) => {
  await signInToCireHost(flow, page);

  const trigger = page.getByRole("button", { name: `Assign people to ${taskTitle}` });

  await flow.step("open the wedding's checklist", async () => {
    await page.goto(`${ORIGINS.cireHost}/#/w/${weddingId}/checklist`);
    await expect(trigger).toBeVisible();
  });
  flow.check("nobody holds the task at first", "", await holdersOnStack(page));

  await flow.step("open the task's assign popover", async () => {
    await trigger.click();
    const people = page.getByRole("listbox", { name: "People" });
    await expect(people.getByRole("option")).toHaveCount(3);
    await expect(people.getByRole("option", { name: new RegExp(editor.profileId) })).toBeVisible();
    await expect(people.getByRole("option", { name: new RegExp(viewer.profileId) })).toBeVisible();
  });

  flow.check("editor put on", 200, await toggle(flow, page, editor, "PUT"));
  flow.check("viewer put on", 200, await toggle(flow, page, viewer, "PUT"));
  flow.check(
    "task_assignees rows with two people on",
    `${editor.hostId},${viewer.hostId}`,
    holdersInDb(),
  );

  flow.check("viewer taken off", 200, await toggle(flow, page, viewer, "DELETE"));

  await flow.step("close the popover", async () => {
    await page.keyboard.press("Escape");
    await expect(page.getByRole("listbox", { name: "People" })).toBeHidden();
    await expect(trigger.locator("[data-holder]")).toHaveCount(1);
  });
  flow.check("the stack shows the one person left", editor.hostId, await holdersOnStack(page));
  flow.check("task_assignees rows with one taken off", editor.hostId, holdersInDb());
  const assigned = queryOne<{ assigned_at: number }>(
    DB_FILES.cire,
    "SELECT assigned_at FROM task_assignees WHERE task_id = ? AND host_id = ?",
    taskId,
    editor.hostId,
  );
  flow.check(
    "task_assignees row written on the suite clock",
    true,
    onSuiteClock(assigned?.assigned_at),
  );

  const removed = await flow.step(`remove ${editor.profileId} from the wedding`, async () => {
    await page.goto(`${ORIGINS.cireHost}/#/w/${weddingId}/settings/hosts`);
    const row = page.getByRole("listitem").filter({ hasText: editor.profileId });
    const response = page.waitForResponse(
      (r) =>
        r.request().method() === "DELETE" && r.url() === `${WEDDING_API}/hosts/${editor.profileId}`,
    );
    await row.getByRole("button", { name: "Remove host" }).click();
    const status = (await response).status();
    await expect(page.getByRole("listitem").filter({ hasText: editor.profileId })).toHaveCount(0);
    return status;
  });
  flow.check("editor removed", 200, removed);

  flow.check("task_assignees rows once the holder has left", "", holdersInDb());
  const task = queryOne<{ title: string; status: string }>(
    DB_FILES.cire,
    "SELECT title, status FROM tasks WHERE id = ?",
    taskId,
  );
  flow.check("the task stays", taskTitle, task?.title ?? "missing");
  flow.check("the task is still open", "open", task?.status ?? "missing");
  const seat = queryOne<{ n: number }>(
    DB_FILES.cire,
    "SELECT count(*) AS n FROM wedding_hosts WHERE wedding_id = ? AND osn_profile_id = ?",
    weddingId,
    editor.profileId,
  );
  flow.check("the removed person's seat is gone", 0, seat?.n ?? -1);

  await flow.step("see the task with nobody on it", async () => {
    await page.goto(`${ORIGINS.cireHost}/#/w/${weddingId}/checklist`);
    await expect(trigger).toBeVisible();
    await expect(trigger.locator("[data-holder]")).toHaveCount(0);
  });
  flow.check("the stack shows nobody", "", await holdersOnStack(page));
});
