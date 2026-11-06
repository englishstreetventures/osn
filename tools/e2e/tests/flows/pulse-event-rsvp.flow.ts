/**
 * Pulse: one person creates an event, a second person RSVPs to it, and both
 * writes land in pulse-api's database. The host then cancels the event, which
 * closes its RSVPs and keeps the guest's reply, and cancels a whole series.
 *
 * Both people hold an OSN account (registered through osn-api, the subject of
 * the Musubi flow) and sign in to Pulse through OSN's OIDC provider. Pulse is a
 * first-party client, so with a live OSN session the authorization endpoint
 * issues a code straight back to Pulse: Musubi's `/authorize` page never loads.
 *
 * Pulse web mounts pulse-api under `/api` on its own origin (`localhost:1420`),
 * so the browser never calls pulse-api's origin (`localhost:3001`), the session
 * cookie is the web origin's, and the server that renders a page receives it.
 * The flow reads `/calendar` with JavaScript off, so only what the server
 * rendered can show: the signed-in user's events with their cookie, and the
 * signed-out page with no cookie, an unknown one, an expired one, and one whose
 * session ended by "Log out" or by signing out everywhere.
 *
 * No Pulse screen writes a status or signs out everywhere, so those steps go
 * through the web origin's `/api` with the session cookie, and with the web
 * app's Origin, which pulse-api's origin guard requires on a cookie-carrying
 * write. The same write from another site's Origin is refused.
 */

import { mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import type {
  APIRequestContext,
  APIResponse,
  Browser,
  BrowserContext,
  Page,
} from "@playwright/test";

import { ARTIFACT_DIR, CLOCK_T0, DB_FILES, ORIGINS, PEOPLE } from "../../src/config";
import {
  expect,
  onSuiteClock,
  queryOne,
  registerThroughApi,
  setPulseSessionExpiry,
  signInToPulse,
  test,
  untilPulseHydrated,
  type Flow,
} from "../support/fixtures";

const EVENT_TITLE = "E2E Launch Party";

/** What `/calendar` says to a visitor the server did not recognise. */
const SIGNED_OUT_CALENDAR = "Sign in to see the events you're going to.";

/** The series' own zone, which its dates are server-rendered in. */
const SERIES_ZONE = "Asia/Tokyo";
/** The series' first occurrence. */
const SERIES_FIRST = "2026-11-23T18:00:00.000Z";

/** The fields Pulse web's `formatTime` writes an event's start with. */
const EVENT_TIME: Intl.DateTimeFormatOptions = {
  weekday: "short",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
};

/** An event time as the server writes it: in `timeZone`, the zone named, in `locale`. */
const serverWritten = (iso: string, locale: string, timeZone: string): string =>
  new Date(iso).toLocaleString(locale, { ...EVENT_TIME, timeZone, timeZoneName: "short" });

/** The day of the month `iso` falls on in `timeZone`. */
const dayIn = (iso: string, timeZone: string): string =>
  new Intl.DateTimeFormat("en", { timeZone, day: "numeric" }).format(new Date(iso));

/** "Fri, Nov 20": the date an Explore card and a calendar day heading write, in `timeZone`. */
const usDate = (iso: string, timeZone: string): string =>
  new Date(iso).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone,
  });

/** "6:00 PM": an Explore card's clock in `timeZone`, built from the hour and minute. */
function cardClock(iso: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    minute: "numeric",
    hourCycle: "h23",
  }).formatToParts(new Date(iso));
  const part = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const hour = part("hour");
  const minute = String(part("minute")).padStart(2, "0");
  return `${hour % 12 || 12}:${minute} ${hour >= 12 ? "PM" : "AM"}`;
}

/** The ICS file a guest's "Add to calendar" downloads, kept with the run's artifacts. */
const ICS_ARTIFACT = resolve(ARTIFACT_DIR, "downloads", "pulse-event-rsvp.ics");

/** What a page logs about hydration from now on: a mismatch, a missing node. */
function watchHydration(page: Page): { readonly messages: string[]; stop: () => void } {
  const messages: string[] = [];
  const onConsole = (message: { text(): string }) => {
    if (/hydrat/i.test(message.text())) messages.push(message.text());
  };
  const onError = (error: Error) => {
    if (/hydrat/i.test(error.message)) messages.push(error.message);
  };
  page.on("console", onConsole);
  page.on("pageerror", onError);
  return {
    messages,
    stop: () => {
      page.off("console", onConsole);
      page.off("pageerror", onError);
    },
  };
}

type StorageState = Awaited<ReturnType<BrowserContext["storageState"]>>;

/**
 * A write to pulse-api through the web origin's `/api` mount, with
 * `request`'s cookie jar and the web app's Origin unless `origin` says
 * otherwise, recorded like a browser request.
 */
async function pulseWrite(
  flow: Flow,
  request: APIRequestContext,
  method: "POST" | "PATCH" | "DELETE",
  path: string,
  data?: Record<string, unknown>,
  origin: string = ORIGINS.pulseWeb,
): Promise<APIResponse> {
  const url = `${ORIGINS.pulseWeb}/api${path}`;
  const response = await request.fetch(url, {
    method,
    headers: { Origin: origin },
    ...(data === undefined ? {} : { data }),
  });
  flow.recordRequest(method, url, response.status());
  return response;
}

/** Every request a browser context sends to pulse-api's own origin, which should be none. */
function watchPulseApiOrigin(context: BrowserContext, sent: string[]): void {
  context.on("request", (request) => {
    if (new URL(request.url()).origin === ORIGINS.pulseApi) sent.push(request.url());
  });
}

/**
 * `/calendar` opened with JavaScript off, carrying `storageState`'s cookies
 * (or `cookie` alone, or none), so the page is only what the server rendered.
 * Resolves once the page is loaded; the caller checks it, then closes it.
 */
async function calendarWithoutJs(
  flow: Flow,
  browser: Browser,
  sentToPulseApi: string[],
  cookies: { storageState?: StorageState; session?: string } = {},
): Promise<{ page: Page; headers: Record<string, string>; close: () => Promise<void> }> {
  const context = await browser.newContext({
    javaScriptEnabled: false,
    ...(cookies.storageState ? { storageState: cookies.storageState } : {}),
  });
  if (cookies.session !== undefined) {
    await context.addCookies([
      { name: "pulse_web_session", value: cookies.session, url: ORIGINS.pulseWeb },
    ]);
  }
  watchPulseApiOrigin(context, sentToPulseApi);
  const page = await flow.newPage(context);
  const response = await page.goto(`${ORIGINS.pulseWeb}/calendar`);
  expect(response?.status(), "/calendar answered").toBe(200);
  return { page, headers: response?.headers() ?? {}, close: () => context.close() };
}

/**
 * Checks that a no-JavaScript `/calendar` is the signed-out page and shows no
 * event, and that its header, the session's other reader, offers sign-in.
 */
async function expectSignedOut(flow: Flow, page: Page, who: string): Promise<void> {
  await expect(page.getByText(SIGNED_OUT_CALENDAR)).toBeVisible();
  flow.check(`${who}: event titles on the page`, 0, await page.getByText(EVENT_TITLE).count());
  await expect(page.getByRole("button", { name: "Continue with musubi" })).toBeVisible();
}

test("pulse-event-rsvp", async ({ page, context, browser, flow }) => {
  const sentToPulseApi: string[] = [];
  watchPulseApiOrigin(context, sentToPulseApi);

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
        r.url().startsWith(`${ORIGINS.pulseWeb}/api/`) &&
        /^\/api\/events\/?$/.test(new URL(r.url()).pathname),
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

  /** The event's start as stored, which every `<time datetime>` for it carries. */
  const startIso = new Date(
    (queryOne<{ start_time: number }>(
      DB_FILES.pulse,
      "SELECT start_time FROM events WHERE id = ?",
      eventId,
    )?.start_time ?? 0) * 1000,
  ).toISOString();

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
  watchPulseApiOrigin(guestContext, sentToPulseApi);
  const guestPage = await flow.newPage(guestContext);
  flow.finalPage = guestPage;

  await flow.step("guest: create an OSN account", () =>
    registerThroughApi(flow, guestContext.request, PEOPLE.pulseGuest),
  );
  await signInToPulse(flow, guestPage, "guest");

  await flow.step("guest: RSVP going", async () => {
    await guestPage.goto(`${ORIGINS.pulseWeb}/events/${eventId}`);
    await expect(guestPage.getByRole("heading", { name: EVENT_TITLE })).toBeVisible();
    await untilPulseHydrated(guestPage);
    const saved = guestPage.waitForResponse(
      (r) => r.request().method() === "POST" && r.url().endsWith(`/events/${eventId}/rsvps`),
    );
    await guestPage.getByRole("button", { name: "I'm going" }).click();
    expect((await saved).ok(), "RSVP saved").toBe(true);
  });

  const rsvp = guestRsvp();
  flow.check("event_rsvps row for the guest", "going", rsvp?.status ?? "missing");
  flow.check("event_rsvps row written on the suite clock", true, onSuiteClock(rsvp?.created_at));

  await flow.step("guest: add the event to their calendar", async () => {
    const downloaded = guestPage.waitForEvent("download");
    await guestPage.getByRole("button", { name: "Add to calendar" }).click();
    const download = await downloaded;
    // The id written as `:id`, so the record reads the same on every run.
    flow.check(
      "Add to calendar downloads through the /api mount",
      `${ORIGINS.pulseWeb}/api/events/:id/ics`,
      download.url().replace(eventId, ":id"),
    );
    mkdirSync(dirname(ICS_ARTIFACT), { recursive: true });
    await download.saveAs(ICS_ARTIFACT);
    const ics = readFileSync(ICS_ARTIFACT, "utf8");
    flow.check("downloaded file is a calendar", true, ics.includes("BEGIN:VCALENDAR"));
    flow.check("downloaded calendar names the event", true, ics.includes(EVENT_TITLE));
  });

  await flow.step("guest: Share opens the desktop popover", async () => {
    await guestPage.getByRole("button", { name: "Share event" }).click();
    const panel = guestPage.getByRole("dialog");
    await expect(panel.getByRole("button", { name: "WhatsApp" })).toBeVisible();
    // The phone layout's sheet carries the title; the popover does not.
    flow.check(
      "desktop Share is the popover, not the sheet",
      0,
      await guestPage.getByRole("dialog", { name: "Share event" }).count(),
    );
    await guestPage.keyboard.press("Escape");
    await expect(panel).toHaveCount(0);
  });

  // Each person's cookies as they stand signed in, for the refusals below.
  const hostState = await context.storageState();
  const guestState = await guestContext.storageState();

  await flow.step("host: /calendar draws the day timeline once hydrated", async () => {
    const hydration = watchHydration(page);
    await page.goto(`${ORIGINS.pulseWeb}/calendar`);
    await untilPulseHydrated(page);
    const day = page.locator(".cal-timeline .cal-day").filter({ hasText: EVENT_TITLE });
    await expect(day).toBeVisible();
    // The browser's own day heading (its zone is UTC, playwright.config.ts).
    flow.check(
      "the event's day heading on the timeline",
      usDate(startIso, "UTC"),
      (await day.locator(".cal-day__label").textContent()) ?? "missing",
    );
    // Only the timeline's card links the event: the server's list is gone.
    flow.check(
      "links to the event on the hydrated /calendar",
      "1 in the timeline, 1 in all",
      `${await page.locator(`.cal-timeline a[href="/events/${eventId}"]`).count()} in the timeline, ${await page.locator(`a[href="/events/${eventId}"]`).count()} in all`,
    );
    hydration.stop();
    flow.check("hydration messages on /calendar", 0, hydration.messages.length);
  });

  await flow.step("host: /calendar arrives filled in, without JavaScript", async () => {
    const visit = await calendarWithoutJs(flow, browser, sentToPulseApi, {
      storageState: hostState,
    });
    await expect(visit.page.getByText(EVENT_TITLE)).toBeVisible();
    await expect(visit.page.getByText(SIGNED_OUT_CALENDAR)).toHaveCount(0);
    // The header read the same session on the server: the host's avatar
    // initial, and no sign-in button.
    await expect(visit.page.getByRole("button", { name: "H", exact: true })).toBeVisible();
    await expect(visit.page.getByRole("button", { name: "Continue with musubi" })).toHaveCount(0);
    flow.check(
      "signed-in page Cache-Control",
      "private, no-store",
      visit.headers["cache-control"] ?? "missing",
    );
    flow.check(
      "signed-in page varies on Cookie",
      true,
      (visit.headers["vary"] ?? "").toLowerCase().includes("cookie"),
    );
    await visit.close();
  });

  await flow.step("guest: /calendar arrives filled in, without JavaScript", async () => {
    const visit = await calendarWithoutJs(flow, browser, sentToPulseApi, {
      storageState: guestState,
    });
    await expect(visit.page.getByText(EVENT_TITLE)).toBeVisible();
    await visit.close();
  });

  await flow.step("guest: an expired session renders /calendar signed out", async () => {
    const live = queryOne<{ expires_at: number }>(
      DB_FILES.pulse,
      "SELECT expires_at FROM pulse_web_sessions WHERE handle = ?",
      PEOPLE.pulseGuest.handle,
    );
    // A minute before the suite's clock started: past on every run.
    const aged = setPulseSessionExpiry(PEOPLE.pulseGuest.handle, Math.floor(CLOCK_T0 / 1000) - 60);
    flow.check("guest: sessions aged past their expiry", 1, aged);
    try {
      const visit = await calendarWithoutJs(flow, browser, sentToPulseApi, {
        storageState: guestState,
      });
      await expectSignedOut(flow, visit.page, "guest, expired");
      await visit.close();
    } finally {
      if (live) setPulseSessionExpiry(PEOPLE.pulseGuest.handle, live.expires_at);
    }
  });

  await flow.step("visitor: /calendar with no cookie is signed out", async () => {
    const visit = await calendarWithoutJs(flow, browser, sentToPulseApi);
    await expectSignedOut(flow, visit.page, "visitor, no cookie");
    await visit.close();
  });

  await flow.step("visitor: an unknown session cookie renders /calendar signed out", async () => {
    const visit = await calendarWithoutJs(flow, browser, sentToPulseApi, {
      session: "not-a-session",
    });
    await expectSignedOut(flow, visit.page, "visitor, unknown cookie");
    await visit.close();
  });

  await flow.step("host: a write from another site's Origin is refused", async () => {
    const response = await pulseWrite(
      flow,
      page.request,
      "POST",
      "/events",
      { title: "E2E Cross-site", startTime: "2026-11-21T18:00:00.000Z" },
      "https://evil.example",
    );
    expect(response.status(), "cross-site write refused").toBe(403);
  });
  flow.check(
    "events rows from the cross-site write",
    0,
    queryOne<{ n: number }>(
      DB_FILES.pulse,
      "SELECT count(*) AS n FROM events WHERE title = ?",
      "E2E Cross-site",
    )?.n ?? -1,
  );

  await flow.step(
    "visitor: the event's start is written by the server, in UTC, named",
    async () => {
      // No venue or series, so no zone of its own: UTC. `de-DE` reaches the
      // server as Accept-Language and picks the locale.
      const visitor = await browser.newContext({ javaScriptEnabled: false, locale: "de-DE" });
      watchPulseApiOrigin(visitor, sentToPulseApi);
      const visitorPage = await flow.newPage(visitor);
      await visitorPage.goto(`${ORIGINS.pulseWeb}/events/${eventId}`);
      const start = visitorPage.locator(`time[datetime="${startIso}"]`).first();
      await expect(start).toBeVisible();
      flow.check(
        "server's date locale for Accept-Language de-DE",
        "de-DE",
        (await visitorPage.locator("html").getAttribute("data-date-locale")) ?? "missing",
      );
      flow.check(
        "event start as the server writes it",
        serverWritten(startIso, "de-DE", "UTC"),
        (await start.textContent()) ?? "missing",
      );
      await visitor.close();
    },
  );

  await flow.step("visitor in Auckland: the event's start turns local once hydrated", async () => {
    const visitor = await browser.newContext({ timezoneId: "Pacific/Auckland", locale: "de-DE" });
    watchPulseApiOrigin(visitor, sentToPulseApi);
    const visitorPage = await flow.newPage(visitor);
    const hydration = watchHydration(visitorPage);
    await visitorPage.goto(`${ORIGINS.pulseWeb}/events/${eventId}`);
    await untilPulseHydrated(visitorPage);
    const start = visitorPage.locator(`time[datetime="${startIso}"]`).first();
    // Rewritten in the reader's zone and locale, with no zone named.
    await expect(start).not.toContainText("UTC");
    flow.check(
      "event start as an Auckland reader sees it, on Auckland's day",
      new Date(startIso).toLocaleString("de-DE", { ...EVENT_TIME, timeZone: "Pacific/Auckland" }),
      (await start.textContent()) ?? "missing",
    );
    flow.check(
      "Auckland's day is not UTC's",
      true,
      dayIn(startIso, "Pacific/Auckland") !== dayIn(startIso, "UTC"),
    );
    // Where the browser's first render takes the server's locale from, so it
    // repeats the server's text while hydrating.
    flow.check(
      "the browser reads the server's date locale from the page",
      "de-DE",
      await visitorPage.evaluate(() => document.documentElement.dataset.dateLocale ?? "missing"),
    );
    hydration.stop();
    flow.check("hydration messages on the event page", 0, hydration.messages.length);
    await visitor.close();
  });

  await flow.step("visitor on a phone: the event page corrects to the phone layout", async () => {
    // The server has no viewport and writes the desktop layout; the browser
    // starts there while hydrating and switches once mounted.
    const visitor = await browser.newContext({ viewport: { width: 390, height: 844 } });
    watchPulseApiOrigin(visitor, sentToPulseApi);
    const visitorPage = await flow.newPage(visitor);
    const hydration = watchHydration(visitorPage);
    await visitorPage.goto(`${ORIGINS.pulseWeb}/events/${eventId}`);
    await untilPulseHydrated(visitorPage);
    await visitorPage.getByRole("button", { name: "Share event" }).click();
    const sheet = visitorPage.getByRole("dialog", { name: "Share event" });
    await expect(sheet.getByRole("button", { name: "WhatsApp" })).toBeVisible();
    hydration.stop();
    flow.check("hydration messages on the event page, mobile", 0, hydration.messages.length);
    await visitor.close();
  });

  await flow.step(
    "visitor: Explore's dates and greeting are the server's, without JavaScript",
    async () => {
      const visitor = await browser.newContext({ javaScriptEnabled: false });
      watchPulseApiOrigin(visitor, sentToPulseApi);
      const visitorPage = await flow.newPage(visitor);
      await visitorPage.goto(ORIGINS.pulseWeb);
      await expect(visitorPage.getByText("Hello", { exact: true })).toBeVisible();
      const hero = (await visitorPage.getByRole("heading", { level: 1 }).textContent()) ?? "";
      flow.check(
        "Explore hero line, server",
        "Here's what's pulsing nearby.",
        hero.replace(/\s+/g, " ").trim(),
      );
      flow.check(
        "Explore heat-map hour, server, names UTC",
        1,
        await visitorPage
          .locator("span")
          .filter({ hasText: /^\d{1,2}:00 (am|pm) UTC · / })
          .count(),
      );
      // The card's own line: an absolute date and the clock in UTC, named.
      const expected = `${usDate(startIso, "UTC")} · ${cardClock(startIso, "UTC")} UTC`;
      const written = await visitorPage.locator(`time[datetime="${startIso}"]`).allTextContents();
      flow.check(
        "Explore card time, server",
        expected,
        written.find((text) => text === expected) ?? written.join(" | "),
      );
      await visitor.close();
    },
  );

  await flow.step("visitor in Auckland: Explore turns local once hydrated", async () => {
    const visitor = await browser.newContext({ timezoneId: "Pacific/Auckland" });
    watchPulseApiOrigin(visitor, sentToPulseApi);
    const visitorPage = await flow.newPage(visitor);
    const hydration = watchHydration(visitorPage);
    await visitorPage.goto(ORIGINS.pulseWeb);
    await untilPulseHydrated(visitorPage);
    await expect(
      visitorPage.getByText(/^Good (morning|afternoon|evening)$/),
      "greeting from the reader's clock",
    ).toBeVisible();
    await expect(visitorPage.getByRole("heading", { level: 1 })).toHaveText(
      /nearby this (late|morning|afternoon|evening|tonight)\.$/,
    );
    flow.check(
      "Explore heat-map hour, reader, names no zone",
      "1 without a zone, 0 with UTC",
      `${await visitorPage
        .locator("span")
        .filter({ hasText: /^\d{1,2}:00 (am|pm) · / })
        .count()} without a zone, ${await visitorPage
        .locator("span")
        .filter({ hasText: /^\d{1,2}:00 (am|pm) UTC · / })
        .count()} with UTC`,
    );
    // The browser's clock is the suite's, weeks before the event, so the
    // card writes the date, in Auckland, with no zone.
    const expected = `${usDate(startIso, "Pacific/Auckland")} · ${cardClock(startIso, "Pacific/Auckland")}`;
    const times = visitorPage.locator(`time[datetime="${startIso}"]`);
    await expect(times.filter({ hasText: expected })).toHaveCount(1);
    const written = await times.allTextContents();
    flow.check(
      "Explore card time, reader in Auckland",
      expected,
      written.find((text) => text === expected) ?? written.join(" | "),
    );
    hydration.stop();
    flow.check("hydration messages on /", 0, hydration.messages.length);
    await visitor.close();
  });

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
      dtstart: SERIES_FIRST,
      timezone: SERIES_ZONE,
    });
    expect(response.status(), "series created").toBe(201);
    return ((await response.json()) as { series: { id: string } }).series.id;
  });

  await flow.step(
    "visitor: a series' dates are written by the server in its own zone",
    async () => {
      const visitor = await browser.newContext({ javaScriptEnabled: false });
      watchPulseApiOrigin(visitor, sentToPulseApi);
      const visitorPage = await flow.newPage(visitor);
      await visitorPage.goto(`${ORIGINS.pulseWeb}/series/${seriesId}`);
      const first = visitorPage.locator(`time[datetime="${SERIES_FIRST}"]`);
      await expect(first.first()).toBeVisible();
      // The suite's browsers send Accept-Language en-AU (playwright.config.ts).
      const expected = serverWritten(SERIES_FIRST, "en-AU", SERIES_ZONE);
      const written = await first.allTextContents();
      flow.check(
        "first occurrence as the server writes it, in the series' zone",
        expected,
        written.find((text) => text === expected) ?? written.join(" | "),
      );
      flow.check(
        "the series' zone puts it on another day than UTC",
        true,
        dayIn(SERIES_FIRST, SERIES_ZONE) !== dayIn(SERIES_FIRST, "UTC"),
      );
      await visitor.close();
    },
  );

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

  /** How many Pulse web sessions `handle` holds. */
  const sessionsOf = (handle: string): number =>
    queryOne<{ n: number }>(
      DB_FILES.pulse,
      "SELECT count(*) AS n FROM pulse_web_sessions WHERE handle = ?",
      handle,
    )?.n ?? -1;

  await flow.step("host: sign out everywhere", async () => {
    const response = await pulseWrite(flow, page.request, "POST", "/auth/signout?all=1");
    expect(response.status(), "signed out everywhere").toBe(200);
  });
  flow.check(
    "host: sessions left after signing out everywhere",
    0,
    sessionsOf(PEOPLE.pulseHost.handle),
  );

  await flow.step(
    "host: a cookie from before signing out everywhere renders /calendar signed out",
    async () => {
      const visit = await calendarWithoutJs(flow, browser, sentToPulseApi, {
        storageState: hostState,
      });
      await expectSignedOut(flow, visit.page, "host, signed out everywhere");
      await visit.close();
    },
  );

  await flow.step("guest: log out from the menu", async () => {
    const signedOut = guestPage.waitForResponse(
      (r) => r.request().method() === "POST" && r.url() === `${ORIGINS.pulseWeb}/api/auth/signout`,
    );
    await untilPulseHydrated(guestPage);
    // The avatar menu, named by the initial it shows.
    await guestPage.getByRole("button", { name: "G", exact: true }).click();
    await guestPage.getByRole("menuitem", { name: "Log out" }).click();
    expect((await signedOut).status(), "log out answered").toBe(200);
    await expect(guestPage.getByRole("button", { name: "Continue with musubi" })).toBeVisible();
  });
  flow.check("guest: sessions left after logging out", 0, sessionsOf(PEOPLE.pulseGuest.handle));

  await flow.step(
    "guest: a cookie from before logging out renders /calendar signed out",
    async () => {
      const visit = await calendarWithoutJs(flow, browser, sentToPulseApi, {
        storageState: guestState,
      });
      await expectSignedOut(flow, visit.page, "guest, logged out");
      await visit.close();
    },
  );

  flow.check("browser requests sent to pulse-api's own origin", 0, sentToPulseApi.length);
});
