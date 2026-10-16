/**
 * Pulse: one person creates an event, a second person RSVPs to it, and both
 * writes land in pulse-api's database.
 *
 * Both people hold an OSN account (registered through osn-api, the subject of
 * the Musubi flow) and sign in to Pulse through OSN's OIDC provider. Pulse is a
 * first-party client, so with a live OSN session the authorization endpoint
 * issues a code straight back to pulse-api: Musubi's `/authorize` page never
 * loads. Pulse's own session cookie comes from pulse-api (`localhost:3001`) and
 * rides on the web app's (`localhost:1420`) credentialed fetches.
 */

import type { BrowserContext, Page } from "@playwright/test";

import { DB_FILES, ORIGINS, PEOPLE } from "../../src/config";
import {
  cookieNamed,
  expect,
  onSuiteClock,
  queryOne,
  registerThroughApi,
  test,
  type Flow,
} from "../support/fixtures";

const EVENT_TITLE = "E2E Launch Party";

/** Signs in to Pulse through OSN and finishes Pulse's first-run onboarding. */
async function signInToPulse(flow: Flow, page: Page, who: string): Promise<void> {
  const authorizePages: string[] = [];
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame() && frame.url().startsWith(`${ORIGINS.musubi}/authorize`)) {
      authorizePages.push(frame.url());
    }
  });

  await flow.step(`${who}: sign in to Pulse with Musubi`, async () => {
    await page.goto(ORIGINS.pulseWeb);
    await page.getByRole("button", { name: "Continue with musubi" }).click();
  });

  await flow.step(`${who}: finish onboarding`, async () => {
    await expect(page).toHaveURL(`${ORIGINS.pulseWeb}/welcome`);
    await page.getByRole("button", { name: "Skip for now" }).click();
    await expect(page).toHaveURL(`${ORIGINS.pulseWeb}/`);
  });

  flow.check(`${who}: Musubi /authorize page not shown`, 0, authorizePages.length);
  const cookie = await cookieNamed(page.context(), ORIGINS.pulseApi, "pulse_web_session");
  flow.check(`${who}: pulse_web_session set by pulse-api`, true, cookie !== undefined);
  flow.check(`${who}: pulse_web_session is HttpOnly`, true, cookie?.httpOnly ?? false);
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

  // Closed by Playwright at the end of the test, after the fixture has taken
  // the final screenshot of the guest's page and saved this context's trace.
  const guestContext: BrowserContext = await browser.newContext();
  {
    const guestPage = await flow.newPage(guestContext);
    flow.finalPage = guestPage;

    await flow.step("guest: create an OSN account", () =>
      registerThroughApi(flow, guestContext.request, PEOPLE.pulseGuest),
    );
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

    const rsvp = queryOne<{ status: string; created_at: number }>(
      DB_FILES.pulse,
      "SELECT status, created_at FROM event_rsvps WHERE event_id = ? AND profile_id <> (SELECT created_by_profile_id FROM events WHERE id = ?)",
      eventId,
      eventId,
    );
    flow.check("event_rsvps row for the guest", "going", rsvp?.status ?? "missing");
    flow.check("event_rsvps row written on the suite clock", true, onSuiteClock(rsvp?.created_at));
  }
});
