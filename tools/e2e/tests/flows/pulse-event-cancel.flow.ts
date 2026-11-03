/**
 * Pulse: an organiser cancels one event and then a whole series through
 * pulse-api, and each cancelled row records when and by whom it was
 * cancelled. No Pulse screen writes a status, so the writes go through the
 * API the web app's session cookie authorises — with the web app's Origin,
 * which pulse-api's origin guard requires on a cookie-carrying write.
 */

import { DB_FILES, ORIGINS, PEOPLE } from "../../src/config";
import { expect, queryOne, registerThroughApi, signInToPulse, test } from "../support/fixtures";

const WRITE = { headers: { Origin: ORIGINS.pulseWeb } };

test("pulse-event-cancel", async ({ page, context, flow }) => {
  await flow.step("organiser: create an OSN account", () =>
    registerThroughApi(flow, context.request, PEOPLE.pulseOrganiser),
  );
  await signInToPulse(flow, page, "organiser");
  const api = page.request;

  const eventId = await flow.step("organiser: create an event", async () => {
    const response = await api.post(`${ORIGINS.pulseApi}/events`, {
      ...WRITE,
      data: { title: "E2E Called Off", startTime: "2026-11-21T18:00:00.000Z" },
    });
    expect(response.status(), "event created").toBe(201);
    return ((await response.json()) as { event: { id: string } }).event.id;
  });

  await flow.step("organiser: cancel the event", async () => {
    const response = await api.patch(`${ORIGINS.pulseApi}/events/${eventId}`, {
      ...WRITE,
      data: { status: "cancelled" },
    });
    expect(response.status(), "event cancelled").toBe(200);
  });

  const event = queryOne<{
    status: string;
    cancelled_at: number | null;
    cancellation_reason: string | null;
  }>(
    DB_FILES.pulse,
    "SELECT status, cancelled_at, cancellation_reason FROM events WHERE id = ?",
    eventId,
  );
  flow.check("cancelled event status", "cancelled", event?.status ?? "missing");
  flow.check("cancelled event has cancelled_at", true, event?.cancelled_at != null);
  flow.check("cancelled event reason", "organiser", event?.cancellation_reason ?? "missing");

  await flow.step("organiser: maybe_finished is refused", async () => {
    const response = await api.patch(`${ORIGINS.pulseApi}/events/${eventId}`, {
      ...WRITE,
      data: { status: "maybe_finished" },
    });
    expect(response.status(), "display-only status refused").toBe(422);
  });

  const seriesId = await flow.step("organiser: create a weekly series", async () => {
    const response = await api.post(`${ORIGINS.pulseApi}/series`, {
      ...WRITE,
      data: {
        title: "E2E Weekly",
        rrule: "FREQ=WEEKLY;COUNT=3",
        dtstart: "2026-11-23T18:00:00.000Z",
      },
    });
    expect(response.status(), "series created").toBe(201);
    return ((await response.json()) as { series: { id: string } }).series.id;
  });

  const cancelled = await flow.step("organiser: cancel the series", async () => {
    const response = await api.delete(`${ORIGINS.pulseApi}/series/${seriesId}`, WRITE);
    expect(response.status(), "series cancelled").toBe(200);
    return ((await response.json()) as { cancelled: number }).cancelled;
  });
  flow.check("series cancel count", 3, cancelled);

  const again = await flow.step("organiser: cancel the series again", async () => {
    const response = await api.delete(`${ORIGINS.pulseApi}/series/${seriesId}`, WRITE);
    expect(response.status(), "second cancel answered").toBe(200);
    return ((await response.json()) as { cancelled: number }).cancelled;
  });
  flow.check("second series cancel count", 0, again);

  const instances = queryOne<{ total: number; stamped: number }>(
    DB_FILES.pulse,
    `SELECT COUNT(*) AS total,
            SUM(status = 'cancelled' AND cancelled_at IS NOT NULL AND cancellation_reason = 'organiser') AS stamped
       FROM events WHERE series_id = ?`,
    seriesId,
  );
  flow.check("series instances", 3, instances?.total ?? 0);
  flow.check("series instances cancelled by the organiser", 3, instances?.stamped ?? 0);
});
