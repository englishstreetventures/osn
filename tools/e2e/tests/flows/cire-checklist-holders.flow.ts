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
 *
 * Then, on the same sign-in, a second wedding the owner has alone
 * (`CIRE_ORGANISER.settings`, on Gold), so no other flow's wedding is
 * re-minted or deleted:
 *
 * - Settings → Plan → "Have a code?": a code that names nothing is refused
 *   with cire-api's 404 worded beside the field; the Gold code, which the
 *   wedding holds, is refused 409 and stays unspent; the Crimson code moves the
 *   wedding to Crimson, the plan says so and offers no code any more, and
 *   cire-api records the redemption and the code's one use.
 * - Invite → Codes: the re-mint warns that one household's code was sent,
 *   names both households and the simple style, and on confirm rotates every
 *   code. The new codes are compared with the seeded ones in the database and
 *   never recorded.
 * - Settings → Delete wedding: a link name one letter short keeps Delete off;
 *   the exact one deletes the wedding, which leaves the list's tiles for
 *   "Recently deleted" while its row stays, marked deleted; Restore brings it
 *   back, still on Crimson.
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
      // The hero is a section of the Content view, the envelope picker in the
      // Template view's Design card: each move is a view, then a section.
      const views = page.getByRole("tablist", { name: "Views" });
      const sections = page.getByRole("tablist", { name: "Invite sections" });
      const toHero = async () => {
        await views.getByRole("tab", { name: "Content" }).click();
        await sections.getByRole("tab", { name: /^Hero/ }).click();
      };
      const toTemplate = () => views.getByRole("tab", { name: "Template" }).click();
      await toHero();
      await heroSwitch.uncheck();
      await toTemplate();
      await expect(heroNote).toContainText("Turn the hero on to show it");
      // Back on, so the draft is clean and no navigation below meets the
      // unsaved-changes guard.
      await toHero();
      await heroSwitch.check();
      await toTemplate();
      await expect(heroNote).toContainText("Add a title, a subtitle or an image");
      // A hero with a title is shown, so the envelope has somewhere to open.
      await toHero();
      await heroTitle.fill("Holders Wedding");
      await toTemplate();
      await expect(heroNote).toHaveCount(0);
      // Cleared again, so the draft is clean and no navigation below meets the
      // unsaved-changes guard.
      await toHero();
      await heroTitle.fill("");
      await toTemplate();
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

  await settingsSteps(flow, page);
});

const SETTINGS = CIRE_ORGANISER.settings;
const SETTINGS_API = `${ORIGINS.cireApi}/api/organiser/weddings/${SETTINGS.weddingId}`;
const SETTINGS_PAGE = `${ORIGINS.cireHost}/#/w/${SETTINGS.weddingId}/settings`;

/** The settings wedding's tier, where it came from, and whether it is deleted. */
function settingsWeddingInDb() {
  return queryOne<{
    tier: string;
    source: string | null;
    grantedBy: string | null;
    style: string;
    deletedAt: number | null;
  }>(
    DB_FILES.cire,
    `SELECT tier, tier_source AS source, tier_granted_by AS grantedBy, code_style AS style,
            deleted_at AS deletedAt
       FROM weddings WHERE id = ?`,
    SETTINGS.weddingId,
  );
}

/** A seeded unlock code's uses so far, and this wedding's redemptions of it. */
function codeUses(codeId: string): string {
  const row = queryOne<{ used: number; redemptions: number }>(
    DB_FILES.cire,
    `SELECT c.redeemed_count AS used,
            (SELECT count(*) FROM unlock_code_redemptions r
              WHERE r.code_id = c.id AND r.wedding_id = ?) AS redemptions
       FROM unlock_codes c WHERE c.id = ?`,
    SETTINGS.weddingId,
    codeId,
  );
  return row ? `${row.used} used, ${row.redemptions} redemptions` : "no code";
}

/**
 * The settings wedding, on the same sign-in: an owner redeems unlock codes,
 * re-mints the family codes, then deletes the wedding and restores it.
 */
async function settingsSteps(flow: Flow, page: Page): Promise<void> {
  const planSection = page.getByRole("region", { name: "Plan", exact: true });
  const codeDialog = page.getByRole("dialog", { name: "Use a code" });
  const codeField = codeDialog.getByRole("textbox", { name: "Code" });
  const useCode = codeDialog.getByRole("button", { name: "Use code" });
  const redeem = async (code: string) => {
    const answered = page.waitForResponse(
      (r) => r.request().method() === "POST" && r.url() === `${SETTINGS_API}/unlock-code`,
    );
    await codeField.fill(code);
    await useCode.click();
    return (await answered).status();
  };

  await flow.step("open the settings wedding's settings", async () => {
    await page.goto(SETTINGS_PAGE);
    await expect(planSection).toContainText("This wedding is on Gold.");
  });

  const wrong = await flow.step("a code that names nothing is refused", async () => {
    await planSection.getByRole("button", { name: "Have a code?" }).click();
    await expect(codeDialog).toBeVisible();
    const offeredEmpty = await useCode.isEnabled();
    const status = await redeem(SETTINGS.codes.wrong);
    await expect(codeDialog).toContainText(
      "That code is not valid, or it has expired or been used.",
    );
    return { offeredEmpty, status };
  });
  flow.check("Use code is off until a code is typed", false, wrong.offeredEmpty);
  flow.check("cire-api refuses an unknown code", 404, wrong.status);

  const held = await flow.step("the Gold code is refused: the wedding is on Gold", async () => {
    const status = await redeem(SETTINGS.codes.gold.code);
    await expect(codeDialog).toContainText(
      "This wedding is already on Gold, so the code would add nothing. It has not been used.",
    );
    return status;
  });
  flow.check("cire-api refuses a code for the tier held", 409, held);
  flow.check(
    "the Gold code is not spent",
    "0 used, 0 redemptions",
    codeUses(SETTINGS.codes.gold.id),
  );
  flow.check("the wedding stays on Gold", "gold", settingsWeddingInDb()?.tier ?? "missing");

  const raised = await flow.step("the Crimson code moves the wedding to Crimson", async () => {
    const status = await redeem(SETTINGS.codes.crimson.code);
    await expect(codeDialog).toBeHidden();
    await expect(page.getByText("Code accepted. This wedding is now on Crimson.")).toBeVisible();
    await expect(planSection).toContainText("This wedding is on Crimson.");
    // Crimson is the top tier, so no code is offered there.
    await expect(planSection.getByRole("button", { name: "Have a code?" })).toHaveCount(0);
    return status;
  });
  flow.check("cire-api takes the Crimson code", 200, raised);
  const upgraded = settingsWeddingInDb();
  flow.check(
    "the wedding is on Crimson, from the code",
    `crimson code code:${SETTINGS.codes.crimson.id}`,
    `${upgraded?.tier} ${upgraded?.source} ${upgraded?.grantedBy}`,
  );
  flow.check(
    "the Crimson code has one use spent, by this wedding",
    "1 used, 1 redemptions",
    codeUses(SETTINGS.codes.crimson.id),
  );
  const redeemed = queryOne<{ by: string; at: number }>(
    DB_FILES.cire,
    `SELECT redeemed_by_osn_profile_id AS by, redeemed_at AS at
       FROM unlock_code_redemptions WHERE wedding_id = ?`,
    SETTINGS.weddingId,
  );
  flow.check("redeemed by the dev profile", CIRE_ORGANISER.profileId, redeemed?.by ?? "missing");
  flow.check("redeemed on the suite clock", true, onSuiteClock(redeemed?.at));

  // ── The family codes, re-minted onto the simple style ──────────────────
  const remint = page.getByRole("button", { name: "Re-mint all codes" });
  await flow.step("open the wedding's codes", async () => {
    await page.goto(`${ORIGINS.cireHost}/#/w/${SETTINGS.weddingId}/invite/codes`);
    // Enabled once the panel has counted the households.
    await expect(remint).toBeEnabled({ timeout: 60_000 });
    await expect(page.getByRole("radio", { name: /^Simple/ })).toBeChecked();
  });

  const warned = await flow.step(
    "re-mint: the owner is warned a sent code stops working",
    async () => {
      await remint.click();
      const warning = page.getByText("1 family has already been sent their code.", {
        exact: false,
      });
      await expect(warning).toBeVisible();
      const question = page.getByText("Re-mint all 2 family codes in the", { exact: false });
      await expect(question).toBeVisible();
      return (await question.textContent())?.replace(/\s+/g, " ").trim() ?? "";
    },
  );
  flow.check(
    "the confirm names both families and the style",
    "Re-mint all 2 family codes in the simple style? This can't be undone.",
    warned,
  );

  const reminted = await flow.step("re-mint every code in the simple style", async () => {
    const answered = page.waitForResponse(
      (r) => r.request().method() === "POST" && r.url() === `${SETTINGS_API}/remint`,
    );
    await page.getByRole("button", { name: "Yes, re-mint" }).click();
    const status = (await answered).status();
    await expect(page.getByText("Re-minted 2 family codes")).toBeVisible();
    return status;
  });
  flow.check("cire-api re-mints the codes", 200, reminted);
  const codesNow = SETTINGS.families.map(({ id }) =>
    queryOne<{ code: string; sent: number | null }>(
      DB_FILES.cire,
      "SELECT public_id AS code, code_shared_at AS sent FROM families WHERE id = ?",
      id,
    ),
  );
  // Compared with the seeded codes, never recorded: a re-mint draws them at random.
  flow.check(
    "every family's code changed",
    true,
    codesNow.every((row, i) => row !== undefined && row.code !== SETTINGS.families[i]!.code),
  );
  flow.check(
    "every new code has the simple style's six-character tail",
    true,
    codesNow.every((row) => row !== undefined && /^[A-Z]+-[A-Z]+-[0-9A-Z]{6}$/.test(row.code)),
  );
  flow.check("no new code counts as sent", 0, codesNow.filter((row) => row?.sent !== null).length);
  flow.check("the wedding is on the simple style", "simple", settingsWeddingInDb()?.style ?? "");

  // ── Deleting the wedding, then restoring it from the list ──────────────
  const confirmDelete = page.getByRole("dialog", { name: "Delete this wedding" });
  const deleteButton = confirmDelete.getByRole("button", { name: "Delete wedding", exact: true });
  const offered = await flow.step("open the danger zone and mistype the link name", async () => {
    await page.goto(SETTINGS_PAGE);
    await page
      .getByRole("region", { name: "Delete this wedding" })
      .getByRole("button", { name: "Delete wedding…" })
      .click();
    await expect(confirmDelete).toBeVisible();
    await confirmDelete.getByRole("textbox").fill(SETTINGS.slug.slice(0, -1));
    return deleteButton.isEnabled();
  });
  flow.check("a link name one letter short keeps Delete off", false, offered);

  const recentlyDeleted = page.getByRole("region", { name: "Recently deleted" });
  const deleted = await flow.step("type the link name and delete the wedding", async () => {
    await confirmDelete.getByRole("textbox").fill(SETTINGS.slug);
    await expect(deleteButton).toBeEnabled();
    const answered = page.waitForResponse(
      (r) => r.request().method() === "DELETE" && r.url() === SETTINGS_API,
    );
    await deleteButton.click();
    const status = (await answered).status();
    await expect(page).toHaveURL(/#\/weddings$/);
    await expect(recentlyDeleted).toContainText(SETTINGS.name);
    return {
      status,
      tiles: await page.getByRole("button", { name: new RegExp(`^${SETTINGS.name}`) }).count(),
    };
  });
  flow.check("cire-api deletes the wedding", 200, deleted.status);
  flow.check("the wedding leaves the list's tiles", 0, deleted.tiles);
  const softDeleted = settingsWeddingInDb();
  flow.check("the wedding's row stays, marked deleted", true, softDeleted?.deletedAt != null);
  flow.check("deleted on the suite clock", true, onSuiteClock(softDeleted?.deletedAt ?? undefined));

  const restored = await flow.step("restore the wedding from the list", async () => {
    const answered = page.waitForResponse(
      (r) => r.request().method() === "POST" && r.url() === `${SETTINGS_API}/restore`,
    );
    await recentlyDeleted.getByRole("button", { name: "Restore" }).click();
    const status = (await answered).status();
    await expect(page.getByText("Wedding restored.")).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`#/w/${SETTINGS.weddingId}`));
    await expect(recentlyDeleted).toHaveCount(0);
    return status;
  });
  flow.check("cire-api restores the wedding", 200, restored);
  const back = settingsWeddingInDb();
  flow.check(
    "the wedding is live again, as it was",
    "live crimson",
    `${back?.deletedAt == null ? "live" : "deleted"} ${back?.tier}`,
  );
}
