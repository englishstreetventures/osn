/**
 * Musubi: create an organisation, have a member added, open the organisation's
 * page, rename it, ask the member to connect from Discover and again from
 * `/search`, remove the member, open an organisation the owner does not
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
 * the app, and the checks on profile and token reads prove it.
 *
 * On the way it measures and shoots the surfaces these pages draw from shared
 * parts (`musubi-surfaces.ts`): the create dialog's fade with no scale, the
 * create and edit dialogs' titles, padded bodies and footers, the list's rows on `Card`, the roster's names and role `Chip`, a
 * search result's name. It holds the create's POST, the rename's PATCH and
 * each connection request long enough to read the busy button ("Creating…",
 * "Saving…", "Sending…"), and reads Discover's and `/search`'s Connect 40px
 * tall at the phone width. Last, it
 * loads `/authorize` with no request, which runs outside the session provider,
 * and reads its dead-end box on `Card`.
 *
 * It also holds Musubi's page cache to its promise (`musubi/social/src/lib/
 * page-cache.ts`): hovering the Discover link reads its suggestions before the
 * click; coming back to the organisations list draws it at once, renamed,
 * while its read again is held, with no placeholder, then the organisation
 * the same way; and a deleted organisation's stale link is a first load,
 * placeholder and all. The page under the return is shot as
 * `screenshots/musubi-page-cache/organisations-return.png`.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";

import type { Page } from "@playwright/test";

import { DB_FILES, MUSUBI_ORG, ORIGINS, SCREENSHOT_DIR } from "../../src/config";
import {
  expect,
  holdMethod,
  onSuiteClock,
  queryOne,
  signInToMusubiAsDev,
  test,
} from "../support/fixtures";
import {
  authorizeDeadSurfaces,
  busyButtonHeld,
  onPhone,
  orgCreateDialogSurfaces,
  orgEditDialogSurfaces,
  orgListSurfaces,
  orgRosterSurfaces,
  phoneTall,
  searchSurfaces,
} from "../support/musubi-surfaces";
import { holdOverlay } from "../support/overlay-frames";

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

/** A loading placeholder (`@shared/ui`'s `Skeleton`): hidden from readers, the sunk well's fill. */
const PLACEHOLDER = '[aria-hidden="true"][class*="bg-ui-surface-sunk"]';

/**
 * Watches the page for a loading placeholder being drawn, from now until
 * `seen` is read. On `document.body`, which outlives every page's `<main>`,
 * and on added nodes, since a placeholder arrives inside a new subtree.
 */
async function watchPlaceholders(page: Page): Promise<{ seen: () => Promise<boolean> }> {
  await page.evaluate((selector) => {
    const w = window as unknown as {
      __placeholderWatch?: { observer: MutationObserver; seen: boolean };
    };
    w.__placeholderWatch?.observer.disconnect();
    const watch = { observer: undefined as unknown as MutationObserver, seen: false };
    const file = (records: MutationRecord[]) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node instanceof Element && (node.matches(selector) || node.querySelector(selector))) {
            watch.seen = true;
          }
        }
      }
    };
    watch.observer = new MutationObserver(file);
    watch.observer.observe(document.body, { childList: true, subtree: true });
    w.__placeholderWatch = watch;
    (w as unknown as { __placeholderFile: typeof file }).__placeholderFile = file;
  }, PLACEHOLDER);
  return {
    seen: () =>
      page.evaluate(() => {
        const w = window as unknown as {
          __placeholderWatch: { observer: MutationObserver; seen: boolean };
          __placeholderFile: (records: MutationRecord[]) => void;
        };
        w.__placeholderFile(w.__placeholderWatch.observer.takeRecords());
        w.__placeholderWatch.observer.disconnect();
        return w.__placeholderWatch.seen;
      }),
  };
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

  const createDialog = page.getByRole("dialog", { name: "Create organisation" });
  // Caught from before the click: the dialog's 120ms entry is over by any read after it.
  const createOpened = await holdOverlay(page, '[role="dialog"]', "ui-enter", 0);
  await flow.step("fill the create dialog", async () => {
    await page.getByRole("button", { name: "Create", exact: true }).click();
    // The dialog moves focus to its first field as it opens. Typed before
    // then, the next field's text can land in that one.
    await expect(createDialog.getByLabel("Handle", { exact: true })).toBeFocused();
    await createDialog.getByLabel("Handle", { exact: true }).fill(org.handle);
    await createDialog.getByLabel("Name", { exact: true }).fill(org.name);
  });
  await orgCreateDialogSurfaces(flow, page, createOpened);
  const orgLink = page.getByRole("link", { name: new RegExp(org.name) });
  // The create is held until its busy button has been read: the button must
  // keep focus through the wait, which `disabled` would drop.
  const orgsUrl = `${ORIGINS.osnApi}/organisations`;
  const createHeld = holdMethod("POST");
  // The list's read after the create is held too: the new row is drawn from
  // the create's answer before the list is read again.
  const createReread = holdMethod("GET");
  await page.route(orgsUrl, createReread.handler);
  await page.route(orgsUrl, createHeld.handler);
  const reread = page.waitForRequest(
    (request) => request.url() === orgsUrl && request.method() === "GET",
  );
  try {
    await flow.step("create the organisation: Create waits on the POST", async () => {
      await createDialog.getByRole("button", { name: "Create", exact: true }).click();
      await expect(createDialog.getByRole("button", { name: "Creating…" })).toBeVisible();
    });
    await busyButtonHeld(
      flow,
      createDialog.getByRole("button", { name: "Creating…" }),
      "Creating…",
      "create busy",
    );
  } finally {
    createHeld.release();
    await page.unroute(orgsUrl, createHeld.handler);
  }
  let createdWhileHeld = false;
  try {
    await flow.step("create the organisation", async () => {
      await expect(page.getByText(`Created ${org.name}`)).toBeVisible();
      await reread;
      await expect(orgLink).toBeVisible();
      createdWhileHeld = true;
    });
  } finally {
    createReread.release();
    await page.unroute(orgsUrl, createReread.handler);
  }
  flow.check(
    "organisations: the new row drawn before the list is read again",
    true,
    createdWhileHeld,
  );
  flow.check("organisation created", true, flow.saw("POST osn-api /organisations 201"));
  await orgListSurfaces(flow, page, orgLink);

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
    await orgLink.click();
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
  await orgRosterSurfaces(flow, page, member.name);

  const editDialog = page.getByRole("dialog", { name: "Edit organisation" });
  await flow.step("fill the edit dialog", async () => {
    await page.getByRole("button", { name: "Edit", exact: true }).click();
    await expect(editDialog.getByLabel("Name", { exact: true })).toBeFocused();
    await editDialog.getByLabel("Name", { exact: true }).fill(org.renamed);
  });
  await orgEditDialogSurfaces(flow, page);
  const orgUrl = `${ORIGINS.osnApi}/organisations/${org.handle}`;
  const saveHeld = holdMethod("PATCH");
  await page.route(orgUrl, saveHeld.handler);
  try {
    await flow.step("rename the organisation: Save waits on the PATCH", async () => {
      await editDialog.getByRole("button", { name: "Save", exact: true }).click();
      await expect(editDialog.getByRole("button", { name: "Saving…" })).toBeVisible();
    });
    await busyButtonHeld(
      flow,
      editDialog.getByRole("button", { name: "Saving…" }),
      "Saving…",
      "save busy",
    );
  } finally {
    saveHeld.release();
    await page.unroute(orgUrl, saveHeld.handler);
  }
  await flow.step("rename the organisation", async () => {
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

  // While both are in the organisation, Discover suggests the member. Each
  // Connect below has its POST held until the button has been read busy, at
  // the phone width; between them the API withdraws the first request, so
  // `/search` offers Connect again.
  const connectUrl = `${ORIGINS.osnApi}/graph/connections/${member.handle}`;
  const sentRequests = () => flow.count(`POST osn-api /graph/connections/${member.handle} `);
  const suggestion = page
    .getByRole("main")
    .getByText(`@${member.handle}`, { exact: true })
    .locator("xpath=ancestor::div[.//button][1]");
  // Discover has no rows yet: hovering its link reads them before the click,
  // and the visit reads them again behind the ones it then draws at once.
  const suggestionsUrl = `${ORIGINS.osnApi}/recommendations/connections`;
  const suggestionReads = () => flow.count("GET osn-api /recommendations/connections ");
  const suggestionsAnswered = () =>
    page.waitForResponse(
      (response) =>
        response.url().startsWith(suggestionsUrl) && response.request().method() === "GET",
    );
  const discoverLink = page.getByRole("link", { name: "Discover" }).first();
  await flow.step("hover Discover: its suggestions are read before any click", async () => {
    const answered = suggestionsAnswered();
    await discoverLink.hover();
    await answered;
    await expect.poll(suggestionReads).toBe(1);
  });
  flow.check("hovering Discover reads its suggestions", 1, suggestionReads());
  await flow.step("open Discover, the member suggested", async () => {
    const answered = suggestionsAnswered();
    await discoverLink.click();
    await expect(suggestion.getByRole("button", { name: "Connect" })).toBeVisible();
    await answered;
    await expect.poll(suggestionReads).toBe(2);
  });
  flow.check("the visit reads them again behind the hovered ones", 2, suggestionReads());
  const discoverHeld = holdMethod("POST");
  await page.route(connectUrl, discoverHeld.handler);
  // The suggestions' read after the request is held: the card leaves at once.
  const isSuggestions = (url: URL) => url.href.startsWith(suggestionsUrl);
  const discoverReread = holdMethod("GET");
  await page.route(isSuggestions, discoverReread.handler);
  const suggestionsReread = page.waitForRequest(
    (request) => request.url().startsWith(suggestionsUrl) && request.method() === "GET",
  );
  try {
    await onPhone(page, async () => {
      await phoneTall(
        flow,
        suggestion.getByRole("button", { name: "Connect" }),
        "discover connect",
      );
      await flow.step("connect from Discover: Connect waits on the POST", async () => {
        await suggestion.getByRole("button", { name: "Connect" }).click();
        await expect(suggestion.getByRole("button", { name: "Sending…" })).toBeVisible();
      });
      const sending = suggestion.getByRole("button", { name: "Sending…" });
      await busyButtonHeld(flow, sending, "Sending…", "discover connect busy");
      await phoneTall(flow, sending, "discover connect busy");
    });
  } finally {
    discoverHeld.release();
    await page.unroute(connectUrl, discoverHeld.handler);
  }
  let cardsWhileHeld = -1;
  try {
    await flow.step("connect from Discover", async () => {
      await expect(page.getByText(`Request sent to @${member.handle}`)).toBeVisible();
      await suggestionsReread;
      await expect(suggestion).toHaveCount(0);
      cardsWhileHeld = await suggestion.count();
    });
  } finally {
    discoverReread.release();
    await page.unroute(isSuggestions, discoverReread.handler);
  }
  flow.check("discover: the card leaves before the suggestions are read again", 0, cardsWhileHeld);
  flow.check("Discover sent one request", 1, sentRequests());

  await flow.step("withdraw the request through the API", async () => {
    const response = await page.context().request.delete(connectUrl, {
      headers: { Authorization: `Bearer ${token}`, Origin: ORIGINS.musubi },
    });
    flow.recordRequest("DELETE", connectUrl, response.status());
    expect(response.status(), "withdraw request").toBe(200);
  });

  const searchRow = page
    .getByRole("main")
    .getByRole("listitem")
    .filter({ hasText: `@${member.handle}` });
  const searchHeld = holdMethod("POST");
  const sentFromDiscover = sentRequests();
  await onPhone(page, async () => {
    await flow.step("find the member on /search", async () => {
      await page
        .locator('nav[aria-label="Primary"]')
        .getByRole("link", { name: "Search", exact: true })
        .click();
      await page
        .getByRole("searchbox", { name: "Search people and organisations" })
        .fill(member.handle);
      await expect(searchRow.getByRole("button", { name: "Connect" })).toBeVisible();
    });
    await phoneTall(flow, searchRow.getByRole("button", { name: "Connect" }), "search connect");
    await page.route(connectUrl, searchHeld.handler);
    try {
      await flow.step("connect from /search: Connect waits on the POST", async () => {
        await searchRow.getByRole("button", { name: "Connect" }).click();
        await expect(searchRow.getByRole("button", { name: "Sending…" })).toBeVisible();
      });
      const sending = searchRow.getByRole("button", { name: "Sending…" });
      await busyButtonHeld(flow, sending, "Sending…", "search connect busy");
      await phoneTall(flow, sending, "search connect busy");
    } finally {
      searchHeld.release();
      await page.unroute(connectUrl, searchHeld.handler);
    }
    await flow.step("connect from /search", async () => {
      await expect(searchRow.getByText("Requested", { exact: true })).toBeVisible();
    });
  });
  flow.check("/search sent one request", 1, sentRequests() - sentFromDiscover);

  // Back to pages already seen: each draws its rows at once and reads them
  // again behind them. The list's read is held, so its row, under the new
  // name the rename wrote into the cache, is drawn before the read answers.
  const listReads = () => flow.count("GET osn-api /organisations ");
  const readsBefore = listReads();
  const listWatch = await watchPlaceholders(page);
  const listHeld = holdMethod("GET");
  await page.route(orgsUrl, listHeld.handler);
  let drawnWhileHeld = false;
  let busyWhileHeld = 0;
  try {
    await flow.step(
      "back to the organisations list: drawn at once, read again behind it",
      async () => {
        const sent = page.waitForRequest(
          (request) => request.url() === orgsUrl && request.method() === "GET",
        );
        await page.getByRole("link", { name: "Organisations" }).first().click();
        await sent;
        await expect(page.getByRole("link", { name: new RegExp(org.renamed) })).toBeVisible();
        drawnWhileHeld = true;
        busyWhileHeld = await page.locator('main [aria-busy="true"]').count();
        const shots = join(SCREENSHOT_DIR, "musubi-page-cache");
        mkdirSync(shots, { recursive: true });
        await page.screenshot({ path: join(shots, "organisations-return.png") });
      },
    );
  } finally {
    listHeld.release();
    await page.unroute(orgsUrl, listHeld.handler);
  }
  await expect.poll(listReads).toBe(readsBefore + 1);
  flow.check("organisations: the list drawn while its read is held", true, drawnWhileHeld);
  // Rows already on screen are whole: the read behind them marks nothing busy,
  // which a screen reader could take as a cue to pass the region by.
  flow.check("organisations: nothing marked busy while its read is held", 0, busyWhileHeld);
  flow.check("organisations: no placeholder on the return", false, await listWatch.seen());
  flow.check("organisations: the list read again behind it", 1, listReads() - readsBefore);

  const orgWatch = await watchPlaceholders(page);
  await flow.step("back to the organisation", async () => {
    await orgLink.click();
    await expect(page.getByRole("heading", { level: 1, name: org.renamed })).toBeVisible();
    await expect(page.getByText(`@${member.handle}`, { exact: true })).toBeVisible();
  });
  flow.check("organisation: no placeholder on the return", false, await orgWatch.seen());

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
    const option = page.getByRole("option", {
      name: `${otherOrg.name}, @${otherOrg.handle}, open organisation`,
    });
    await expect(option).toBeVisible();
    await searchSurfaces(flow, page, option, otherOrg.name);
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

  const staleWatch = await watchPlaceholders(page);
  await flow.step("follow the stale link back", async () => {
    await page.goBack();
    await expect(page).toHaveURL(`${ORIGINS.musubi}/organisations/${org.handle}`);
    await expect(page.getByText("Organisation not found.")).toBeVisible();
  });
  // The deleted organisation's rows were dropped: a first load, which draws
  // its placeholder (and shows the watch above can see one).
  flow.check("stale link: a first load, with a placeholder", true, await staleWatch.seen());
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

  await authorizeDeadSurfaces(flow, page);
  flow.check(
    "no Content-Security-Policy message on a Musubi page",
    "",
    flow.cspMessages(ORIGINS.musubi).join("\n"),
  );
});
