/**
 * Cire: a guest opens the seeded wedding's invite with their family code and
 * RSVPs, and the reply lands in cire-api's database.
 *
 * The guest session cookie comes from cire-api (`localhost:8787`) on the
 * invite site's (`localhost:4321`) cross-origin claim, and the RSVP is only
 * accepted if that cookie rides on the save.
 */

import { resolve } from "node:path";

import type { Page } from "@playwright/test";

import { CIRE_GUEST, DB_FILES, ORIGINS, SCREENSHOT_DIR } from "../../src/config";
import { cookieNamed, expect, onSuiteClock, queryOne, test } from "../support/fixtures";

/** The seeded ceremony Ada is invited to (`cire/db/seed/data/events.ts`). */
const CEREMONY_ID = "9f7a2c14-1b3d-4e5f-8a01-000000000001";

/** A phone, where the event sheet is a bottom sheet and a guest swipes it. */
const PHONE = { width: 390, height: 844 };

// Touch input on, so the browser runs its touch pipeline — `touch-action`,
// its own scroll, pointer events of type "touch" — for the swipes below.
test.use({ hasTouch: true });

interface Point {
  x: number;
  y: number;
}

/**
 * A finger on the page from `from` to `to` over `ms`, through Chromium's own
 * input pipeline (CDP `Input.dispatchTouchEvent`), so the browser decides what
 * is a scroll and what reaches the page, as on a phone. Every event carries
 * its own timestamp, so the swipe's speed is the one written here rather than
 * however fast the runner sends it. `lift: false` leaves the finger down.
 */
async function swipe(page: Page, from: Point, to: Point, ms: number, lift = true) {
  const session = await page.context().newCDPSession(page);
  const t0 = Date.now() / 1000;
  const steps = 10;
  await session.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ ...from, id: 1 }],
    timestamp: t0,
  });
  for (let i = 1; i <= steps; i++) {
    const f = i / steps;
    await session.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: from.x + (to.x - from.x) * f, y: from.y + (to.y - from.y) * f, id: 1 }],
      timestamp: t0 + (ms / 1000) * f,
    });
  }
  if (lift) {
    await session.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
      timestamp: t0 + ms / 1000 + 0.01,
    });
  }
  return session;
}

test("cire-rsvp", async ({ page, context, flow }) => {
  await flow.step("open the invite", async () => {
    await page.goto(`${ORIGINS.cireInvites}/${CIRE_GUEST.slug}`);
    await expect(page.getByLabel("Invitation code")).toBeVisible();
  });

  await flow.step("decline optional storage", async () => {
    // The consent prompt is an idle-hydrated island: it appears once the page
    // settles, so wait for it rather than racing it.
    const prompt = page.getByRole("dialog", { name: "Privacy choices" });
    await expect(prompt).toBeVisible({ timeout: 60_000 });
    await prompt.getByRole("button", { name: "Reject all" }).click();
    await expect(prompt).toBeHidden();
  });

  await flow.step("enter the family code", async () => {
    await page.getByLabel("Invitation code").fill(CIRE_GUEST.code);
    await expect(page.getByRole("button", { name: "Open Invitation" })).toBeEnabled();
    await page.getByRole("button", { name: "Open Invitation" }).click();
    await expect(page.getByText(CIRE_GUEST.guestName).first()).toBeVisible();
  });

  await flow.step("see who is answering", async () => {
    // A household of one is chosen for: no question, and no "Not you?".
    await expect(page.getByText(`Answering as ${CIRE_GUEST.guestName}`)).toBeVisible();
  });
  flow.check(
    "no 'Not you?' for a household of one",
    0,
    await page.getByRole("button", { name: "Not you?" }).count(),
  );

  const cookie = await cookieNamed(context, ORIGINS.cireApi, "cire_session");
  flow.check("cire_session cookie set by cire-api", true, cookie !== undefined);
  flow.check("cire_session is HttpOnly", true, cookie?.httpOnly ?? false);

  const sheet = page.getByRole("dialog");
  const details = sheet.locator('[data-panel="details"]');
  const form = sheet.locator('[data-panel="rsvp"]');
  const attending = sheet.getByRole("button", { name: "Attending", exact: true }).first();
  /** A point on a panel's heading, clear of every control. */
  const onHeading = async (panel: "details" | "rsvp"): Promise<Point> => {
    const box = (await sheet.locator(`[data-panel="${panel}"] h3`).boundingBox())!;
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  };

  await flow.step("open the ceremony's details on a phone", async () => {
    await page.setViewportSize(PHONE);
    await page
      .getByRole("article")
      .filter({ has: page.getByRole("heading", { name: "Catholic Ceremony" }) })
      .getByRole("button", { name: "Event Details" })
      .click();
    await expect(sheet.getByRole("heading", { name: /^Details.*Catholic Ceremony/ })).toBeVisible();
    await expect(sheet.getByRole("button", { name: "Give RSVP" })).toBeVisible();
  });

  await flow.step("scroll the details with a vertical drag", async () => {
    const at = await onHeading("details");
    // Slow enough to leave no fling behind: the next step needs the scroll still.
    await swipe(page, { x: at.x, y: at.y + 300 }, { x: at.x - 15, y: at.y }, 1000);
    await expect
      .poll(() => sheet.evaluate((d) => (d.lastElementChild as HTMLElement).scrollTop))
      .toBeGreaterThan(0);
  });
  flow.check("a vertical drag leaves the details on screen", true, await details.isVisible());

  await flow.step("drag the details partway, slowly, and let go", async () => {
    await sheet.evaluate((d) => ((d.lastElementChild as HTMLElement).scrollTop = 0));
    await expect
      .poll(() => sheet.evaluate((d) => (d.lastElementChild as HTMLElement).scrollTop))
      .toBe(0);
    const at = await onHeading("details");
    const finger = await swipe(page, at, { x: at.x - 60, y: at.y }, 1000, false);
    await expect(details).toHaveAttribute("style", /translateX\(-60px\)/);
    await expect(form).toBeVisible();
    await finger.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await expect(form).toBeHidden();
  });
  flow.check("a slow, short drag springs back to the details", true, await details.isVisible());

  await flow.step("swipe left to the RSVP form", async () => {
    await page.screenshot({ path: resolve(SCREENSHOT_DIR, "cire-rsvp--sheet-details.png") });
    const at = await onHeading("details");
    await swipe(page, at, { x: at.x - 200, y: at.y }, 150);
    await expect(sheet.getByRole("heading", { name: /^Respond.*Catholic Ceremony/ })).toBeFocused();
    await expect(details).toBeHidden();
  });
  flow.check(
    "nothing chosen before the swipe round trip",
    "false",
    (await attending.getAttribute("aria-pressed")) ?? "false",
  );

  await flow.step("choose Attending, unsaved", async () => {
    await attending.click();
    await expect(attending).toHaveAttribute("aria-pressed", "true");
    await page.screenshot({ path: resolve(SCREENSHOT_DIR, "cire-rsvp--sheet-rsvp.png") });
  });

  await flow.step("swipe right back to the details", async () => {
    const at = await onHeading("rsvp");
    await swipe(page, at, { x: at.x + 200, y: at.y }, 150);
    await expect(sheet.getByRole("heading", { name: /^Details.*Catholic Ceremony/ })).toBeFocused();
    await expect(sheet.getByRole("button", { name: "See details" })).toBeHidden();
  });

  await flow.step("return with the badge", async () => {
    await sheet.getByRole("button", { name: "Give RSVP" }).click();
    await expect(sheet.getByRole("heading", { name: /^Respond.*Catholic Ceremony/ })).toBeFocused();
  });
  flow.check(
    "the unsaved answer survives the round trip",
    "true",
    (await attending.getAttribute("aria-pressed")) ?? "missing",
  );

  await flow.step("RSVP attending", async () => {
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByRole("button", { name: "Saved" })).toBeVisible();
  });

  // The sender by first name: the local seed mints fresh guest ids on every boot.
  const row = queryOne<{ status: string; created_at: number; sender: string | null }>(
    DB_FILES.cire,
    `SELECT r.status, r.created_at, s.first_name AS sender FROM rsvps r
       JOIN guests g ON g.id = r.guest_id
       JOIN families f ON f.id = g.family_id
       LEFT JOIN guests s ON s.id = r.submitted_by_guest_id
      WHERE f.public_id = ? AND g.first_name = ? AND r.event_id = ?`,
    CIRE_GUEST.code,
    CIRE_GUEST.guestName,
    CEREMONY_ID,
  );
  flow.check("rsvps row for Ada at the ceremony", "attending", row?.status ?? "missing");
  flow.check("rsvps row written on the suite clock", true, onSuiteClock(row?.created_at));
  // A one-guest household is chosen for on claim, so its reply is Ada's own.
  flow.check("rsvps row recorded as sent by Ada", "Ada", row?.sender ?? "none");
});
