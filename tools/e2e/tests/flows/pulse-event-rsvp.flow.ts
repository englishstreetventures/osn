/**
 * Pulse: one person hosts events, a second person finds and answers them, and
 * every write lands in pulse-api's database.
 *
 * Both people hold an OSN account (registered through osn-api, the subject of
 * the Musubi flow) and sign in to Pulse through OSN's OIDC provider. Pulse is a
 * first-party client, so with a live OSN session the authorization endpoint
 * issues a code straight back to pulse-api: Musubi's `/authorize` page never
 * loads. Pulse's own session cookie comes from pulse-api (`localhost:3001`) and
 * rides on the web app's (`localhost:1420`) credentialed fetches.
 *
 * The host skips onboarding, opens both avatar menus and "More filters"
 * (`support/pulse-menus.ts`), and creates an event through the form, with a
 * description and an end time and no price. On the host's page the flow then
 * measures the explore page from 320px to 1440px and reads the header's motion
 * (`support/pulse-explore.ts`), and searches the feed and presses its filter
 * chips and "More filters", each of which asks discovery again
 * (`support/pulse-feed.ts`). The guest, whose browser grants location and
 * notifications, is measured signed out, then signs in and walks all six
 * onboarding steps (`support/pulse-onboarding.ts`).
 *
 * The guest opens the event from a WhatsApp link, which sends the exposure
 * ping, RSVPs going, and reads the counts, the attendee strip and the guest
 * list; then finds the event on their calendar through the nav, with no page
 * load. The host creates a guest-list event, which refuses the uninvited
 * guest's RSVP and hides its list, and a private event, which the guest cannot
 * open.
 *
 * No Pulse screen writes a status, so the cancel steps go through the API the
 * web app's session cookie authorises, with the web app's Origin, which
 * pulse-api's origin guard requires on a cookie-carrying write. The host
 * cancels the event, which closes its RSVPs and keeps the guest's reply, and
 * cancels a whole series. Last, after every step that reads it, the host hides
 * their attendance in settings.
 */

import type {
  APIRequestContext,
  APIResponse,
  BrowserContext,
  Locator,
  Page,
  Response,
} from "@playwright/test";

import { DB_FILES, ORIGINS, PEOPLE } from "../../src/config";
import {
  expect,
  onSuiteClock,
  queryOne,
  registerThroughApi,
  signInToPulse,
  test,
  type Flow,
} from "../support/fixtures";
import { exploreCreateForm, exploreLayout, exploreMotion } from "../support/pulse-explore";
import { exploreFeed } from "../support/pulse-feed";
import { pulseMenus, trigger as avatarTrigger } from "../support/pulse-menus";
import { accountIdFor, walkPulseOnboarding } from "../support/pulse-onboarding";

const EVENT_TITLE = "E2E Launch Party";
const EVENT_DESCRIPTION = "Doors at six. The suite brings the playlist.";
const GUEST_LIST_TITLE = "E2E Guest List Night";
const PRIVATE_TITLE = "E2E Private Dinner";
/** Where the guest's browser says it is, so the location step resolves at once. */
const GUEST_POSITION = { latitude: -33.8688, longitude: 151.2093 } as const;

/**
 * A write to pulse-api through `request`'s cookie jar, sent with the web app's
 * Origin and recorded like a browser request.
 */
async function pulseWrite(
  flow: Flow,
  request: APIRequestContext,
  method: "POST" | "PATCH" | "DELETE",
  path: string,
  data?: Record<string, unknown>,
): Promise<APIResponse> {
  const url = `${ORIGINS.pulseApi}${path}`;
  const response = await request.fetch(url, {
    method,
    headers: { Origin: ORIGINS.pulseWeb },
    ...(data === undefined ? {} : { data }),
  });
  flow.recordRequest(method, url, response.status());
  return response;
}

/** True when `response` answers `method` on exactly `url`, its query string aside. */
function answers(response: Response, method: string, url: string): boolean {
  const { origin, pathname } = new URL(response.url());
  return response.request().method() === method && `${origin}${pathname}` === url;
}

/**
 * Ticks a radio or checkbox by its `<label>`, as a person does, then waits for
 * the form to show it ticked. `@shared/ui` draws its own box and keeps the
 * input `sr-only`, so the input itself is never the thing under the pointer.
 */
async function pick(choice: Locator): Promise<void> {
  await choice.locator("xpath=ancestor::label[1]").click();
  await expect(choice).toBeChecked();
}

/**
 * Creates an event through the explore page's form, opened with "Host":
 * fills it, runs `choose` for anything past the text fields, presses Create,
 * and returns the new event's id once pulse-api has answered 201 and the form
 * has closed.
 */
async function createThroughForm(
  page: Page,
  fields: { title: string; start: string; end: string; description?: string },
  choose: () => Promise<void> = async () => {},
): Promise<string> {
  await page.getByRole("button", { name: "Host", exact: true }).click();
  await page.getByLabel("Title").fill(fields.title);
  await page.getByLabel("Start time").fill(fields.start);
  await page.getByLabel("End time").fill(fields.end);
  if (fields.description !== undefined) {
    await page.getByLabel("Description", { exact: true }).fill(fields.description);
  }
  await choose();
  const created = page.waitForResponse((r) => answers(r, "POST", `${ORIGINS.pulseApi}/events`));
  await page.getByRole("button", { name: "Create", exact: true }).click();
  const response = await created;
  expect(response.status(), `${fields.title} created`).toBe(201);
  await expect(page.getByLabel("Start time")).toBeHidden();
  return ((await response.json()) as { event: { id: string } }).event.id;
}

test("pulse-event-rsvp", async ({ page, browser, flow }) => {
  await flow.step("host: create an OSN account", () =>
    registerThroughApi(flow, page, PEOPLE.pulseHost),
  );
  await signInToPulse(flow, page, "host");
  await pulseMenus(flow, page);

  const eventId = await flow.step("host: create an event", () =>
    createThroughForm(page, {
      title: EVENT_TITLE,
      start: "2026-11-20T18:00",
      end: "2026-11-20T22:00",
      description: EVENT_DESCRIPTION,
    }),
  );

  const event = queryOne<{
    title: string;
    created_at: number;
    description: string | null;
    length: number | null;
    price_amount: number | null;
    price_currency: string | null;
  }>(
    DB_FILES.pulse,
    `SELECT title, created_at, description, end_time - start_time AS length,
            price_amount, price_currency
       FROM events WHERE id = ?`,
    eventId,
  );
  flow.check("events row title", EVENT_TITLE, event?.title ?? "missing");
  flow.check("events row written on the suite clock", true, onSuiteClock(event?.created_at));
  flow.check("events row description", EVENT_DESCRIPTION, event?.description ?? "missing");
  flow.check("events row runs four hours, in seconds", 4 * 3600, event?.length ?? -1);
  flow.check(
    "events row has no price",
    true,
    event !== undefined && event.price_amount === null && event.price_currency === null,
  );

  await exploreLayout(flow, page, "host");
  await exploreCreateForm(flow, page);
  await exploreMotion(flow, page);
  await exploreFeed(flow, page, PEOPLE.pulseHost, EVENT_TITLE);

  /** The guest's reply: every RSVP row on the event but the host's own. */
  const guestRsvp = () =>
    queryOne<{ status: string; created_at: number; share_source_first: string | null }>(
      DB_FILES.pulse,
      "SELECT status, created_at, share_source_first FROM event_rsvps WHERE event_id = ? AND profile_id <> (SELECT created_by_profile_id FROM events WHERE id = ?)",
      eventId,
      eventId,
    );

  // Closed by Playwright at the end of the test, after the fixture has taken
  // the final screenshot of the guest's page and saved this context's trace.
  // Location and notifications are granted up front, so onboarding's two
  // permission steps resolve without a prompt.
  const guestContext: BrowserContext = await browser.newContext({
    permissions: ["geolocation", "notifications"],
    geolocation: GUEST_POSITION,
  });
  const guestPage = await flow.newPage(guestContext);
  flow.finalPage = guestPage;

  await flow.step("guest: create an OSN account", () =>
    registerThroughApi(flow, guestPage, PEOPLE.pulseGuest),
  );
  await exploreLayout(flow, guestPage, "guest");
  await signInToPulse(flow, guestPage, "guest", "stay");
  await walkPulseOnboarding(flow, guestPage, PEOPLE.pulseGuest);

  const hostAccount = accountIdFor(PEOPLE.pulseHost.handle);
  const hostOnboarded =
    hostAccount === undefined
      ? -1
      : (queryOne<{ n: number }>(
          DB_FILES.pulse,
          "SELECT count(*) AS n FROM pulse_account_onboarding WHERE account_id = ?",
          hostAccount,
        )?.n ?? -1);
  flow.check("onboarding: the host's skip wrote no row", 0, hostOnboarded);

  const guestButton = (name: string) => guestPage.getByRole("button", { name });

  const exposure = await flow.step("guest: RSVP going", async () => {
    // The page sends the ping from an effect once the event loads, and waits
    // for nothing, so the flow waits for its answer.
    const ping = guestPage.waitForResponse((r) =>
      answers(r, "POST", `${ORIGINS.pulseApi}/events/${eventId}/exposure`),
    );
    await guestPage.goto(`${ORIGINS.pulseWeb}/events/${eventId}?source=whatsapp`);
    await expect(guestPage.getByRole("heading", { name: EVENT_TITLE })).toBeVisible();
    const pinged = (await ping).status();
    await expect(guestPage.getByText("Free", { exact: true })).toBeVisible();
    for (const name of ["I'm going", "Maybe", "Can't make it"]) {
      await expect(guestButton(name), `"${name}" button`).toBeVisible();
    }
    await expect(guestPage.getByText(/^\d+ invited$/), "no invited count").toHaveCount(0);

    const saved = guestPage.waitForResponse((r) =>
      answers(r, "POST", `${ORIGINS.pulseApi}/events/${eventId}/rsvps`),
    );
    await guestButton("I'm going").click();
    expect((await saved).ok(), "RSVP saved").toBe(true);

    // The strip and the counts read again after the reply. Creating the event
    // wrote no RSVP for the host, so the guest is the only one.
    await expect(guestPage.getByLabel(PEOPLE.pulseGuest.name, { exact: true })).toHaveText("GE");
    await expect(guestPage.getByText(/^\d+ going$/)).toHaveText("1 going");
    await expect(guestPage.getByText(/^\d+ maybe$/)).toHaveText("0 maybe");
    await expect(guestPage.getByText(/^\d+ can't make it$/)).toHaveText("0 can't make it");
    return pinged;
  });
  flow.check("guest: the WhatsApp visit's exposure ping", 204, exposure);

  const rsvp = guestRsvp();
  flow.check("event_rsvps row for the guest", "going", rsvp?.status ?? "missing");
  flow.check("event_rsvps row written on the suite clock", true, onSuiteClock(rsvp?.created_at));
  flow.check(
    "event_rsvps row's first share source",
    "whatsapp",
    rsvp?.share_source_first ?? "missing",
  );

  await flow.step("guest: the guest list", async () => {
    await guestButton("See all").click();
    const dialog = guestPage.getByRole("dialog", { name: "Guest list" });
    await expect(dialog).toBeVisible();
    for (const name of ["Going", "Maybe", "Not going"]) {
      await expect(dialog.getByRole("tab", { name, exact: true }), `"${name}" tab`).toBeVisible();
    }
    await expect(dialog.getByRole("tab", { name: "Invited", exact: true })).toHaveCount(0);
    await expect(dialog.getByText(PEOPLE.pulseGuest.name, { exact: true })).toBeVisible();
    await expect(dialog.getByText(`@${PEOPLE.pulseGuest.handle}`, { exact: true })).toBeVisible();
    await dialog.getByRole("tab", { name: "Not going", exact: true }).click();
    await expect(dialog.getByText("No one here yet.", { exact: true })).toBeVisible();
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await expect(dialog).toHaveCount(0);
  });

  const calendar = await flow.step("guest: open the calendar from the nav", async () => {
    await guestPage.getByRole("link", { name: "Pulse", exact: true }).click();
    await expect(guestPage).toHaveURL(`${ORIGINS.pulseWeb}/`);
    const read = guestPage.waitForResponse((r) =>
      answers(r, "GET", `${ORIGINS.pulseApi}/events/calendar`),
    );
    await guestPage.getByRole("button", { name: "Calendar", exact: true }).click();
    await expect(guestPage).toHaveURL(`${ORIGINS.pulseWeb}/calendar`);
    const status = (await read).status();
    // The event starts 2026-11-20 18:00 UTC, weeks past the suite clock, and
    // the page runs in UTC, so the day and the times read the same every run.
    const card = guestPage.getByRole("link", { name: EVENT_TITLE });
    await expect(card).toBeVisible();
    await expect(card.getByText("Going", { exact: true })).toBeVisible();
    await expect(card.getByText("6 PM – 10 PM", { exact: true })).toBeVisible();
    await expect(
      guestPage.getByRole("heading", { name: "Fri, Nov 20", exact: true }),
    ).toBeVisible();
    for (const part of ["NOV", "20", "FRI"]) {
      await expect(guestPage.getByText(part, { exact: true }), `rail "${part}"`).toBeVisible();
    }
    return status;
  });
  flow.check("guest: GET /events/calendar status", 200, calendar);

  const guestListId = await flow.step("host: create a guest-list event", () =>
    createThroughForm(
      page,
      { title: GUEST_LIST_TITLE, start: "2026-11-27T19:00", end: "2026-11-27T23:00" },
      async () => {
        await pick(page.getByRole("radio", { name: "Hidden", exact: true }));
        await pick(page.getByRole("radio", { name: "Guest list only", exact: true }));
        await pick(page.getByRole("radio", { name: "No", exact: true }));
        await pick(page.getByRole("checkbox", { name: "SMS", exact: true }));
      },
    ),
  );
  const guestList = queryOne<{
    join_policy: string;
    allow_interested: number;
    guest_list_visibility: string;
    comms_channels: string;
  }>(
    DB_FILES.pulse,
    "SELECT join_policy, allow_interested, guest_list_visibility, comms_channels FROM events WHERE id = ?",
    guestListId,
  );
  flow.check("guest-list event row join_policy", "guest_list", guestList?.join_policy ?? "missing");
  flow.check("guest-list event row allow_interested", 0, guestList?.allow_interested ?? -1);
  flow.check(
    "guest-list event row guest_list_visibility",
    "private",
    guestList?.guest_list_visibility ?? "missing",
  );
  flow.check(
    "guest-list event row reaches guests by SMS",
    true,
    (JSON.parse(guestList?.comms_channels ?? "[]") as string[]).includes("sms"),
  );

  const privateId = await flow.step("host: create a private event", () =>
    createThroughForm(
      page,
      { title: PRIVATE_TITLE, start: "2026-12-04T19:00", end: "2026-12-04T22:00" },
      () => pick(page.getByRole("radio", { name: "Private (link only)", exact: true })),
    ),
  );
  const privateEvent = queryOne<{ visibility: string }>(
    DB_FILES.pulse,
    "SELECT visibility FROM events WHERE id = ?",
    privateId,
  );
  flow.check("private event row visibility", "private", privateEvent?.visibility ?? "missing");

  const refused = await flow.step("guest: RSVP to the guest-list event is refused", async () => {
    await guestPage.goto(`${ORIGINS.pulseWeb}/events/${guestListId}`);
    await expect(guestPage.getByRole("heading", { name: GUEST_LIST_TITLE })).toBeVisible();
    await expect(guestButton("I'm going")).toBeVisible();
    await expect(guestButton("Can't make it")).toBeVisible();
    await expect(guestButton("Maybe"), 'no "Maybe" button').toHaveCount(0);
    await expect(guestPage.getByText("0 invited", { exact: true })).toBeVisible();
    const answered = guestPage.waitForResponse((r) =>
      answers(r, "POST", `${ORIGINS.pulseApi}/events/${guestListId}/rsvps`),
    );
    await guestButton("I'm going").click();
    const status = (await answered).status();
    await expect(guestPage.getByText("Invitation required", { exact: true })).toBeVisible();
    return status;
  });
  flow.check("guest: RSVP without an invite", 403, refused);
  flow.check(
    "event_rsvps rows on the guest-list event",
    0,
    queryOne<{ n: number }>(
      DB_FILES.pulse,
      "SELECT count(*) AS n FROM event_rsvps WHERE event_id = ?",
      guestListId,
    )?.n ?? -1,
  );

  await flow.step("guest: the guest-list event's list is private", async () => {
    // The modal reads the Going list even while it shows the lock; waiting
    // for that read keeps it from landing in a later step.
    const going = guestPage.waitForResponse((r) =>
      answers(r, "GET", `${ORIGINS.pulseApi}/events/${guestListId}/rsvps`),
    );
    await guestButton("See all").click();
    const dialog = guestPage.getByRole("dialog", { name: "Guest list" });
    await expect(dialog).toBeVisible();
    await going;
    await expect(dialog.getByText("This event's guest list is private.")).toBeVisible();
    await expect(dialog.getByRole("tab", { name: "Invited", exact: true })).toBeVisible();
    await expect(dialog.getByRole("tab", { name: "Maybe", exact: true })).toHaveCount(0);
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await expect(dialog).toHaveCount(0);
  });

  const hidden = await flow.step("guest: the private event is not found", async () => {
    const read = guestPage.waitForResponse((r) =>
      answers(r, "GET", `${ORIGINS.pulseApi}/events/${privateId}`),
    );
    await guestPage.goto(`${ORIGINS.pulseWeb}/events/${privateId}`);
    const status = (await read).status();
    await expect(guestPage.getByText("Event not found.", { exact: true })).toBeVisible();
    return status;
  });
  flow.check("guest: GET /events/:id on a private event", 404, hidden);

  await flow.step("host: cancel the event", async () => {
    const response = await pulseWrite(flow, page.request, "PATCH", `/events/${eventId}`, {
      status: "cancelled",
    });
    expect(response.status(), "event cancelled").toBe(200);
  });

  const cancelledEvent = queryOne<{
    status: string;
    cancelled_at: number | null;
    cancellation_reason: string | null;
  }>(
    DB_FILES.pulse,
    "SELECT status, cancelled_at, cancellation_reason FROM events WHERE id = ?",
    eventId,
  );
  flow.check("cancelled event status", "cancelled", cancelledEvent?.status ?? "missing");
  flow.check(
    "cancelled event cancelled_at on the suite clock",
    true,
    onSuiteClock(cancelledEvent?.cancelled_at ?? undefined),
  );
  flow.check(
    "cancelled event reason",
    "organiser",
    cancelledEvent?.cancellation_reason ?? "missing",
  );

  await flow.step("guest: changing the RSVP on the cancelled event is refused", async () => {
    const response = await pulseWrite(flow, guestPage.request, "POST", `/events/${eventId}/rsvps`, {
      status: "not_going",
    });
    expect(response.status(), "RSVP on a cancelled event refused").toBe(422);
  });
  flow.check(
    "event_rsvps row for the guest kept after the cancel",
    "going",
    guestRsvp()?.status ?? "missing",
  );

  // A fresh load with no source, so it sends no exposure ping.
  await flow.step("guest: the event page shows the cancel", async () => {
    await guestPage.goto(`${ORIGINS.pulseWeb}/events/${eventId}`);
    await expect(guestPage.getByRole("heading", { name: EVENT_TITLE })).toBeVisible();
    await expect(guestPage.getByText("cancelled", { exact: true })).toBeVisible();
    await expect(
      guestPage.getByText("RSVPs are closed because this event is cancelled."),
    ).toBeVisible();
    for (const name of ["I'm going", "Maybe", "Can't make it"]) {
      await expect(guestPage.getByRole("button", { name }), `no "${name}" button`).toHaveCount(0);
    }
  });

  await flow.step("host: maybe_finished is refused", async () => {
    const response = await pulseWrite(flow, page.request, "PATCH", `/events/${eventId}`, {
      status: "maybe_finished",
    });
    expect(response.status(), "display-only status refused").toBe(422);
  });

  const seriesId = await flow.step("host: create a weekly series", async () => {
    const response = await pulseWrite(flow, page.request, "POST", "/series", {
      title: "E2E Weekly",
      rrule: "FREQ=WEEKLY;COUNT=3",
      dtstart: "2026-11-23T18:00:00.000Z",
    });
    expect(response.status(), "series created").toBe(201);
    return ((await response.json()) as { series: { id: string } }).series.id;
  });

  const cancelled = await flow.step("host: cancel the series", async () => {
    const response = await pulseWrite(flow, page.request, "DELETE", `/series/${seriesId}`);
    expect(response.status(), "series cancelled").toBe(200);
    return ((await response.json()) as { cancelled: number }).cancelled;
  });
  flow.check("series cancel count", 3, cancelled);

  const again = await flow.step("host: cancel the series again", async () => {
    const response = await pulseWrite(flow, page.request, "DELETE", `/series/${seriesId}`);
    expect(response.status(), "second cancel answered").toBe(200);
    return ((await response.json()) as { cancelled: number }).cancelled;
  });
  flow.check("second series cancel count", 0, again);

  const instances = queryOne<{
    total: number;
    stamped: number;
    first_cancel: number | null;
    last_cancel: number | null;
  }>(
    DB_FILES.pulse,
    `SELECT COUNT(*) AS total,
            SUM(status = 'cancelled' AND cancellation_reason = 'organiser' AND cancelled_at IS NOT NULL) AS stamped,
            MIN(cancelled_at) AS first_cancel,
            MAX(cancelled_at) AS last_cancel
       FROM events WHERE series_id = ?`,
    seriesId,
  );
  flow.check("series instances", 3, instances?.total ?? 0);
  flow.check("series instances cancelled by the organiser", 3, instances?.stamped ?? 0);
  flow.check(
    "series instances cancelled_at on the suite clock",
    true,
    onSuiteClock(instances?.first_cancel ?? undefined) &&
      onSuiteClock(instances?.last_cancel ?? undefined),
  );

  // The settings page does not read the saved value back, so the row is the
  // only proof the choice was kept.
  const settings = await flow.step("host: hide attendance in settings", async () => {
    await expect(page).toHaveURL(`${ORIGINS.pulseWeb}/`);
    await avatarTrigger(page).click();
    await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
    await expect(page).toHaveURL(`${ORIGINS.pulseWeb}/settings`);
    await pick(page.getByRole("radio", { name: "No one", exact: true }));
    const saved = page.waitForResponse((r) =>
      answers(r, "PATCH", `${ORIGINS.pulseApi}/me/settings`),
    );
    await page.getByRole("button", { name: "Save", exact: true }).click();
    const status = (await saved).status();
    await expect(page.getByText("Settings saved", { exact: true })).toBeVisible();
    return status;
  });
  flow.check("host: PATCH /me/settings status", 200, settings);
  const hostProfile = queryOne<{ id: string }>(
    DB_FILES.osn,
    "SELECT id FROM users WHERE handle = ?",
    PEOPLE.pulseHost.handle,
  )?.id;
  flow.check(
    "pulse_users row: the host's attendance_visibility",
    "no_one",
    queryOne<{ attendance_visibility: string }>(
      DB_FILES.pulse,
      "SELECT attendance_visibility FROM pulse_users WHERE profile_id = ?",
      hostProfile ?? "",
    )?.attendance_visibility ?? "missing",
  );
});
