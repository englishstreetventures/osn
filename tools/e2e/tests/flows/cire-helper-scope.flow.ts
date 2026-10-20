/**
 * Cire organiser portal: an owner sets how much of the day's run sheet a helper
 * sees. Widening it to the whole run sheet asks first; narrowing it back to
 * their own tasks does not. A role change resets it: a helper with the whole
 * run sheet made a viewer and then a helper again sees their own tasks only.
 * Each step is checked in cire-api's `wedding_hosts` row.
 *
 * The wedding (`CIRE_ORGANISER.scope`) holds the owner and one helper, shown,
 * and found, by profile id: the local cire-api resolves no names.
 */

import type { Page } from "@playwright/test";

import { CIRE_ORGANISER, DB_FILES, ORIGINS } from "../../src/config";
import { expect, queryOne, signInToCireHost, test, type Flow } from "../support/fixtures";

const { weddingId, helper } = CIRE_ORGANISER.scope;
const HOSTS_API = `${ORIGINS.cireApi}/api/organiser/weddings/${weddingId}/hosts/${helper.profileId}`;

/** The helper's seat as cire-api stores it: `role/scope`. */
function seatInDb(): string {
  const row = queryOne<{ role: string; run_sheet_scope: string }>(
    DB_FILES.cire,
    "SELECT role, run_sheet_scope FROM wedding_hosts WHERE id = ?",
    helper.hostId,
  );
  return row ? `${row.role}/${row.run_sheet_scope}` : "missing";
}

const scopeSelect = (page: Page) =>
  page.getByLabel(`What ${helper.profileId} sees on the run sheet`);
const roleSelect = (page: Page) => page.getByLabel(`Role for ${helper.profileId}`);

/** Runs `act` and returns the status of the one PUT it sends to `path` under the helper's seat. */
async function answered(page: Page, path: "run-sheet-scope" | "role", act: () => Promise<void>) {
  const response = page.waitForResponse(
    (r) => r.request().method() === "PUT" && r.url() === `${HOSTS_API}/${path}`,
  );
  await act();
  return (await response).status();
}

/** Widens the helper to the whole run sheet, through the confirmation it asks for. */
async function widen(flow: Flow, page: Page, name: string): Promise<number> {
  return flow.step(name, async () => {
    const dialog = page.getByRole("dialog", { name: "Confirm showing the whole run sheet" });
    await scopeSelect(page).selectOption("full");
    await expect(dialog).toContainText(`Show ${helper.profileId} the whole run sheet?`);
    const status = await answered(page, "run-sheet-scope", () =>
      dialog.getByRole("button", { name: "Yes, show the whole run sheet" }).click(),
    );
    await expect(dialog).toBeHidden();
    await expect(scopeSelect(page)).toHaveValue("full");
    return status;
  });
}

test("cire-helper-scope", async ({ page, flow }) => {
  await signInToCireHost(flow, page);

  await flow.step("open the wedding's co-hosts", async () => {
    await page.goto(`${ORIGINS.cireHost}/#/w/${weddingId}/settings/hosts`);
    await expect(scopeSelect(page)).toHaveValue("own");
  });
  flow.check("the helper starts on their own tasks", "helper/own", seatInDb());

  flow.check("widened", 200, await widen(flow, page, "show the helper the whole run sheet"));
  flow.check("wedding_hosts row once widened", "helper/full", seatInDb());

  const narrowed = await flow.step("narrow the helper to their own tasks", async () => {
    const status = await answered(page, "run-sheet-scope", () =>
      scopeSelect(page)
        .selectOption("own")
        .then(() => undefined),
    );
    await expect(
      page.getByRole("dialog", { name: "Confirm showing the whole run sheet" }),
    ).toBeHidden();
    await expect(scopeSelect(page)).toHaveValue("own");
    return status;
  });
  flow.check("narrowed with no confirmation", 200, narrowed);
  flow.check("wedding_hosts row once narrowed", "helper/own", seatInDb());

  flow.check("widened again", 200, await widen(flow, page, "widen the helper again"));
  flow.check("wedding_hosts row widened again", "helper/full", seatInDb());

  const toViewer = await flow.step("make the helper a viewer", async () => {
    const status = await answered(page, "role", () =>
      roleSelect(page)
        .selectOption("viewer")
        .then(() => undefined),
    );
    await expect(roleSelect(page)).toHaveValue("viewer");
    await expect(scopeSelect(page)).toHaveCount(0);
    return status;
  });
  flow.check("made a viewer", 200, toViewer);
  flow.check("wedding_hosts row as a viewer: scope reset", "viewer/own", seatInDb());

  const toHelper = await flow.step("make them a helper again", async () => {
    const status = await answered(page, "role", () =>
      roleSelect(page)
        .selectOption("helper")
        .then(() => undefined),
    );
    await expect(roleSelect(page)).toHaveValue("helper");
    await expect(scopeSelect(page)).toHaveValue("own");
    // The final screenshot shows the helper's row, not the panel's header.
    await scopeSelect(page).scrollIntoViewIfNeeded();
    return status;
  });
  flow.check("made a helper again", 200, toHelper);
  flow.check("wedding_hosts row as a helper again: own tasks", "helper/own", seatInDb());
});
