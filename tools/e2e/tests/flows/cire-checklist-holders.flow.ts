/**
 * Cire organiser portal: an owner puts two people on a checklist task from its
 * assign popover, takes one off again, and sees the task's stack of faces and
 * cire-api's `task_assignees` rows agree. Then the owner removes the person
 * still holding it from the wedding: their assignment goes with their seat,
 * and the task stays.
 *
 * On the same sign-in the owner then chooses the wedding's envelope in the
 * invite builder: picks the Wax seal, sees the choice held across a reload and
 * the note that an empty or switched-off hero leaves guests without it, and
 * sets it back to None from the keyboard, so no later flow meets an envelope.
 *
 * The wedding (`CIRE_ORGANISER.holders`) holds the owner, an editor and a
 * viewer, and a comped `premium_templates` row, which opens the premium
 * envelope on Gold. The local cire-api resolves no names, so each person
 * shows, and is found, by their profile id.
 */

import { resolve } from "node:path";

import type { Page } from "@playwright/test";

import { CIRE_ORGANISER, DB_FILES, ORIGINS, SCREENSHOT_DIR } from "../../src/config";
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

/** The wedding's stored envelope, `"none"` for none, `"no row"` before any invite save. */
function envelopeInDb(): string {
  const row = queryOne<{ envelope_id: string | null }>(
    DB_FILES.cire,
    "SELECT envelope_id FROM wedding_invite_customisations WHERE wedding_id = ?",
    weddingId,
  );
  return row ? (row.envelope_id ?? "none") : "no row";
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

  // ── The envelope, in the invite builder ───────────────────────────────────
  const envelopeUrl = `${WEDDING_API}/invite/envelope`;
  let envelopeSaves = 0;
  page.on("request", (request) => {
    if (request.method() === "PUT" && request.url() === envelopeUrl) envelopeSaves += 1;
  });
  const envelopes = page.getByRole("radiogroup", { name: "Invite envelope" });
  const none = envelopes.getByRole("radio", { name: /^None/ });
  const seal = envelopes.getByRole("radio", { name: /^Wax seal/ });
  const heroNote = page.getByText("The envelope opens onto the hero.", { exact: false });
  const unsaved = page.getByText("Unsaved changes");
  const saveEnvelope = async (act: () => Promise<void>) => {
    const response = page.waitForResponse(
      (r) => r.request().method() === "PUT" && r.url() === envelopeUrl,
    );
    await act();
    return (await response).status();
  };

  await flow.step("open the invite builder", async () => {
    await page.goto(`${ORIGINS.cireHost}/#/w/${weddingId}/invite`);
    // The first flow to load the builder's lazy chunk under `astro dev`.
    await expect(envelopes).toBeVisible({ timeout: 60_000 });
    await expect(none).toHaveAttribute("aria-checked", "true");
    await expect(seal).not.toHaveAttribute("aria-disabled", "true");
    await expect(heroNote).toHaveCount(0);
  });

  const picked = await flow.step("pick the Wax seal envelope", async () => {
    const status = await saveEnvelope(() => seal.click());
    await expect(seal).toHaveAttribute("aria-checked", "true");
    await expect(seal).toContainText("Current");
    await expect(page.getByText("Envelope updated")).toBeVisible();
    // The holders wedding has no hero content, so guests would see no envelope.
    await expect(heroNote).toContainText("Add a title, a subtitle or an image");
    // Allowed on this wedding, so nothing says it is switched off.
    await expect(page.getByText("is switched off")).toHaveCount(0);
    return status;
  });
  flow.check("the Wax seal envelope saved", 200, picked);
  flow.check("the stored envelope once the Wax seal is picked", "wax-seal", envelopeInDb());

  await flow.step("reload: the Wax seal held", async () => {
    await expect(unsaved).toHaveCount(0);
    await page.reload();
    await expect(envelopes).toBeVisible({ timeout: 60_000 });
    await expect(seal).toHaveAttribute("aria-checked", "true");
    await expect(none).toHaveAttribute("aria-checked", "false");
    // One tab stop for the group, on the chosen card.
    await expect(seal).toHaveAttribute("tabindex", "0");
    await expect(none).toHaveAttribute("tabindex", "-1");
  });

  // The whole page, so the sticky save bar sits where it ends rather than
  // over the picker, as it would in a shot of the picker's own box.
  await flow.step("screenshots of the envelope picker", async () => {
    for (const [width, height, device] of [
      [1280, 720, "desktop"],
      [390, 844, "phone"],
    ] as const) {
      await page.setViewportSize({ width, height });
      for (const scheme of ["light", "dark"] as const) {
        await page.emulateMedia({ colorScheme: scheme });
        await page.screenshot({
          path: resolve(
            SCREENSHOT_DIR,
            `cire-checklist-holders--envelope-picker-${device}-${scheme}.png`,
          ),
          fullPage: true,
          animations: "disabled",
        });
      }
    }
    // Back to Playwright's defaults, which the rest of the flow assumes.
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.emulateMedia({ colorScheme: "light" });
  });

  await flow.step(
    "switch the hero off, then give it a title: the picker says why, then nothing",
    async () => {
      const heroSwitch = page
        .locator("#invite-hero")
        .getByRole("checkbox", { name: "Show on the invite" });
      const heroTitle = page.locator("#invite-hero").getByLabel("Couple title");
      // The builder's own tabs; the module's view bar has a "Design" tab too.
      const sections = page.getByLabel("Invite sections");
      await sections.getByRole("tab", { name: /^Hero/ }).click();
      await heroSwitch.uncheck();
      await sections.getByRole("tab", { name: /^Design/ }).click();
      await expect(heroNote).toContainText("Turn the hero on to show it");
      // Back on, so the draft is clean and no navigation below meets the
      // unsaved-changes guard.
      await sections.getByRole("tab", { name: /^Hero/ }).click();
      await heroSwitch.check();
      await sections.getByRole("tab", { name: /^Design/ }).click();
      await expect(heroNote).toContainText("Add a title, a subtitle or an image");
      // A hero with a title is shown, so the envelope has somewhere to open.
      await sections.getByRole("tab", { name: /^Hero/ }).click();
      await heroTitle.fill("Holders Wedding");
      await sections.getByRole("tab", { name: /^Design/ }).click();
      await expect(heroNote).toHaveCount(0);
      // Cleared again, so the draft is clean and no navigation below meets the
      // unsaved-changes guard.
      await sections.getByRole("tab", { name: /^Hero/ }).click();
      await heroTitle.fill("");
      await sections.getByRole("tab", { name: /^Design/ }).click();
      await expect(heroNote).toContainText("Add a title, a subtitle or an image");
      await expect(unsaved).toHaveCount(0);
    },
  );

  const cleared = await flow.step("set the envelope back to None with Home", async () => {
    // A click on the card already chosen saves nothing; Home then moves to
    // None and chooses it.
    await seal.click();
    const status = await saveEnvelope(() => seal.press("Home"));
    await expect(none).toHaveAttribute("aria-checked", "true");
    await expect(none).toBeFocused();
    await expect(heroNote).toHaveCount(0);
    return status;
  });
  flow.check("the envelope set back to None", 200, cleared);
  flow.check("the stored envelope once None is chosen", "none", envelopeInDb());
  flow.check("envelope saves sent: the pick and the clear", 2, envelopeSaves);
});
