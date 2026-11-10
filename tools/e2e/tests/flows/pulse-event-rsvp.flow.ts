/**
 * Pulse: one person creates an event, a second person RSVPs to it, and both
 * writes land in pulse-api's database. The host then cancels the event, which
 * closes its RSVPs and keeps the guest's reply, and cancels a whole series.
 *
 * Both people hold an OSN account (registered through osn-api, the subject of
 * the Musubi flow) and sign in to Pulse through OSN's OIDC provider. Pulse is a
 * first-party client, so with a live OSN session the authorization endpoint
 * issues a code straight back to pulse-api: Musubi's `/authorize` page never
 * loads. Pulse's own session cookie comes from pulse-api (`localhost:3001`) and
 * rides on the web app's (`localhost:1420`) credentialed fetches.
 *
 * No Pulse screen writes a status, so the cancel steps go through the API the
 * web app's session cookie authorises, with the web app's Origin, which
 * pulse-api's origin guard requires on a cookie-carrying write.
 *
 * On the way it measures the explore page from 320px to 1440px, signed in on
 * the host's page and signed out on the guest's (`support/pulse-explore.ts`).
 */

import type { APIRequestContext, APIResponse, BrowserContext } from "@playwright/test";

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
import { exploreCreateForm, exploreLayout } from "../support/pulse-explore";

const EVENT_TITLE = "E2E Launch Party";

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

test("pulse-event-rsvp", async ({ page, context, browser, flow }) => {
  await flow.step("host: create an OSN account", () =>
    registerThroughApi(flow, context.request, PEOPLE.pulseHost),
  );
  await signInToPulse(flow, page, "host");

  const eventId = await flow.step("host: create an event", async () => {
    await page.getByRole("button", { name: "Host", exact: true }).click();
    await page.getByLabel("Title").fill(EVENT_TITLE);
    await page.getByLabel("Start time").fill("2026-11-20T18:00");
    await page.getByLabel("End time").fill("2026-11-20T22:00");
    const created = page.waitForResponse(
      (r) =>
        r.request().method() === "POST" &&
        r.url().startsWith(ORIGINS.pulseApi) &&
        /^\/events\/?$/.test(new URL(r.url()).pathname),
    );
    await page.getByRole("button", { name: "Create", exact: true }).click();
    const response = await created;
    expect(response.status(), "event created").toBe(201);
    const body = (await response.json()) as { event: { id: string } };
    return body.event.id;
  });

  const event = queryOne<{ title: string; created_at: number }>(
    DB_FILES.pulse,
    "SELECT title, created_at FROM events WHERE id = ?",
    eventId,
  );
  flow.check("events row title", EVENT_TITLE, event?.title ?? "missing");
  flow.check("events row written on the suite clock", true, onSuiteClock(event?.created_at));

  await exploreLayout(flow, page, "host");
  await exploreCreateForm(flow, page);

  /** The guest's reply: every RSVP row on the event but the host's own. */
  const guestRsvp = () =>
    queryOne<{ status: string; created_at: number }>(
      DB_FILES.pulse,
      "SELECT status, created_at FROM event_rsvps WHERE event_id = ? AND profile_id <> (SELECT created_by_profile_id FROM events WHERE id = ?)",
      eventId,
      eventId,
    );

  // Closed by Playwright at the end of the test, after the fixture has taken
  // the final screenshot of the guest's page and saved this context's trace.
  const guestContext: BrowserContext = await browser.newContext();
  const guestPage = await flow.newPage(guestContext);
  flow.finalPage = guestPage;

  await flow.step("guest: create an OSN account", () =>
    registerThroughApi(flow, guestContext.request, PEOPLE.pulseGuest),
  );
  await exploreLayout(flow, guestPage, "guest");
  await signInToPulse(flow, guestPage, "guest");

  await flow.step("guest: RSVP going", async () => {
    await guestPage.goto(`${ORIGINS.pulseWeb}/events/${eventId}`);
    await expect(guestPage.getByRole("heading", { name: EVENT_TITLE })).toBeVisible();
    const saved = guestPage.waitForResponse(
      (r) => r.request().method() === "POST" && r.url().endsWith(`/events/${eventId}/rsvps`),
    );
    await guestPage.getByRole("button", { name: "I'm going" }).click();
    expect((await saved).ok(), "RSVP saved").toBe(true);
  });

  const rsvp = guestRsvp();
  flow.check("event_rsvps row for the guest", "going", rsvp?.status ?? "missing");
  flow.check("event_rsvps row written on the suite clock", true, onSuiteClock(rsvp?.created_at));

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

  await flow.step("guest: the event page shows the cancel", async () => {
    await guestPage.reload();
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
});
