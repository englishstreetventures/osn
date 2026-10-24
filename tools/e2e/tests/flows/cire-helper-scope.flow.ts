/**
 * Cire organiser portal: an owner sets how much of the day's run sheet a helper
 * sees, and the run sheet itself, as an owner and as such a helper.
 *
 * The scope: widening it to the whole run sheet asks first; narrowing it back
 * to their own tasks does not. A role change resets it: a helper with the whole
 * run sheet made a viewer and then a helper again sees their own tasks only.
 * Each step is checked in cire-api's `wedding_hosts` row. That wedding
 * (`CIRE_ORGANISER.scope`) holds the owner and one helper, shown, and found, by
 * profile id: the local cire-api resolves no names.
 *
 * The run sheet (`CIRE_ORGANISER.runSheet`), with the page's clock held at
 * 10:05 Sydney on the day: the owner reads the day in order, on Sydney's clock
 * while the browser is in UTC, a task twenty minutes away flagged "Coming up",
 * and the Reception's run of show inside its band in the order guests read it.
 * Then three schedule changes in the Events editor: the Ceremony moves and the
 * task linked to it moves with it; the Reception is removed and its task kept,
 * at its last time, marked "Event removed"; the Brunch is removed with its task.
 * Last, the dev profile's seat on another wedding (`CIRE_ORGANISER.runSheetHelper`),
 * a helper seeing their own tasks: the API answers only their task, its event
 * and that event's run of show, and nothing of the co-host's task or its event.
 * Every write is checked in cire-api's rows. No sign-in beyond the one above.
 */

import { resolve } from "node:path";

import type { Locator, Page } from "@playwright/test";

import { CIRE_ORGANISER, CLOCK_T0, DB_FILES, ORIGINS, SCREENSHOT_DIR } from "../../src/config";
import { expect, queryOne, signInToCireHost, test, type Flow } from "../support/fixtures";

const { weddingId, helper } = CIRE_ORGANISER.scope;
const RS = CIRE_ORGANISER.runSheet;
const RSH = CIRE_ORGANISER.runSheetHelper;
const weddingApi = (id: string) => `${ORIGINS.cireApi}/api/organiser/weddings/${id}`;
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

/** Resolves with the first `method` response from exactly `url`. */
function responseTo(page: Page, method: string, url: string) {
  return page.waitForResponse((r) => r.url() === url && r.request().method() === method);
}

/** A run-sheet row by its item id. */
const sheetRow = (page: Page, id: string) => page.locator(`[data-run-sheet-item="${id}"]`);

/** Text with every run of white space as one space: `Intl` puts a narrow
 *  no-break space before "am". */
const flat = (text: string | null) => (text ?? "").replace(/\s+/g, " ").trim();

/** The run sheet's rows, in order, by item id. */
async function rowIds(page: Page): Promise<string> {
  const ids = await page
    .locator("[data-run-sheet-item]")
    .evaluateAll((rows) => rows.map((row) => row.getAttribute("data-run-sheet-item")));
  return ids.join(" ");
}

/** A row's time as `<time datetime>` states it, or "none". */
async function rowTime(page: Page, id: string): Promise<string> {
  const time = sheetRow(page, id).locator("time").first();
  return (await time.count()) > 0 ? ((await time.getAttribute("datetime")) ?? "none") : "none";
}

/** A row's run of show, as it reads, `|`-joined. */
async function runOfShowOf(page: Page, id: string): Promise<string> {
  const lines = await sheetRow(page, id).locator("[data-run-of-show-item]").allTextContents();
  return lines.map(flat).join(" | ");
}

/**
 * Loads `hash` in the portal as a fresh page, from a blank one: the rows it
 * shows are the ones the API sends now, and no toast from an earlier step
 * covers a screenshot. The page clock carries over.
 */
async function freshPortal(page: Page, hash: string): Promise<void> {
  await page.goto("about:blank");
  await page.goto(`${ORIGINS.cireHost}/${hash}`);
}

/** Opens a wedding's run sheet in the module shell and waits for its read. */
async function openRunSheet(page: Page, id: string, firstRow: string): Promise<number> {
  const read = responseTo(page, "GET", `${weddingApi(id)}/run-sheet`);
  await freshPortal(page, `#/w/${id}/run-sheet`);
  const status = (await read).status();
  await expect(sheetRow(page, firstRow)).toBeVisible();
  return status;
}

/** A task row of the run-sheet wedding as cire-api stores it, or undefined. */
function taskInDb(id: string) {
  return queryOne<{
    event_id: string | null;
    run_offset_minutes: number | null;
    run_at: string | null;
    run_timezone: string | null;
    event_removed_at: number | null;
  }>(
    DB_FILES.cire,
    "SELECT event_id, run_offset_minutes, run_at, run_timezone, event_removed_at FROM tasks WHERE id = ?",
    id,
  );
}

/** The run-sheet wedding's event row in the Events editor. */
const eventRow = (page: Page, name: string) =>
  page
    .getByRole("listitem")
    .filter({ has: page.getByText(name, { exact: true }) })
    .filter({ has: page.getByRole("button", { name: "Edit", exact: true }) });

/**
 * Saves the Events editor's draft: the preview, then `choose` on the review
 * dialog, then Confirm & save. Answers the apply's status and the titles of the
 * checklist tasks the preview listed as linked to an event it removes.
 */
async function saveSchedule(
  page: Page,
  choose: (dialog: Locator) => Promise<void> = async () => {},
): Promise<{ status: number; linked: string }> {
  const api = weddingApi(RS.weddingId);
  const preview = responseTo(page, "POST", `${api}/changes/preview`);
  await page.getByRole("button", { name: "Save changes" }).click();
  const previewed = await preview;
  expect(previewed.status(), "preview").toBe(200);
  const { plan } = (await previewed.json()) as { plan: { linkedTasks?: { title: string }[] } };
  const dialog = page.getByRole("dialog", { name: "Review changes before applying" });
  await expect(dialog).toBeVisible();
  await choose(dialog);
  const apply = responseTo(page, "POST", `${api}/changes/apply`);
  const reload = responseTo(page, "GET", `${api}/events`);
  await dialog.getByRole("button", { name: "Confirm & save" }).click();
  const status = (await apply).status();
  // The editor reads its rows again after a save; let it, so the next
  // navigation does not cut it off.
  await reload;
  await expect(page.getByRole("button", { name: "Save changes" })).toBeHidden();
  return { status, linked: (plan.linkedTasks ?? []).map((t) => t.title).join(", ") || "none" };
}

/** Deletes an event from the Events editor's draft, accepting its confirm. */
async function deleteEvent(page: Page, name: string): Promise<void> {
  page.once("dialog", (confirm) => void confirm.accept());
  await eventRow(page, name).getByRole("button", { name: "Delete", exact: true }).click();
  await expect(eventRow(page, name)).toHaveCount(0);
}

/** A screenshot of the whole page, into the run's artifacts. */
function shot(page: Page, name: string) {
  return page.screenshot({
    path: resolve(SCREENSHOT_DIR, `cire-helper-scope--${name}.png`),
    fullPage: true,
    animations: "disabled",
  });
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

  // The wedding's push topic, as the portal names it (`weddingTopicUrl`).
  const topic = `cire:wedding:${weddingId}`;
  const socket = await flow.step("open the wedding's co-hosts", async () => {
    await page.goto(`${ORIGINS.cireHost}/#/w/${weddingId}/settings/hosts`);
    await expect(scopeSelect(page)).toHaveValue("own");
    // The route reaches the fixture a moment after the page opens the socket.
    const reached = await expect
      .poll(() => flow.realtimeTopics())
      .toContain(topic)
      .then(
        () => true,
        () => false,
      );
    return { reached, opened: flow.realtimeTopics().filter((t) => t === topic).length };
  });
  flow.check("the helper starts on their own tasks", "helper/own", seatInDb());
  // A socket that missed the stand-in would meet cire-api's 404, retry, and
  // post the fallback beacon at a moment no two runs share.
  flow.check(
    "portal: the co-hosts page's push socket reached the hub stand-in",
    true,
    socket.reached,
  );
  flow.check("portal: the co-hosts page opened one push socket for its wedding", 1, socket.opened);

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
    await scopeSelect(page).scrollIntoViewIfNeeded();
    await shot(page, "scope");
    return status;
  });
  flow.check("made a helper again", 200, toHelper);
  flow.check("wedding_hosts row as a helper again: own tasks", "helper/own", seatInDb());
  // The scope and role writes above must not reopen the socket: a reopen's
  // re-read would land in some runs only.
  flow.check(
    "portal: the co-hosts page still holds one push socket after the role changes",
    1,
    flow.realtimeTopics().filter((t) => t === topic).length,
  );

  // ── The run sheet ──────────────────────────────────────────────────────────
  // 10:05 in Sydney on the day, held: Greet the celebrant, at 10:20, is coming
  // up, and every flag reads the same on every run.
  await page.clock.setFixedTime(CLOCK_T0 + 5 * 60_000);

  const owner = await flow.step("open the run sheet as its owner", async () => {
    await page.setViewportSize({ width: 1280, height: 900 });
    const status = await openRunSheet(page, RS.weddingId, RS.tasks.greet.id);
    const read = {
      status,
      rows: await rowIds(page),
      greetTime: await rowTime(page, RS.tasks.greet.id),
      greetText: flat(
        await sheetRow(page, RS.tasks.greet.id).locator("time").first().textContent(),
      ),
      greetComingUp:
        (await sheetRow(page, RS.tasks.greet.id).getAttribute("data-coming-up")) !== null,
      greetOwn: (await sheetRow(page, RS.tasks.greet.id).getAttribute("data-own")) !== null,
      cakeComingUp:
        (await sheetRow(page, RS.tasks.cake.id).getAttribute("data-coming-up")) !== null,
      cakeOwn: (await sheetRow(page, RS.tasks.cake.id).getAttribute("data-own")) !== null,
      receptionRunOfShow: await runOfShowOf(page, RS.events.reception.id),
    };
    await sheetRow(page, RS.events.reception.id).scrollIntoViewIfNeeded();
    await shot(page, "run-sheet-owner");
    return read;
  });
  flow.check("owner: run sheet read", 200, owner.status);
  flow.check(
    "owner: the day in order, untimed last, a 1m task not on it",
    [
      RS.tasks.greet.id,
      RS.events.ceremony.id,
      RS.tasks.cake.id,
      RS.events.reception.id,
      RS.tasks.hamper.id,
      RS.events.brunch.id,
      RS.tasks.rings.id,
    ].join(" "),
    owner.rows,
  );
  flow.check(
    "owner: Greet the celebrant 40 min before the Ceremony",
    "2026-10-01T10:20:00+10:00",
    owner.greetTime,
  );
  flow.check("owner: shown on Sydney's clock, the browser in UTC", "10:20 am", owner.greetText);
  flow.check("owner: Greet the celebrant is coming up at 10:05", true, owner.greetComingUp);
  flow.check("owner: the cake table, at 5 pm, is not", false, owner.cakeComingUp);
  flow.check("owner: their own task says You", true, owner.greetOwn);
  flow.check("owner: the helper's task does not", false, owner.cakeOwn);
  flow.check(
    "owner: the Reception's run of show, from its start, after midnight last",
    RS.receptionRunOfShow.join(" | "),
    owner.receptionRunOfShow,
  );

  const moved = await flow.step("move the Ceremony to 11:30 in the Events editor", async () => {
    await page.goto(`${ORIGINS.cireHost}/#/w/${RS.weddingId}/events/edit`);
    await eventRow(page, RS.events.ceremony.name)
      .getByRole("button", { name: "Edit", exact: true })
      .click();
    const drawer = page.getByRole("dialog", { name: "Edit event" });
    await expect(drawer).toBeVisible();
    await drawer.getByLabel("Start time").fill(RS.events.ceremony.movedStart);
    await drawer.getByRole("button", { name: "Done" }).click();
    await expect(drawer).toBeHidden();
    return saveSchedule(page);
  });
  flow.check("Ceremony moved", 200, moved.status);
  flow.check("moving an event lists no linked task", "none", moved.linked);
  const greetRow = taskInDb(RS.tasks.greet.id);
  flow.check(
    "tasks row: Greet the celebrant still linked, 40 min before",
    `${RS.events.ceremony.id} / -40 / null`,
    `${greetRow?.event_id} / ${greetRow?.run_offset_minutes} / ${greetRow?.run_at}`,
  );

  const afterMove = await flow.step("read the run sheet after the move", async () => {
    await openRunSheet(page, RS.weddingId, RS.tasks.greet.id);
    await expect(sheetRow(page, RS.tasks.greet.id).locator("time").first()).toHaveAttribute(
      "datetime",
      "2026-10-01T10:50:00+10:00",
    );
    return {
      greetTime: await rowTime(page, RS.tasks.greet.id),
      greetComingUp:
        (await sheetRow(page, RS.tasks.greet.id).getAttribute("data-coming-up")) !== null,
    };
  });
  flow.check(
    "the linked task moved with its event",
    "2026-10-01T10:50:00+10:00",
    afterMove.greetTime,
  );
  flow.check("and at 10:50 it is no longer coming up at 10:05", false, afterMove.greetComingUp);

  const kept = await flow.step("remove the Reception, keeping its task", async () => {
    await page.goto(`${ORIGINS.cireHost}/#/w/${RS.weddingId}/events/edit`);
    await deleteEvent(page, RS.events.reception.name);
    let ticked = true;
    const saved = await saveSchedule(page, async (dialog) => {
      ticked = await dialog
        .getByRole("checkbox", { name: "Also remove this task from the checklist" })
        .isChecked();
    });
    return { ...saved, ticked };
  });
  flow.check("Reception removed", 200, kept.status);
  flow.check(
    "the preview lists the task linked to the Reception",
    RS.tasks.cake.title,
    kept.linked,
  );
  flow.check("the choice starts unticked: keep", false, kept.ticked);
  const cakeRow = taskInDb(RS.tasks.cake.id);
  flow.check(
    "tasks row: the cake table unlinked, at its last time, on the event's clock",
    `null / null / ${RS.cakeFrozenAt} / Australia/Sydney`,
    `${cakeRow?.event_id} / ${cakeRow?.run_offset_minutes} / ${cakeRow?.run_at} / ${cakeRow?.run_timezone}`,
  );
  flow.check(
    "tasks row: the cake table marked event removed",
    true,
    (cakeRow?.event_removed_at ?? null) !== null,
  );

  const removed = await flow.step("remove the Brunch with its task", async () => {
    // A fresh editor: the Reception save's toast would cover "Save changes"
    // for its full four seconds.
    await freshPortal(page, `#/w/${RS.weddingId}/events/edit`);
    await deleteEvent(page, RS.events.brunch.name);
    return saveSchedule(page, async (dialog) => {
      await dialog
        .getByRole("checkbox", { name: "Also remove this task from the checklist" })
        .check();
    });
  });
  flow.check("Brunch removed", 200, removed.status);
  flow.check(
    "the preview lists the task linked to the Brunch",
    RS.tasks.hamper.title,
    removed.linked,
  );
  flow.check(
    "tasks row: the hamper removed with the Brunch",
    "missing",
    taskInDb(RS.tasks.hamper.id) ? "present" : "missing",
  );

  const afterRemovals = await flow.step("read the run sheet after the removals", async () => {
    await openRunSheet(page, RS.weddingId, RS.tasks.cake.id);
    await expect(sheetRow(page, RS.tasks.cake.id)).toContainText("Event removed");
    const read = {
      rows: await rowIds(page),
      cakeTime: await rowTime(page, RS.tasks.cake.id),
      cakeText: flat(await sheetRow(page, RS.tasks.cake.id).textContent()),
    };
    await shot(page, "run-sheet-owner-after-changes");
    return read;
  });
  flow.check(
    "the day after the changes",
    [RS.tasks.greet.id, RS.events.ceremony.id, RS.tasks.cake.id, RS.tasks.rings.id].join(" "),
    afterRemovals.rows,
  );
  flow.check("the kept task at its last time", RS.cakeFrozenAt, afterRemovals.cakeTime);
  flow.check(
    "the kept task says its event was removed",
    true,
    afterRemovals.cakeText.includes("Event removed"),
  );

  // ── A helper who sees their own tasks ─────────────────────────────────────
  const seat = await flow.step("open the wedding the dev profile helps on", async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    const read = responseTo(page, "GET", `${weddingApi(RSH.weddingId)}/run-sheet`);
    await freshPortal(page, `#/w/${RSH.weddingId}`);
    const response = await read;
    const raw = await response.text();
    await expect(page.getByTestId("run-sheet-seat")).toBeVisible();
    await expect(sheetRow(page, RSH.programmes.id)).toBeVisible();
    await expect(page.getByText("Your tasks for the day")).toBeVisible();
    const view = {
      status: response.status(),
      raw,
      rows: await rowIds(page),
      arrivalRunOfShow: await runOfShowOf(page, RSH.arrival.id),
      programmesOwn: (await sheetRow(page, RSH.programmes.id).getAttribute("data-own")) !== null,
    };
    await shot(page, "run-sheet-helper");
    return view;
  });
  type Item = { kind: string; id: string; runOfShow?: { time: string; label: string }[] } & Record<
    string,
    unknown
  >;
  const answer = JSON.parse(seat.raw) as {
    scope: string;
    viewerHostId: string;
    items: Item[];
    people: ({ hostId: string } & Record<string, unknown>)[];
  };
  const ofKind = (kind: string) =>
    answer.items
      .filter((i) => i.kind === kind)
      .map((i) => i.id)
      .join(" ");
  const arrival = answer.items.find((i) => i.id === RSH.arrival.id);
  flow.check("helper: run sheet read", 200, seat.status);
  flow.check(
    "helper: scope own, their own seat",
    `own / ${RSH.seatId}`,
    `${answer.scope} / ${answer.viewerHostId}`,
  );
  flow.check("helper: only their task", RSH.programmes.id, ofKind("task"));
  flow.check("helper: only its event", RSH.arrival.id, ofKind("event"));
  flow.check(
    "helper: an event's fields, exactly",
    "address endAt id kind name runOfShow startAt timezone venueName",
    Object.keys(arrival ?? {})
      .toSorted()
      .join(" "),
  );
  flow.check(
    "helper: that event's run of show",
    `14:45 ${RSH.arrival.runOfShow}`,
    (arrival?.runOfShow ?? []).map((i) => `${i.time} ${i.label}`).join(" | "),
  );
  flow.check(
    "helper: only themselves among the people",
    RSH.seatId,
    answer.people.map((p) => p.hostId).join(" "),
  );
  flow.check(
    "helper: a person comes with no OSN profile id",
    false,
    answer.people.some((p) => "osnProfileId" in p),
  );
  flow.check(
    "helper: nothing of the co-host's task, its event or its run of show",
    "none",
    [
      RSH.cue.title,
      RSH.cue.id,
      RSH.speeches.name,
      RSH.speeches.id,
      RSH.speeches.runOfShow,
      RSH.owner.hostId,
      RSH.owner.profileId,
    ]
      .filter((secret) => seat.raw.includes(secret))
      .join(", ") || "none",
  );
  flow.check(
    "helper: the seat shows their task and its event",
    `${RSH.programmes.id} ${RSH.arrival.id}`,
    seat.rows,
  );
  flow.check(
    "helper: the run of show inside its event",
    `2:45 pm ${RSH.arrival.runOfShow}`,
    seat.arrivalRunOfShow,
  );
  flow.check("helper: their task says You", true, seat.programmesOwn);
});
