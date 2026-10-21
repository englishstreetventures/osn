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

  // The footer prints the commit the guest site was built from, so a report
  // from a phone says which build it was. A local dev server has none.
  const version = await flow.step("read the build's version in the footer", async () => {
    const footer = page.getByRole("contentinfo");
    const line = footer.getByText(/^Version /);
    await expect(line).toBeVisible();
    const before = page.viewportSize();
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      await footer.scrollIntoViewIfNeeded();
      await footer.screenshot({
        path: resolve(SCREENSHOT_DIR, `cire-rsvp--footer-${width}.png`),
        animations: "disabled",
      });
    }
    if (before) await page.setViewportSize(before);
    await page.evaluate(() => window.scrollTo(0, 0));
    return (await line.textContent())?.trim() ?? "none";
  });
  flow.check("the footer prints the build's version", "Version local", version);

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
  // The sheet's switch: exact names, since "Details" and "Respond" are also
  // inside its titles' and the card's words.
  const detailsSegment = sheet.getByRole("button", { name: "Details", exact: true });
  const respondSegment = sheet.getByRole("button", { name: "Respond", exact: true });
  const panelSwitch = sheet.getByRole("group", { name: "Event sheet" });
  /** Where the sheet's bar is: its title, the switch and the close button, first in the scrollport. */
  const barBox = () =>
    sheet.evaluate((d) => {
      const box = (d.lastElementChild!.firstElementChild as HTMLElement).getBoundingClientRect();
      return { y: box.y, height: box.height };
    });
  /**
   * A point on the first line of a panel's content, across the panel's middle
   * and clear of every control: the event's day on the details, the guest's
   * name on the form. A swipe starts on a panel, never on the bar.
   */
  const onContent = async (panel: "details" | "rsvp"): Promise<Point> => {
    const wrapper = sheet.locator(`[data-panel="${panel}"]`);
    const line = (await wrapper
      .locator(panel === "details" ? "dl p" : "legend")
      .first()
      .boundingBox())!;
    const across = (await wrapper.boundingBox())!;
    return { x: across.x + across.width / 2, y: line.y + line.height / 2 };
  };

  await flow.step("open the ceremony's details on a phone", async () => {
    await page.setViewportSize(PHONE);
    await page
      .getByRole("article")
      .filter({ has: page.getByRole("heading", { name: "Catholic Ceremony" }) })
      .getByRole("button", { name: "Event Details" })
      .click();
    await expect(sheet.getByRole("heading", { name: /^Details.*Catholic Ceremony/ })).toBeVisible();
    await expect(respondSegment).toBeVisible();
    await expect(detailsSegment).toHaveAttribute("aria-pressed", "true");
  });

  // The page behind the sheet is locked at the root: a drag that starts on
  // the sheet's bar or on the backdrop must not reach the invite underneath.
  // The bar is sticky inside the sheet's scrollport, so a drag on it may
  // scroll the sheet — never the page. A still page proves that only when the
  // page had somewhere to go: an upward drag scrolls it down, so it needs room
  // below it, and is moved up first when the sheet opened too near its foot.
  const locked = await flow.step("drag on the sheet's bar and on the backdrop", async () => {
    const room = () =>
      page.evaluate(
        () => document.documentElement.scrollHeight - window.innerHeight - window.scrollY,
      );
    if ((await room()) < 200) {
      await page.evaluate(() =>
        window.scrollTo(
          0,
          Math.max(0, document.documentElement.scrollHeight - window.innerHeight - 400),
        ),
      );
    }
    const hadRoom = (await room()) >= 200;
    const before = await page.evaluate(() => window.scrollY);
    const heading = (await sheet
      .getByRole("heading", { name: /Catholic Ceremony/ })
      .boundingBox())!;
    const onBar = { x: heading.x + heading.width / 2, y: heading.y + heading.height / 2 };
    await swipe(page, onBar, { x: onBar.x, y: onBar.y - 200 }, 400);
    await swipe(page, { x: PHONE.width / 2, y: 160 }, { x: PHONE.width / 2, y: 20 }, 400);
    await expect(sheet).toBeVisible();
    return { hadRoom, still: before === (await page.evaluate(() => window.scrollY)) };
  });
  flow.check("the page behind the sheet had room to scroll", true, locked.hadRoom);
  flow.check(
    "a drag on the sheet's bar or backdrop leaves the page where it was",
    true,
    locked.still,
  );

  /** Put the sheet back at its top, until it stays there: a fling a drag left may still be moving it. */
  const toTop = () =>
    expect
      .poll(() =>
        sheet.evaluate(async (d) => {
          const port = d.lastElementChild as HTMLElement;
          port.scrollTop = 0;
          await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
          return port.scrollTop;
        }),
      )
      .toBe(0);

  await flow.step("scroll the details with a vertical drag", async () => {
    // The drag on the bar may have scrolled the sheet; this one must start from the top.
    await toTop();
    const at = await onContent("details");
    // Slow enough to leave no fling behind: the next step needs the scroll still.
    await swipe(page, { x: at.x, y: at.y + 300 }, { x: at.x - 15, y: at.y }, 1000);
    await expect
      .poll(() => sheet.evaluate((d) => (d.lastElementChild as HTMLElement).scrollTop))
      .toBeGreaterThan(0);
  });
  flow.check("a vertical drag leaves the details on screen", true, await details.isVisible());

  // The bar stays at the top of the sheet, frosted, with the details passing
  // under it.
  const underBar = await flow.step("scroll the details 200px under the bar", async () => {
    await toTop();
    const atRest = await barBox();
    await sheet.evaluate(async (d) => {
      (d.lastElementChild as HTMLElement).scrollTop = 200;
      await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
    });
    await page.screenshot({
      path: resolve(SCREENSHOT_DIR, "cire-rsvp--sheet-details-under-bar.png"),
      animations: "disabled",
    });
    const scrolled = await barBox();
    const facts = (await details.locator("dl").boundingBox())!;
    return {
      still: scrolled.y === atRest.y && scrolled.height === atRest.height,
      under: facts.y < atRest.y + atRest.height,
    };
  });
  flow.check("the bar stays put while the details scroll", true, underBar.still);
  flow.check("the details pass under the bar", true, underBar.under);

  // 20px: past the slop, so the drag begins and the form is drawn in, but
  // under the shortest flick, so the release springs back however fast the
  // browser reads the finger's moves (it may not honour their timestamps).
  await flow.step("drag the details a little and let go", async () => {
    await toTop();
    const at = await onContent("details");
    const finger = await swipe(page, at, { x: at.x - 20, y: at.y }, 1000, false);
    await expect(details).toHaveAttribute("style", /translateX\(-20px\)/);
    await expect(form).toBeVisible();
    await finger.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await expect(form).toBeHidden();
  });
  flow.check("a short drag springs back to the details", true, await details.isVisible());

  // The switch's pill follows the finger rather than jumping once the panels
  // land: held part-way, it stands between its two segments.
  const midSwipe = await flow.step(
    "hold a swipe part-way, and see the switch follow it",
    async () => {
      const at = await onContent("details");
      const finger = await swipe(page, at, { x: at.x - 120, y: at.y }, 1000, false);
      await expect(form).toBeVisible();
      const progress = await panelSwitch.evaluate((group) =>
        Number.parseFloat((group as HTMLElement).style.getPropertyValue("--seg-progress")),
      );
      await page.screenshot({
        path: resolve(SCREENSHOT_DIR, "cire-rsvp--sheet-mid-swipe.png"),
        animations: "disabled",
      });
      await finger.send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] });
      await expect(form).toBeHidden();
      return progress;
    },
  );
  flow.check(
    "mid-swipe the switch stands between its segments",
    true,
    midSwipe > 0 && midSwipe < 1,
  );

  await flow.step("swipe left to the RSVP form", async () => {
    await page.screenshot({
      path: resolve(SCREENSHOT_DIR, "cire-rsvp--sheet-details.png"),
      animations: "disabled",
    });
    const at = await onContent("details");
    await swipe(page, at, { x: at.x - 200, y: at.y }, 150);
    await expect(sheet.getByRole("heading", { name: /^Respond.*Catholic Ceremony/ })).toBeFocused();
    await expect(details).toBeHidden();
    await expect(detailsSegment).toHaveAttribute("aria-pressed", "false");
  });
  flow.check(
    "nothing chosen before the swipe round trip",
    "false",
    (await attending.getAttribute("aria-pressed")) ?? "false",
  );

  await flow.step("choose Attending, unsaved", async () => {
    await attending.click();
    await expect(attending).toHaveAttribute("aria-pressed", "true");
    await page.screenshot({
      path: resolve(SCREENSHOT_DIR, "cire-rsvp--sheet-rsvp.png"),
      animations: "disabled",
    });
  });

  await flow.step("swipe right back to the details", async () => {
    const at = await onContent("rsvp");
    await swipe(page, at, { x: at.x + 200, y: at.y }, 150);
    await expect(sheet.getByRole("heading", { name: /^Details.*Catholic Ceremony/ })).toBeFocused();
    await expect(detailsSegment).toHaveAttribute("aria-pressed", "true");
  });

  await flow.step("return with the switch", async () => {
    await respondSegment.click();
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
