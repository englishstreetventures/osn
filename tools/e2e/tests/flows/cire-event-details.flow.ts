/**
 * Cire: an organiser gives an event a venue name and a description in the
 * portal's event drawer and saves, then previews the invitation the way
 * "Preview invite" does. The event's details show the venue name above the
 * address and the description under About, the calendar file carries both,
 * and so does the claim response the invitation is built from.
 *
 * The organiser signs in with osn-api's dev sign-in (the dev principal owns
 * the sample wedding) and then cire's own OIDC sign-in, where osn-api, with a
 * session and a first-party client, issues a code straight back to cire-api:
 * Musubi's `/authorize` page never loads. The preview claims from the
 * organiser's own address (`claimFromOrganiserAddress`), so it spends the
 * organiser's window of cire-api's claim limit, not the guests'.
 *
 * The organiser then reloads the editor, finds both in the drawer as the
 * server sent them, and saves a change to another field: the row keeps both,
 * so a save carries what the editor read rather than wiping it.
 *
 * The edited event is the sample wedding's Kitchen Tea, which no other flow
 * reads, so the edit changes nothing another flow sees.
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

/** A phone, where the event sheet is a bottom sheet. */
const PHONE = { width: 390, height: 844 };

/** Resolves with the first `method` request to exactly `url`. */
function responseTo(page: Page, method: string, url: string) {
  return page.waitForResponse((r) => r.url() === url && r.request().method() === method);
}

/** RFC 5545 text escaping, as `calendar.ts` writes it. */
function icsText(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
}

interface ClaimedEvent {
  name: string;
  description: string;
  venueName?: string | null;
  address: string | null;
}

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

  await flow.step("give the Kitchen Tea a venue name and a description", async () => {
    await kitchenTea.getByRole("button", { name: "Edit", exact: true }).click();
    await expect(drawer).toBeVisible();
    await drawer.getByLabel("Venue name").fill(CIRE_EVENT_EDIT.venueName);
    const description = drawer.getByLabel("Description", { exact: true });
    await description.fill(CIRE_EVENT_EDIT.description);
    await description.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: resolve(SCREENSHOT_DIR, "cire-event-details--drawer.png"),
      animations: "disabled",
    });
    await drawer.getByRole("button", { name: "Done" }).click();
    await expect(drawer).toBeHidden();
  });

  /** Save, confirm in the preview, and wait for the editor to reload its rows. */
  const saveSchedule = async () => {
    const preview = responseTo(page, "POST", `${WEDDING_API}/changes/preview`);
    await page.getByRole("button", { name: "Save changes" }).click();
    const previewed = await preview;
    expect(previewed.status(), "preview").toBe(200);
    const { warnings } = (await previewed.json()) as { warnings: string[] };

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
    return { status, warnings };
  };

  const kitchenTeaRow = () =>
    queryOne<{
      description: string;
      venue_name: string | null;
      address: string | null;
      dress_code_description: string | null;
      updated_at: number;
    }>(
      DB_FILES.cire,
      "SELECT description, venue_name, address, dress_code_description, updated_at FROM events WHERE wedding_id = ? AND name = ?",
      CIRE_EVENT_EDIT.weddingId,
      CIRE_EVENT_EDIT.event,
    );

  const applied = await flow.step("save the schedule", saveSchedule);
  flow.check("change applied", 200, applied.status);
  flow.check("the preview warned of nothing", 0, applied.warnings.length);

  const row = kitchenTeaRow();
  flow.check("events row venue_name", CIRE_EVENT_EDIT.venueName, row?.venue_name ?? "missing");
  flow.check("events row description", CIRE_EVENT_EDIT.description, row?.description ?? "missing");
  flow.check("events row address unchanged", CIRE_EVENT_EDIT.address, row?.address ?? "missing");
  flow.check("events row written on the suite clock", true, onSuiteClock(row?.updated_at));

  const readBack = await flow.step("reload the editor and open the Kitchen Tea again", async () => {
    // A fresh page, so the drawer holds what `GET …/events` sent, not what
    // was typed.
    const rows = responseTo(page, "GET", `${WEDDING_API}/events`);
    await page.reload();
    expect((await rows).status(), "events read").toBe(200);
    await kitchenTea.getByRole("button", { name: "Edit", exact: true }).click();
    await expect(drawer).toBeVisible();
    const values = {
      venueName: await drawer.getByLabel("Venue name").inputValue(),
      description: await drawer.getByLabel("Description", { exact: true }).inputValue(),
    };
    await drawer.getByLabel("Dress code description").fill(CIRE_EVENT_EDIT.dressCode);
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

  const resaved = await flow.step("save a change to another field", saveSchedule);
  flow.check("second change applied", 200, resaved.status);
  flow.check("the second preview warned of nothing", 0, resaved.warnings.length);

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

  await flow.step("decline optional storage", async () => {
    // The consent prompt is an idle-hydrated island: wait for it rather than race it.
    const prompt = page.getByRole("dialog", { name: "Privacy choices" });
    await expect(prompt).toBeVisible({ timeout: 60_000 });
    await prompt.getByRole("button", { name: "Reject all" }).click();
    await expect(prompt).toBeHidden();
  });

  const sheet = page.getByRole("dialog");
  const details = sheet.locator('[data-panel="details"]');

  const where = await flow.step("open the Kitchen Tea's details", async () => {
    await page
      .getByRole("article")
      .filter({ has: page.getByRole("heading", { name: CIRE_EVENT_EDIT.event }) })
      .getByRole("button", { name: "Event Details" })
      .click();
    await expect(
      sheet.getByRole("heading", { name: new RegExp(`^Details.*${CIRE_EVENT_EDIT.event}`) }),
    ).toBeVisible();
    const name = details.getByText(CIRE_EVENT_EDIT.venueName, { exact: true });
    const address = details.getByText(CIRE_EVENT_EDIT.address, { exact: true });
    await expect(name).toBeVisible();
    await expect(address).toBeVisible();
    await page.screenshot({
      path: resolve(SCREENSHOT_DIR, "cire-event-details--sheet.png"),
      animations: "disabled",
    });
    const nameBox = (await name.boundingBox())!;
    const addressBox = (await address.boundingBox())!;
    return { nameAbove: nameBox.y + nameBox.height <= addressBox.y };
  });
  flow.check("the venue name sits above the address", true, where.nameAbove);

  const about = await flow.step("read the description under About", async () => {
    const text = details.getByText(/^High tea on the lawn/);
    await text.scrollIntoViewIfNeeded();
    await expect(text).toBeVisible();
    return (await text.textContent()) ?? "";
  });
  flow.check("About shows the description, line breaks kept", CIRE_EVENT_EDIT.description, about);

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
});
