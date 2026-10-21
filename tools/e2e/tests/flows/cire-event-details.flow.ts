/**
 * Cire: an organiser fills in an event's details in the portal's event drawer
 * and saves, then previews the invitation the way "Preview invite" does.
 *
 * The drawer gives the Kitchen Tea a venue name, a description, a run of show
 * (three items typed out of time order, one moved with the keyboard), a
 * getting-there note and a guest policy. The rows land in the database; a
 * reload reads all of it back; a second save changes some of it and a revert
 * of that save puts it back; and a download of the events sheet re-uploaded
 * through the spreadsheet door changes nothing and warns of nothing. The
 * Events list then shows the run of show as guests read it, the policy and
 * the notes.
 *
 * The guest side: the claim response carries all of it, and the public invite
 * read none of it. The event's details show the facts with the guest policy
 * last among them, then the run of show in time order, then About, then
 * Getting there. The preview's household (the organiser's own, which may bring
 * no plus-one) is neither sent nor told that plus-ones are welcome; Eli's
 * household, once the organiser allows Eli one, is both. The calendar file
 * carries the venue name and the description.
 *
 * The organiser signs in with osn-api's dev sign-in (the dev principal owns
 * the sample wedding) and then cire's own OIDC sign-in, where osn-api, with a
 * session and a first-party client, issues a code straight back to cire-api:
 * Musubi's `/authorize` page never loads. Both invitations are claimed from
 * the organiser's own address (`claimFromOrganiserAddress`), so they spend the
 * organiser's window of cire-api's claim limit, not the guests'.
 *
 * The edited event is the sample wedding's Kitchen Tea, and the household
 * allowed a plus-one is Eli's; no other flow reads either, so the edits change
 * nothing another flow sees.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { Page } from "@playwright/test";

import {
  CIRE_EVENT_EDIT,
  DB_FILES,
  DEV_LOGIN_SECRET,
  ORIGINS,
  SCREENSHOT_DIR,
} from "../../src/config";
import {
  claimFromOrganiserAddress,
  cookieNamed,
  expect,
  onSuiteClock,
  queryOne,
  test,
} from "../support/fixtures";

const WEDDING_API = `${ORIGINS.cireApi}/api/organiser/weddings/${CIRE_EVENT_EDIT.weddingId}`;
const CLAIM_URL = `${ORIGINS.cireApi}/api/claim`;

/** A phone, where the event sheet is a bottom sheet, and a desktop. */
const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 800 };

/** Resolves with the first `method` request to exactly `url`. */
function responseTo(page: Page, method: string, url: string) {
  return page.waitForResponse((r) => r.url() === url && r.request().method() === method);
}

/** RFC 5545 text escaping, as `calendar.ts` writes it. */
function icsText(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
}

/** A screenshot of the viewport, into the run's artifacts. */
function shot(page: Page, name: string) {
  return page.screenshot({
    path: resolve(SCREENSHOT_DIR, `cire-event-details--${name}.png`),
    animations: "disabled",
  });
}

interface ClaimedEvent {
  name: string;
  description: string;
  venueName?: string | null;
  address: string | null;
  runOfShow?: { time: string; label: string }[];
  gettingThere?: string | null;
  childrenPolicy?: string | null;
  plusOnePolicy?: string | null;
  guestPolicyNote?: string | null;
}

/** A run of show as one comparable string: `HH:MM label` items, `|`-joined. */
const joined = (items: readonly { time: string; label: string }[]) =>
  items.map((i) => `${i.time} ${i.label}`).join(" | ");

const [SPEECHES, TEA, GAMES] = CIRE_EVENT_EDIT.runOfShow;
/** The organiser's order once the flow has moved Tea up. */
const ORGANISER_ORDER = joined([TEA, SPEECHES, GAMES]);
/** The guest policy as stored, the two presets and the note. */
const STORED_POLICY = `adults_only / welcome / ${CIRE_EVENT_EDIT.policyNote}`;

test("cire-event-details", async ({ page, context, flow }) => {
  await claimFromOrganiserAddress(context);

  const authorizePages: string[] = [];
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame() && frame.url().startsWith(`${ORIGINS.musubi}/authorize`)) {
      authorizePages.push(frame.url());
    }
  });

  const kitchenTea = page
    .getByRole("listitem")
    .filter({ has: page.getByText(CIRE_EVENT_EDIT.event, { exact: true }) })
    .filter({ has: page.getByRole("button", { name: "Edit", exact: true }) });

  await flow.step("sign in to the portal", async () => {
    // The login page sends the organiser on to `returnTo` once signed in.
    const login = `${ORIGINS.cireHost}/login?${new URLSearchParams({
      returnTo: `/#/w/${CIRE_EVENT_EDIT.weddingId}/events/edit`,
    })}`;
    const probe = responseTo(page, "GET", `${ORIGINS.cireApi}/api/auth/session`);
    await page.goto(
      `${ORIGINS.osnApi}/dev/login?${new URLSearchParams({ secret: DEV_LOGIN_SECRET, return_to: login })}`,
    );
    await expect(page).toHaveURL(/\/login\?/);
    // The page asks cire-api who is signed in as it mounts; let that answer
    // before navigating away, so its request is in the record on every run.
    await probe;

    const head = responseTo(page, "GET", `${WEDDING_API}/changes/head`);
    const rows = responseTo(page, "GET", `${WEDDING_API}/events`);
    await page.getByRole("button", { name: "Continue with musubi" }).click();
    expect((await head).status(), "head read").toBe(200);
    expect((await rows).status(), "events read").toBe(200);
    await expect(kitchenTea).toBeVisible();
  });

  flow.check("Musubi /authorize page not shown", 0, authorizePages.length);
  const session = await cookieNamed(context, ORIGINS.cireApi, "cire_org_session");
  flow.check("cire_org_session set by cire-api", true, session !== undefined);
  flow.check("cire_org_session is HttpOnly", true, session?.httpOnly ?? false);

  const drawer = page.getByRole("dialog", { name: "Edit event" });
  /** The drawer's run of show, in its order, as one comparable string. */
  const drawerRunOfShow = async () => {
    const items: { time: string; label: string }[] = [];
    for (let i = 1; await drawer.getByLabel(`Item ${i}`, { exact: true }).count(); i += 1) {
      items.push({
        time: await drawer.getByLabel(`Time of item ${i}`, { exact: true }).inputValue(),
        label: await drawer.getByLabel(`Item ${i}`, { exact: true }).inputValue(),
      });
    }
    return joined(items);
  };

  await flow.step("give the Kitchen Tea a venue name and a description", async () => {
    await kitchenTea.getByRole("button", { name: "Edit", exact: true }).click();
    await expect(drawer).toBeVisible();
    await drawer.getByLabel("Venue name").fill(CIRE_EVENT_EDIT.venueName);
    const description = drawer.getByLabel("Description", { exact: true });
    await description.fill(CIRE_EVENT_EDIT.description);
    await description.scrollIntoViewIfNeeded();
    await shot(page, "drawer");
  });

  const drawerOrder = await flow.step(
    "give it a run of show, moving one item up with the keyboard",
    async () => {
      const add = drawer.getByRole("button", { name: "Add item" });
      // The time each new item opens with, before the flow types its own.
      const seeded: string[] = [];
      for (const [i, item] of CIRE_EVENT_EDIT.runOfShow.entries()) {
        await add.click();
        const time = drawer.getByLabel(`Time of item ${i + 1}`, { exact: true });
        seeded.push(await time.inputValue());
        await time.fill(item.time);
        await drawer.getByLabel(`Item ${i + 1}`, { exact: true }).fill(item.label);
      }
      // The keyboard path: focus the item's grip and press Arrow Up.
      await drawer.getByRole("button", { name: new RegExp(`^Reorder ${TEA.label},`) }).focus();
      await page.keyboard.press("ArrowUp");
      await expect(drawer.getByLabel("Item 1", { exact: true })).toHaveValue(TEA.label);
      return { order: await drawerRunOfShow(), seeded: seeded.join(" | ") };
    },
  );
  flow.check(
    "a new item opens at the time of the item before it, the first empty",
    ` | ${SPEECHES.time} | ${TEA.time}`,
    drawerOrder.seeded,
  );
  flow.check(
    "the drawer holds the run of show in the organiser's order",
    ORGANISER_ORDER,
    drawerOrder.order,
  );

  await flow.step("give it getting-there notes and a guest policy", async () => {
    await drawer.getByLabel("Getting there (optional)").fill(CIRE_EVENT_EDIT.gettingThere);
    await drawer
      .getByLabel("Children", { exact: true })
      .selectOption({ label: CIRE_EVENT_EDIT.children });
    await drawer
      .getByLabel("Plus-ones", { exact: true })
      .selectOption({ label: CIRE_EVENT_EDIT.plusOnes });
    await drawer.getByLabel("Note", { exact: true }).fill(CIRE_EVENT_EDIT.policyNote);
    // The drawer at both widths: its top, its run of show and its policy.
    for (const [label, size] of [
      ["1280", DESKTOP],
      ["390", PHONE],
    ] as const) {
      await page.setViewportSize(size);
      await drawer.getByLabel("Event name").scrollIntoViewIfNeeded();
      await shot(page, `drawer-${label}-top`);
      await drawer.getByTestId("run-of-show").scrollIntoViewIfNeeded();
      await shot(page, `drawer-${label}-run-of-show`);
      await drawer.getByLabel("Note", { exact: true }).scrollIntoViewIfNeeded();
      await shot(page, `drawer-${label}-guest-policy`);
    }
    await page.setViewportSize(DESKTOP);
    await drawer.getByRole("button", { name: "Done" }).click();
    await expect(drawer).toBeHidden();
  });

  /** Save, confirm in the preview, and wait for the editor to reload its rows. */
  const saveSchedule = async () => {
    const preview = responseTo(page, "POST", `${WEDDING_API}/changes/preview`);
    await page.getByRole("button", { name: "Save changes" }).click();
    const previewed = await preview;
    expect(previewed.status(), "preview").toBe(200);
    const { warnings, changeId } = (await previewed.json()) as {
      warnings: string[];
      changeId: string;
    };

    const apply = responseTo(page, "POST", `${WEDDING_API}/changes/apply`);
    const reload = responseTo(page, "GET", `${WEDDING_API}/events`);
    await page
      .getByRole("dialog", { name: "Review changes before applying" })
      .getByRole("button", { name: "Confirm & save" })
      .click();
    const status = (await apply).status();
    // The editor reloads its rows after a save; wait for that too, so the
    // next navigation does not cut it off.
    await reload;
    await expect(page.getByRole("button", { name: "Save changes" })).toBeHidden();
    return { status, warnings, changeId };
  };

  const kitchenTeaRow = () =>
    queryOne<{
      description: string;
      venue_name: string | null;
      address: string | null;
      dress_code_description: string | null;
      getting_there: string | null;
      children_policy: string | null;
      plus_one_policy: string | null;
      guest_policy_note: string | null;
      updated_at: number;
    }>(
      DB_FILES.cire,
      "SELECT description, venue_name, address, dress_code_description, getting_there, children_policy, plus_one_policy, guest_policy_note, updated_at FROM events WHERE wedding_id = ? AND name = ?",
      CIRE_EVENT_EDIT.weddingId,
      CIRE_EVENT_EDIT.event,
    );
  /** The guest policy columns of a row, as one comparable string. */
  const policyOf = (r: ReturnType<typeof kitchenTeaRow>) =>
    `${r?.children_policy} / ${r?.plus_one_policy} / ${r?.guest_policy_note}`;
  /** The Kitchen Tea's run of show as stored, in the organiser's order. */
  const storedRunOfShow = () =>
    queryOne<{ items: string | null }>(
      DB_FILES.cire,
      "SELECT group_concat(time || ' ' || label, ' | ') AS items FROM (SELECT r.time, r.label FROM run_of_show_items r JOIN events e ON e.id = r.event_id WHERE e.wedding_id = ? AND e.name = ? ORDER BY r.sort_order)",
      CIRE_EVENT_EDIT.weddingId,
      CIRE_EVENT_EDIT.event,
    )?.items ?? "";

  const seededDressCode = kitchenTeaRow()?.dress_code_description ?? "missing";

  const applied = await flow.step("save the schedule", saveSchedule);
  flow.check("change applied", 200, applied.status);
  flow.check("the preview warned of nothing", 0, applied.warnings.length);

  const row = kitchenTeaRow();
  flow.check("events row venue_name", CIRE_EVENT_EDIT.venueName, row?.venue_name ?? "missing");
  flow.check("events row description", CIRE_EVENT_EDIT.description, row?.description ?? "missing");
  flow.check("events row address unchanged", CIRE_EVENT_EDIT.address, row?.address ?? "missing");
  flow.check("events row written on the suite clock", true, onSuiteClock(row?.updated_at));
  flow.check(
    "events row getting_there",
    CIRE_EVENT_EDIT.gettingThere,
    row?.getting_there ?? "missing",
  );
  flow.check("events row guest policy", STORED_POLICY, policyOf(row));
  flow.check(
    "run_of_show_items rows, in the organiser's order",
    ORGANISER_ORDER,
    storedRunOfShow(),
  );

  const readBack = await flow.step("reload the editor and open the Kitchen Tea again", async () => {
    // A fresh page, so the drawer holds what `GET …/events` sent, not what
    // was typed.
    const rows = responseTo(page, "GET", `${WEDDING_API}/events`);
    await page.reload();
    expect((await rows).status(), "events read").toBe(200);
    await kitchenTea.getByRole("button", { name: "Edit", exact: true }).click();
    await expect(drawer).toBeVisible();
    const selected = (label: string) =>
      drawer
        .getByLabel(label, { exact: true })
        .evaluate((el: HTMLSelectElement) => el.selectedOptions[0]?.label ?? "");
    const values = {
      venueName: await drawer.getByLabel("Venue name").inputValue(),
      description: await drawer.getByLabel("Description", { exact: true }).inputValue(),
      runOfShow: await drawerRunOfShow(),
      gettingThere: await drawer.getByLabel("Getting there (optional)").inputValue(),
      policy: `${await selected("Children")} / ${await selected("Plus-ones")} / ${await drawer
        .getByLabel("Note", { exact: true })
        .inputValue()}`,
    };
    // The second save: the dress code, one item fewer, other notes, and the
    // children preset and the policy note cleared.
    await drawer.getByLabel("Dress code description").fill(CIRE_EVENT_EDIT.dressCode);
    await drawer.getByRole("button", { name: `Remove ${GAMES.label}` }).click();
    await drawer.getByLabel("Getting there (optional)").fill(CIRE_EVENT_EDIT.gettingThereChanged);
    await drawer.getByLabel("Children", { exact: true }).selectOption({ label: "Not stated" });
    await drawer.getByLabel("Note", { exact: true }).fill("");
    await drawer.getByRole("button", { name: "Done" }).click();
    await expect(drawer).toBeHidden();
    return values;
  });
  flow.check("the drawer reads the venue name back", CIRE_EVENT_EDIT.venueName, readBack.venueName);
  flow.check(
    "the drawer reads the description back",
    CIRE_EVENT_EDIT.description,
    readBack.description,
  );
  flow.check("the drawer reads the run of show back", ORGANISER_ORDER, readBack.runOfShow);
  flow.check(
    "the drawer reads the getting-there notes back",
    CIRE_EVENT_EDIT.gettingThere,
    readBack.gettingThere,
  );
  flow.check(
    "the drawer reads the guest policy back",
    `${CIRE_EVENT_EDIT.children} / ${CIRE_EVENT_EDIT.plusOnes} / ${CIRE_EVENT_EDIT.policyNote}`,
    readBack.policy,
  );

  const resaved = await flow.step("save a change to another field", saveSchedule);
  flow.check("second change applied", 200, resaved.status);
  flow.check(
    "the second preview names what the save clears",
    `Event "${CIRE_EVENT_EDIT.event}" would lose its children policy and guest policy note.`,
    resaved.warnings.join(" | "),
  );

  const kept = kitchenTeaRow();
  flow.check(
    "events row dress code changed",
    CIRE_EVENT_EDIT.dressCode,
    kept?.dress_code_description ?? "missing",
  );
  flow.check(
    "events row keeps the venue name",
    CIRE_EVENT_EDIT.venueName,
    kept?.venue_name ?? "missing",
  );
  flow.check(
    "events row keeps the description",
    CIRE_EVENT_EDIT.description,
    kept?.description ?? "missing",
  );
  flow.check(
    "the second save's getting-there notes",
    CIRE_EVENT_EDIT.gettingThereChanged,
    kept?.getting_there ?? "missing",
  );
  flow.check(
    "the second save's run of show lost an item",
    joined([TEA, SPEECHES]),
    storedRunOfShow(),
  );
  flow.check(
    "the second save clears the children preset and the note",
    "null / welcome / null",
    policyOf(kept),
  );

  const reverted = await flow.step("revert the second change", () =>
    page.evaluate(
      async ({ url, changeId }) => {
        const response = await fetch(url, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ changeId }),
        });
        return response.status;
      },
      { url: `${WEDDING_API}/changes/revert`, changeId: resaved.changeId },
    ),
  );
  flow.check("revert applied", 200, reverted);
  const restored = kitchenTeaRow();
  flow.check("the revert restores the run of show", ORGANISER_ORDER, storedRunOfShow());
  flow.check(
    "the revert restores the getting-there notes",
    CIRE_EVENT_EDIT.gettingThere,
    restored?.getting_there ?? "missing",
  );
  flow.check("the revert restores the guest policy", STORED_POLICY, policyOf(restored));
  flow.check(
    "the revert restores the dress code",
    seededDressCode,
    restored?.dress_code_description ?? "missing",
  );

  const roundTrip = await flow.step("download the events sheet and upload it again", () =>
    page.evaluate(async (api) => {
      const post = (path: string, body: object) =>
        fetch(`${api}${path}`, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
      const download = await fetch(`${api}/export/events.csv`, { credentials: "include" });
      const eventsCsv = await download.text();
      const preview = await post("/changes/preview", { eventsCsv });
      const previewed = (await preview.json()) as { changeId: string; warnings: string[] };
      const apply = await post("/changes/apply", { changeId: previewed.changeId });
      return {
        download: download.status,
        eventsCsv,
        preview: preview.status,
        warnings: previewed.warnings.length,
        apply: apply.status,
      };
    }, WEDDING_API),
  );
  flow.check("events sheet downloaded", 200, roundTrip.download);
  flow.check(
    "the sheet's Run of Show cell, one item per line",
    true,
    roundTrip.eventsCsv.includes(
      `"${[TEA, SPEECHES, GAMES].map((i) => `${i.time} ${i.label}`).join("\n")}"`,
    ),
  );
  flow.check(
    "the sheet's guest policy cells",
    true,
    roundTrip.eventsCsv.includes(
      `,${CIRE_EVENT_EDIT.children},${CIRE_EVENT_EDIT.plusOnes},${CIRE_EVENT_EDIT.policyNote}`,
    ),
  );
  flow.check("the re-upload previews", 200, roundTrip.preview);
  flow.check("the re-upload warns of nothing", 0, roundTrip.warnings);
  flow.check("the re-upload applies", 200, roundTrip.apply);
  const afterRoundTrip = kitchenTeaRow();
  flow.check("the round trip keeps the run of show", ORGANISER_ORDER, storedRunOfShow());
  flow.check(
    "the round trip keeps the getting-there notes",
    CIRE_EVENT_EDIT.gettingThere,
    afterRoundTrip?.getting_there ?? "missing",
  );
  flow.check("the round trip keeps the guest policy", STORED_POLICY, policyOf(afterRoundTrip));

  const listed = await flow.step("read the Kitchen Tea in the events list", async () => {
    await page.goto(`${ORIGINS.cireHost}/#/w/${CIRE_EVENT_EDIT.weddingId}/events/list`);
    // A fresh page, so the list shows what `GET …/events` sends after the
    // round trip, not rows the editor held.
    const rows = responseTo(page, "GET", `${WEDDING_API}/events`);
    await page.reload();
    expect((await rows).status(), "events read").toBe(200);
    const card = page
      .getByRole("listitem")
      .filter({ has: page.getByText(CIRE_EVENT_EDIT.event, { exact: true }) });
    const detail = (term: string) =>
      card.locator("dt").filter({ hasText: term }).locator("xpath=following-sibling::dd[1]");
    await expect(detail("Run of show")).toBeVisible();
    await detail("Run of show").scrollIntoViewIfNeeded();
    await shot(page, "events-list-1280");
    return {
      runOfShow: (await detail("Run of show").textContent()) ?? "",
      policy: (await detail("Guest policy").textContent()) ?? "",
      gettingThere: (await detail("Getting there").textContent()) ?? "",
    };
  });
  flow.check(
    "the events list shows the run of show in the order guests read it",
    "4:00 pm  Tea is poured\n4:45 pm  Garden games\n5:15 pm  Speeches",
    listed.runOfShow,
  );
  flow.check(
    "the events list shows the guest policy, presets then the note",
    `Adults only\nPlus-ones welcome\n${CIRE_EVENT_EDIT.policyNote}`,
    listed.policy,
  );
  flow.check(
    "the events list shows the getting-there notes",
    CIRE_EVENT_EDIT.gettingThere,
    listed.gettingThere,
  );

  // Eli is allowed a plus-one now, from the portal's own origin, so that
  // Eli's household is one that may hear plus-ones are welcome. The id is the
  // stack's own: the seed mints one per run.
  const eli = queryOne<{ id: string }>(
    DB_FILES.cire,
    "SELECT g.id AS id FROM guests g JOIN families f ON f.id = g.family_id WHERE f.public_id = ? AND g.first_name = ?",
    CIRE_EVENT_EDIT.allowedGuest.code,
    CIRE_EVENT_EDIT.allowedGuest.firstName,
  );
  const allowed = await flow.step("allow Eli a plus-one", () =>
    page.evaluate(
      async (url) => {
        const response = await fetch(url, {
          method: "PUT",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ allowed: true }),
        });
        return response.status;
      },
      `${WEDDING_API}/guests/${encodeURIComponent(eli?.id ?? "missing")}/plus-one`,
    ),
  );
  flow.check("Eli allowed a plus-one", 200, allowed);

  const claimed = await flow.step("open the invitation from Preview invite", async () => {
    // What the button asks for before it opens the invitation.
    const minted = await page.evaluate(async (url) => {
      const response = await fetch(url, { method: "POST", credentials: "include" });
      return { status: response.status, ...((await response.json()) as { publicId: string }) };
    }, `${WEDDING_API}/preview-code`);
    expect(minted.status, "preview code").toBe(200);

    await page.setViewportSize(PHONE);
    const claim = responseTo(page, "POST", CLAIM_URL);
    await page.goto(
      `${ORIGINS.cireInvites}/cire/invite?slug=${CIRE_EVENT_EDIT.slug}&code=${encodeURIComponent(minted.publicId)}`,
    );
    const response = await claim;
    const body = (await response.json()) as { events: ClaimedEvent[] };
    await expect(page.getByText("Preview mode. Every event is shown")).toBeVisible();
    return {
      status: response.status(),
      event: body.events.find((e) => e.name === CIRE_EVENT_EDIT.event),
    };
  });
  flow.check("claim with the preview code", 200, claimed.status);
  flow.check(
    "claim response carries the venue name",
    CIRE_EVENT_EDIT.venueName,
    claimed.event?.venueName ?? "missing",
  );
  flow.check(
    "claim response carries the description",
    CIRE_EVENT_EDIT.description,
    claimed.event?.description ?? "missing",
  );
  flow.check(
    "claim response carries the run of show, in the organiser's order",
    ORGANISER_ORDER,
    joined(claimed.event?.runOfShow ?? []),
  );
  flow.check(
    "claim response carries the getting-there notes",
    CIRE_EVENT_EDIT.gettingThere,
    claimed.event?.gettingThere ?? "missing",
  );
  // The preview household may bring no plus-one, so "welcome" is not sent to
  // it; the children preset and the note are.
  flow.check(
    "claim response carries the guest policy, without welcome for a household that may bring no one",
    `adults_only / null / ${CIRE_EVENT_EDIT.policyNote}`,
    `${claimed.event?.childrenPolicy} / ${claimed.event?.plusOnePolicy} / ${claimed.event?.guestPolicyNote}`,
  );

  await flow.step("decline optional storage", async () => {
    // The consent prompt is an idle-hydrated island: wait for it rather than race it.
    const prompt = page.getByRole("dialog", { name: "Privacy choices" });
    await expect(prompt).toBeVisible({ timeout: 60_000 });
    await prompt.getByRole("button", { name: "Reject all" }).click();
    await expect(prompt).toBeHidden();
  });

  const sheet = page.getByRole("dialog");
  const details = sheet.locator('[data-panel="details"]');
  const openKitchenTea = async () => {
    await page
      .getByRole("article")
      .filter({ has: page.getByRole("heading", { name: CIRE_EVENT_EDIT.event }) })
      .getByRole("button", { name: "Event Details" })
      .click();
    await expect(
      sheet.getByRole("heading", { name: new RegExp(`^Details.*${CIRE_EVENT_EDIT.event}`) }),
    ).toBeVisible();
  };

  const where = await flow.step("open the Kitchen Tea's details", async () => {
    await openKitchenTea();
    const name = details.getByText(CIRE_EVENT_EDIT.venueName, { exact: true });
    const address = details.getByText(CIRE_EVENT_EDIT.address, { exact: true });
    await expect(name).toBeVisible();
    await expect(address).toBeVisible();
    await shot(page, "sheet");
    const nameBox = (await name.boundingBox())!;
    const addressBox = (await address.boundingBox())!;
    return { nameAbove: nameBox.y + nameBox.height <= addressBox.y };
  });
  flow.check("the venue name sits above the address", true, where.nameAbove);

  const layout = await flow.step("read the sheet's blocks, in order", async () => {
    await expect(details.getByText(CIRE_EVENT_EDIT.policyNote, { exact: true })).toBeVisible();
    const read = await details.evaluate((panel) => {
      const sections = [...panel.querySelectorAll("h4")];
      const dl = panel.querySelector("dl");
      const runOfShow = sections.find((h) => h.textContent === "Run of show");
      return {
        terms: [...panel.querySelectorAll("dt")].map((dt) => dt.textContent?.trim()).join(" | "),
        sections: sections.map((h) => h.textContent).join(" | "),
        factsFirst:
          dl !== null &&
          runOfShow !== undefined &&
          (dl.compareDocumentPosition(runOfShow) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
        lines: [...panel.querySelectorAll("ol > li")]
          .map((li) => li.textContent?.replace(/\s+/g, " ").trim())
          .join(" | "),
        policy: panel.querySelector("dl > div:last-child dd p")?.textContent ?? "",
        text: panel.textContent ?? "",
      };
    });
    // The sheet at both widths: the facts, the run of show, getting there.
    for (const [label, size] of [
      ["390", PHONE],
      ["1280", DESKTOP],
    ] as const) {
      await page.setViewportSize(size);
      await sheet.getByRole("heading", { name: /^Details/ }).scrollIntoViewIfNeeded();
      await shot(page, `sheet-${label}-facts`);
      await details.getByText("Run of show", { exact: true }).scrollIntoViewIfNeeded();
      await shot(page, `sheet-${label}-run-of-show`);
      await details.getByText("Getting there", { exact: true }).scrollIntoViewIfNeeded();
      await shot(page, `sheet-${label}-getting-there`);
    }
    await page.setViewportSize(PHONE);
    return read;
  });
  flow.check("the facts end with the guest policy", "When | Where | Guest policy", layout.terms);
  flow.check(
    "then the run of show, the occasion and getting there",
    "Run of show | About | Dress Code | Inspiration | Getting there",
    layout.sections,
  );
  flow.check("the facts come before the run of show", true, layout.factsFirst);
  flow.check(
    "the run of show reads in time order",
    "4:00 pm Tea is poured | 4:45 pm Garden games | 5:15 pm Speeches",
    layout.lines,
  );
  flow.check("the policy says adults only", CIRE_EVENT_EDIT.children, layout.policy);
  // The preview's household is the organiser's own, which may bring nobody.
  flow.check(
    "a household that may bring no plus-one is not told they are welcome",
    false,
    layout.text.includes("Plus-ones welcome"),
  );

  const about = await flow.step("read the description under About", async () => {
    const text = details.getByText(/^High tea on the lawn/);
    await text.scrollIntoViewIfNeeded();
    await expect(text).toBeVisible();
    return (await text.textContent()) ?? "";
  });
  flow.check("About shows the description, line breaks kept", CIRE_EVENT_EDIT.description, about);

  const gettingThere = await flow.step("read the getting-there notes", async () => {
    const text = details.getByText(/^Park on Sample Lane/);
    await text.scrollIntoViewIfNeeded();
    await expect(text).toBeVisible();
    return (await text.textContent()) ?? "";
  });
  flow.check(
    "Getting there shows the notes, line breaks kept",
    CIRE_EVENT_EDIT.gettingThere,
    gettingThere,
  );

  const ics = await flow.step("download the calendar file", async () => {
    await details.getByRole("button", { name: "Add to calendar" }).click();
    const download = page.waitForEvent("download");
    await page.getByRole("menuitem", { name: "Apple / Outlook (.ics)" }).click();
    const file = await (await download).path();
    // Unfold continuation lines, then read the logical lines.
    return readFileSync(file, "utf8").replace(/\r\n /g, "").split("\r\n");
  });
  flow.check(
    "calendar LOCATION is the venue name, then the address",
    `LOCATION:${icsText(`${CIRE_EVENT_EDIT.venueName}, ${CIRE_EVENT_EDIT.address}`)}`,
    ics.find((line) => line.startsWith("LOCATION:")) ?? "missing",
  );
  flow.check(
    "calendar DESCRIPTION opens with the description",
    true,
    (ics.find((line) => line.startsWith("DESCRIPTION:")) ?? "").startsWith(
      `DESCRIPTION:${icsText(CIRE_EVENT_EDIT.description)}`,
    ),
  );

  // What anyone with the invite's link reads: none of the household's details.
  const publicInvite = await flow.step("read the public invite payload", async () => {
    const response = await page.request.get(
      `${ORIGINS.cireApi}/api/invite/${CIRE_EVENT_EDIT.slug}`,
    );
    flow.recordRequest("GET", response.url(), response.status());
    return { status: response.status(), text: await response.text() };
  });
  flow.check("public invite read", 200, publicInvite.status);
  flow.check(
    "the public invite carries none of the run of show, notes or policy",
    false,
    [GAMES.label, "Park on Sample Lane", CIRE_EVENT_EDIT.policyNote, "adults_only"].some((s) =>
      publicInvite.text.includes(s),
    ),
  );

  const eliSheet = await flow.step("open the Kitchen Tea as Eli's household", async () => {
    // Off the invitation first: its islands read the session cookie this
    // claim replaces.
    await page.goto("about:blank");
    const claim = responseTo(page, "POST", CLAIM_URL);
    await page.goto(
      `${ORIGINS.cireInvites}/cire/invite?slug=${CIRE_EVENT_EDIT.slug}&code=${CIRE_EVENT_EDIT.allowedGuest.code}`,
    );
    const response = await claim;
    const status = response.status();
    const body = (await response.json()) as { events: ClaimedEvent[] };
    const plusOnePolicy =
      body.events.find((e) => e.name === CIRE_EVENT_EDIT.event)?.plusOnePolicy ?? "missing";
    await openKitchenTea();
    const policy = details.locator("dl > div:last-child dd p").first();
    await expect(policy).toContainText("Plus-ones welcome");
    await policy.scrollIntoViewIfNeeded();
    await shot(page, "sheet-allowed-household");
    return { status, plusOnePolicy, policy: (await policy.textContent()) ?? "" };
  });
  flow.check("claim with Eli's code", 200, eliSheet.status);
  flow.check(
    "the claim sends welcome to a household that may bring a plus-one",
    "welcome",
    eliSheet.plusOnePolicy,
  );
  flow.check(
    "a household that may bring a plus-one is told they are welcome",
    true,
    eliSheet.policy.includes("Plus-ones welcome"),
  );
});
