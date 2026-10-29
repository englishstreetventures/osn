/**
 * Cire's feedback parts, read from computed style and pictured: the error line
 * and the standing note `@shared/ui`'s `Notice` draws, and the outlined badge
 * `Chip` draws (`cire/host/DESIGN.md` §7). Shots go to
 * `screenshots/cire-feedback/`.
 *
 * Two places the `cire-soft-shapes` flow already stands, so it signs in no more
 * than it did:
 *
 * - the marketing site's demo RSVP, open on a phone with one guest answered:
 *   "Send RSVP" then fails for the other, which puts the inline error line on
 *   screen in the sheet's sticky bar, uncovered — an alert led by a hidden
 *   icon, no border, no fill — and the "Interactive preview" note is the
 *   accent box at the 6px step;
 * - the host's invite builder on its Hero section at a desktop width, where the
 *   section's state badge is an outlined pill, a live region.
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

import type { Locator, Page } from "@playwright/test";

import { SCREENSHOT_DIR } from "../../src/config";
import { expect, type Flow } from "./fixtures";

const SHOTS = resolve(SCREENSHOT_DIR, "cire-feedback");
const PHONE = { width: 390, height: 844 } as const;
const DESKTOP = { width: 1440, height: 900 } as const;
type Scheme = "light" | "dark";

/** One computed property of `target`. */
function computed(target: Locator, property: string): Promise<string> {
  return target.evaluate((el, prop) => getComputedStyle(el).getPropertyValue(prop), property);
}

/** Shoots `view` at `size` in both schemes, with `settle` after each change. */
async function shoot(
  page: Page,
  view: string,
  size: { width: number; height: number },
  settle: (scheme: Scheme) => Promise<void>,
): Promise<void> {
  mkdirSync(SHOTS, { recursive: true });
  await page.addStyleTag({ content: "astro-dev-toolbar { display: none !important; }" });
  for (const colorScheme of ["light", "dark"] as const) {
    await page.setViewportSize(size);
    await page.emulateMedia({ colorScheme });
    await page.mouse.move(0, 0);
    await settle(colorScheme);
    await page.screenshot({
      path: resolve(SHOTS, `${view}-${size.width}-${colorScheme}.png`),
      animations: "disabled",
    });
  }
  await page.emulateMedia({ colorScheme: "light" });
}

/** A box is a pill when its corner is at least half its height. */
async function isPill(target: Locator): Promise<boolean> {
  const [radius, height] = await Promise.all([
    computed(target, "border-top-left-radius"),
    target.evaluate((el) => el.getBoundingClientRect().height),
  ]);
  return height > 0 && Number.parseFloat(radius) >= height / 2;
}

/**
 * The demo sheet, open on a phone with one of its two guests answered: press
 * "Send RSVP", read the error line and the preview note, and shoot them.
 */
export async function landingFeedback(flow: Flow, landing: Page, demo: Locator): Promise<void> {
  const alert = demo.getByRole("alert");
  await flow.step("feedback: send the demo RSVP with a guest unanswered", async () => {
    await landing.setViewportSize(PHONE);
    await demo.getByRole("button", { name: "Send RSVP" }).click();
    await expect(alert).toBeVisible();
  });
  flow.check(
    "feedback: the demo's error line names its words",
    true,
    ((await alert.textContent()) ?? "").startsWith("Error: "),
  );
  flow.check(
    "feedback: the demo's error line leads with a hidden icon",
    1,
    await alert.locator("[aria-hidden='true'] svg").count(),
  );
  flow.check(
    "feedback: the demo's error line draws no border",
    "0px",
    await computed(alert, "border-top-width"),
  );
  flow.check(
    "feedback: the demo's error line draws no fill",
    "rgba(0, 0, 0, 0)",
    await computed(alert, "background-color"),
  );
  const note = demo
    .getByRole("status")
    .filter({ hasText: "Interactive preview" })
    .locator(":scope > div");
  flow.check(
    "feedback: the demo's preview note has a border",
    "1px",
    await computed(note, "border-top-width"),
  );
  flow.check(
    "feedback: the demo's preview note takes the 6px step",
    "6px",
    await computed(note, "border-top-left-radius"),
  );
  flow.check(
    "feedback: the demo's preview note carries no mark",
    0,
    await note.locator("[aria-hidden='true']").count(),
  );
  // In view and not under the sheet's sticky footer: the point at its middle
  // is the line itself.
  const uncovered = () =>
    alert.evaluate((el) => {
      el.scrollIntoView({ block: "center" });
      const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return hit !== null && el.contains(hit);
    });
  flow.check("feedback: the demo's error line is on screen, uncovered", true, await uncovered());
  await flow.step("feedback: shoot the demo's error line and note", () =>
    shoot(landing, "landing-demo-error", PHONE, async () => {
      await expect.poll(uncovered).toBe(true);
    }),
  );
}

/**
 * The invite builder, open on its sections: the Hero section's state badge, at
 * a desktop width where the sections are a tab strip.
 */
export async function builderFeedback(flow: Flow, page: Page): Promise<void> {
  const sections = page.getByLabel("Invite sections");
  const panel = page.getByRole("tabpanel").filter({ has: page.locator("[data-segment-badge]") });
  const badge = panel.locator("[data-segment-badge]").first();
  await flow.step("feedback: open the builder's Hero section", async () => {
    await page.setViewportSize(DESKTOP);
    await sections.getByRole("tab", { name: /^Hero/ }).click();
    await expect(badge).toBeVisible();
  });
  flow.check("feedback: the section badge is a pill", true, await isPill(badge));
  flow.check(
    "feedback: the section badge is outlined",
    "1px",
    await computed(badge, "border-top-width"),
  );
  flow.check(
    "feedback: the section badge draws no fill",
    "rgba(0, 0, 0, 0)",
    await computed(badge, "background-color"),
  );
  flow.check(
    "feedback: the section badge is a live region",
    "status",
    (await badge.getAttribute("role")) ?? "",
  );
  await flow.step("feedback: shoot the section badge", () =>
    shoot(page, "host-builder-badge", DESKTOP, async (scheme) => {
      await expect(page.locator("html")).toHaveAttribute("data-theme", scheme);
      await badge.scrollIntoViewIfNeeded();
      await expect(badge).toBeInViewport();
    }),
  );
  await flow.step("feedback: back to the builder's Design tab", async () => {
    await sections.getByRole("tab", { name: /^Design/ }).click();
  });
}
