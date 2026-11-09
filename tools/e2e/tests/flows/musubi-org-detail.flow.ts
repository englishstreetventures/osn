/**
 * Musubi: create an organisation, have a member added, open the organisation's
 * page, rename it, remove the member, open an organisation the owner does not
 * belong to from the search box, delete the first organisation, follow the
 * stale link back to it, and follow a link whose handle the API refuses.
 *
 * The organisation routes address both the organisation and the member by
 * handle and answer flat member rows with no profile id, so this is the flow
 * that proves the client and the page read what the API sends.
 *
 * The owner is the dev profile (`signInToMusubiAsDev`); the member and the
 * organisation the owner is not in are rows `seedOsn` writes (`MUSUBI_ORG`).
 * After the one page load that signs Musubi in, every step navigates inside
 * the app, and the last checks prove it.
 */

import type { Page } from "@playwright/test";

import { DB_FILES, MUSUBI_ORG, ORIGINS } from "../../src/config";
import { expect, onSuiteClock, queryOne, signInToMusubiAsDev, test } from "../support/fixtures";

const { org, member, otherOrg } = MUSUBI_ORG;

const MEMBERS_ONLY = "Only members can see who belongs to this organisation.";

/** Fails the routes' handle pattern, `^[a-z0-9_]+$`. */
const BAD_HANDLE = "Not_A_Handle";

/**
 * Holds the browser's requests to exactly `url` until the returned function
 * runs, so a check can see what the page shows while that load is in flight.
 */
async function hold(page: Page, url: string): Promise<() => void> {
  let release = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(url, async (route) => {
    await released;
    await route.continue();
  });
  return release;
}

/** Members `org` has, read from osn-api's database. */
function memberRows(): number {
  const row = queryOne<{ n: number }>(
    DB_FILES.osn,
    "SELECT count(*) AS n FROM organisation_members m JOIN organisations o ON o.id = m.organisation_id WHERE o.handle = ?",
    org.handle,
  );
  return row?.n ?? 0;
}

test("musubi-org-detail", async ({ page, flow }) => {
  const token = await signInToMusubiAsDev(flow, page, "/organisations");
  // The page names the tab once it has rendered; the shell can land first.
  await expect(page.getByRole("heading", { level: 1, name: "Organisations" })).toBeVisible();
  flow.check("list tab title", "Organisations · Musubi", await page.title());

  await flow.step("create the organisation", async () => {
    await page.getByRole("button", { name: "Create", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Handle", { exact: true }).fill(org.handle);
    await dialog.getByLabel("Name", { exact: true }).fill(org.name);
    await dialog.getByRole("button", { name: "Create", exact: true }).click();
    await expect(page.getByText(`Created ${org.name}`)).toBeVisible();
    await expect(page.getByRole("link", { name: new RegExp(org.name) })).toBeVisible();
  });
  flow.check("organisation created", true, flow.saw("POST osn-api /organisations 201"));

  await flow.step("add a member through the API", async () => {
    const url = `${ORIGINS.osnApi}/organisations/${org.handle}/members/${member.handle}`;
    const response = await page.context().request.post(url, {
      headers: { Authorization: `Bearer ${token}`, Origin: ORIGINS.musubi },
      data: { role: "member" },
    });
    flow.recordRequest("POST", url, response.status());
    expect(response.status(), "add member").toBe(201);
  });

  await flow.step("open the organisation", async () => {
    await page.getByRole("link", { name: new RegExp(org.name) }).click();
    await expect(page).toHaveURL(`${ORIGINS.musubi}/organisations/${org.handle}`);
    await expect(page.getByRole("heading", { level: 1, name: org.name })).toBeVisible();
    await expect(page.getByText(`@${member.handle}`, { exact: true })).toBeVisible();
  });
  flow.check(
    "header names the organisation",
    org.name,
    (await page.getByRole("heading", { level: 1 }).textContent()) ?? "",
  );
  flow.check("tab names the organisation", `${org.name} · Musubi`, await page.title());
  flow.check(
    "header shows the handle",
    true,
    await page.getByText(`@${org.handle}`, { exact: true }).isVisible(),
  );
  flow.check(
    "member row shows the display name",
    true,
    await page.getByText(member.name, { exact: true }).isVisible(),
  );
  // The owner's row is an admin's, which the page offers no Remove for. Each
  // Remove button is named for its member.
  flow.check(
    "Remove offered on the member's row only",
    1,
    await page.getByRole("button", { name: /^Remove/ }).count(),
  );

  await flow.step("rename the organisation", async () => {
    await page.getByRole("button", { name: "Edit", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Name", { exact: true }).fill(org.renamed);
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByRole("heading", { level: 1, name: org.renamed })).toBeVisible();
  });
  const saved = queryOne<{ name: string; created_at: number }>(
    DB_FILES.osn,
    "SELECT name, created_at FROM organisations WHERE handle = ?",
    org.handle,
  );
  flow.check("organisation renamed in the database", org.renamed, saved?.name ?? "");
  flow.check("tab follows the rename", `${org.renamed} · Musubi`, await page.title());
  flow.check("organisation row on the suite clock", true, onSuiteClock(saved?.created_at));

  await flow.step("remove the member", async () => {
    await page.getByRole("button", { name: `Remove @${member.handle}`, exact: true }).click();
    await expect(page.getByText(`Removed @${member.handle}`)).toBeVisible();
    await expect(page.getByText(`@${member.handle}`, { exact: true })).toHaveCount(0);
  });
  flow.check(
    "member removed by handle",
    true,
    flow.saw(`DELETE osn-api /organisations/${org.handle}/members/${member.handle} 200`),
  );
  flow.check("one member row left (the owner)", 1, memberRows());

  // Search offers organisations the caller does not belong to. The result is
  // chosen from the keyboard: ArrowDown makes it the active option, Enter opens it.
  await flow.step("open an organisation the owner is not in, from search", async () => {
    const search = page.getByRole("combobox", { name: "Search people and organisations" });
    await search.fill("e2e_other");
    await expect(
      page.getByRole("option", {
        name: `${otherOrg.name}, @${otherOrg.handle}, open organisation`,
      }),
    ).toBeVisible();
    await search.press("ArrowDown");
    await search.press("Enter");
    await expect(page).toHaveURL(`${ORIGINS.musubi}/organisations/${otherOrg.handle}`);
    await expect(page.getByRole("heading", { level: 1, name: otherOrg.name })).toBeVisible();
    await expect(page.getByText(MEMBERS_ONLY)).toBeVisible();
  });
  flow.check(
    "roster refused to a non-member",
    true,
    flow.saw(`GET osn-api /organisations/${otherOrg.handle}/members 403`),
  );

  // Back to the first organisation with its roster held in flight: the page
  // stays mounted, and the refusal the other roster drew must not stay with it.
  const staleRefusals = await flow.step(
    "go back to the organisation while its roster loads",
    async () => {
      const roster = `${ORIGINS.osnApi}/organisations/${org.handle}/members`;
      const release = await hold(page, roster);
      await page.goBack();
      await expect(page.getByRole("heading", { level: 1, name: org.renamed })).toBeVisible();
      const shown = await page.getByText(MEMBERS_ONLY).count();
      release();
      await expect(
        page.getByRole("main").getByText(`@${MUSUBI_ORG.owner.handle}`, { exact: true }),
      ).toBeVisible();
      await page.unroute(roster);
      return shown;
    },
  );
  flow.check("no stale roster refusal while the roster loads", 0, staleRefusals);

  await flow.step("delete the organisation", async () => {
    page.once("dialog", (dialog) => void dialog.accept());
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(page).toHaveURL(`${ORIGINS.musubi}/organisations`);
  });
  flow.check(
    "organisation gone from the database",
    0,
    queryOne<{ n: number }>(
      DB_FILES.osn,
      "SELECT count(*) AS n FROM organisations WHERE handle = ?",
      org.handle,
    )?.n ?? -1,
  );

  await flow.step("follow the stale link back", async () => {
    await page.goBack();
    await expect(page).toHaveURL(`${ORIGINS.musubi}/organisations/${org.handle}`);
    await expect(page.getByText("Organisation not found.")).toBeVisible();
  });
  flow.check(
    "deleted organisation answers 404",
    true,
    flow.saw(`GET osn-api /organisations/${org.handle} 404`),
  );

  // A failure other than 404 gets the general notice. osn-api refuses a handle
  // with capitals before it looks anything up. The link is added to the page
  // and clicked, so the router opens it in the app, with no second page load.
  const staleNotFound = await flow.step("follow a link to a handle the API refuses", async () => {
    const lookup = `${ORIGINS.osnApi}/organisations/${BAD_HANDLE}`;
    const release = await hold(page, lookup);
    await page.evaluate((href) => {
      const link = document.createElement("a");
      link.href = href;
      link.id = "e2e-bad-handle-link";
      link.textContent = "Malformed organisation link";
      // Fixed and on top: the app's layout may not scroll the body.
      link.style.cssText = "position:fixed;top:0;left:0;z-index:2147483647;background:white";
      document.body.append(link);
    }, `/organisations/${BAD_HANDLE}`);
    await page.getByRole("link", { name: "Malformed organisation link" }).click();
    await expect(page).toHaveURL(`${ORIGINS.musubi}/organisations/${BAD_HANDLE}`);
    // The lookup is still held: the last organisation's 404 must not show for this one.
    const shown = await page.getByText("Organisation not found.").count();
    release();
    await expect(page.getByText("This organisation could not be loaded.")).toBeVisible();
    await page.unroute(lookup);
    await page.evaluate(() => document.getElementById("e2e-bad-handle-link")?.remove());
    return shown;
  });
  flow.check("no stale not-found while the next organisation loads", 0, staleNotFound);
  flow.check(
    "malformed handle refused",
    true,
    flow.saw(`GET osn-api /organisations/${BAD_HANDLE} 422`),
  );

  // One page load: Musubi read its profiles and traded the cookie for a token once.
  flow.check("profiles listed once", 1, flow.count("GET osn-api /profiles/list "));
  flow.check("token granted once", 1, flow.count("POST osn-api /token "));
  flow.check(
    "no Content-Security-Policy message on a Musubi page",
    "",
    flow.cspMessages(ORIGINS.musubi).join("\n"),
  );
});
