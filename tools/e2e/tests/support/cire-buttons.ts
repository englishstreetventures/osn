/**
 * Cire's buttons and links, read from computed style and pictured: the glyph
 * on an opaque disc `Button`'s `round` draws, the answer pair its `choice`
 * draws, and the link inside a sentence `proseLinkClass` draws
 * (`cire/host/DESIGN.md` §7). Shots go to `screenshots/cire-buttons/`.
 *
 * Four places the `cire-soft-shapes` flow already stands, so it signs in no
 * more than it did:
 *
 * - the host's RSVP table at a desktop width, where the reply key is a 28px
 *   filled disc whose fill lifts while its popover is open;
 * - the guest site's consent prompt, whose "Privacy notice" is underlined at
 *   rest, since a phone has no hover to reveal it;
 * - the guest RSVP sheet on a phone, in both designs, with Attending chosen:
 *   the sheet's close × is a 44px filled disc, both answers stand at the
 *   guest site's 44px floor, and only the chosen one wears a ring, 2px wide;
 * - the marketing site's demo sheet on a phone, with Attending chosen: the
 *   same pair, the same ring.
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

import type { Locator, Page } from "@playwright/test";

import { SCREENSHOT_DIR } from "../../src/config";
import { expect, type Flow } from "./fixtures";

const SHOTS = resolve(SCREENSHOT_DIR, "cire-buttons");
const PHONE = { width: 390, height: 844 } as const;
const DESKTOP = { width: 1440, height: 900 } as const;
const CLEAR = "rgba(0, 0, 0, 0)";

/**
 * A control as painted, once its transitions have finished: its box, fill,
 * corner, the width of the ring a chosen `choice` wears (0 for none) and its
 * underline. Tailwind writes every ring layer into `box-shadow`, so the ring is
 * the one layer that is not transparent, and its last length is the spread.
 */
function painted(target: Locator) {
  return target.evaluate(async (el) => {
    await Promise.all(el.getAnimations().map((a) => a.finished));
    const style = getComputedStyle(el);
    const box = el.getBoundingClientRect();
    const layers = style.boxShadow === "none" ? [] : style.boxShadow.split(/,(?![^(]*\))/);
    const ring = layers.map((l) => l.trim()).find((l) => !l.startsWith("rgba(0, 0, 0, 0)"));
    const spread = ring?.match(/-?\d+(\.\d+)?px/g)?.at(-1);
    return {
      size: `${Math.round(box.width)}x${Math.round(box.height)}`,
      height: box.height,
      fill: style.backgroundColor,
      radius: Number.parseFloat(style.borderTopLeftRadius),
      ring: spread ? Number.parseFloat(spread) : 0,
      underline: style.textDecorationLine,
    };
  });
}

/** Shoots `view` at `size` in both schemes, with `settle` after each change. */
async function shoot(
  page: Page,
  view: string,
  size: { width: number; height: number },
  settle: () => Promise<void>,
): Promise<void> {
  mkdirSync(SHOTS, { recursive: true });
  await page.addStyleTag({ content: "astro-dev-toolbar { display: none !important; }" });
  for (const colorScheme of ["light", "dark"] as const) {
    await page.setViewportSize(size);
    await page.emulateMedia({ colorScheme });
    await page.mouse.move(0, 0);
    await settle();
    await page.screenshot({
      path: resolve(SHOTS, `${view}-${size.width}-${colorScheme}.png`),
      animations: "disabled",
    });
  }
  await page.emulateMedia({ colorScheme: "light" });
}

/**
 * The RSVP table's reply key, at a desktop width: a 28px filled disc that
 * lifts its fill while the popover it opens is showing. Leaves it closed.
 */
export async function replyKey(flow: Flow, page: Page): Promise<void> {
  const key = page.getByRole("button", { name: "What the reply icons mean" });
  await page.setViewportSize(DESKTOP);
  await page.emulateMedia({ colorScheme: "light" });
  const shut = await painted(key);
  flow.check("buttons: the reply key's box", "28x28", shut.size);
  flow.check(
    "buttons: the reply key is a filled disc",
    true,
    shut.fill !== CLEAR && shut.radius >= 14,
  );
  await flow.step("buttons: open the reply key", async () => {
    await key.click();
    await expect(key).toHaveAttribute("aria-expanded", "true");
  });
  flow.check(
    "buttons: the open reply key lifts its fill",
    true,
    (await painted(key)).fill !== shut.fill,
  );
  await flow.step("buttons: shoot the reply key open", () =>
    shoot(page, "host-reply-key-open", DESKTOP, async () => {
      await expect(key).toHaveAttribute("aria-expanded", "true");
    }),
  );
  await flow.step("buttons: close the reply key", async () => {
    await page.keyboard.press("Escape");
    await expect(key).toHaveAttribute("aria-expanded", "false");
  });
}

/** The consent prompt's "Privacy notice", underlined while nothing points at it. */
export async function consentLink(flow: Flow, prompt: Locator): Promise<void> {
  const link = prompt.getByRole("link", { name: "Privacy notice" });
  flow.check(
    "buttons: the consent prompt's Privacy notice is underlined at rest",
    "underline",
    (await painted(link)).underline,
  );
}

/** One answer pair, Attending chosen: both at the 44px floor, a 2px ring on the chosen one only. */
async function pair(flow: Flow, where: string, within: Locator): Promise<void> {
  const attending = await painted(
    within.getByRole("button", { name: "Attending", exact: true }).first(),
  );
  const declined = await painted(
    within.getByRole("button", { name: "Not attending", exact: true }).first(),
  );
  flow.check(`buttons: ${where}'s chosen Attending wears a 2px ring`, 2, attending.ring);
  flow.check(`buttons: ${where}'s Not attending wears no ring`, 0, declined.ring);
  flow.check(
    `buttons: ${where}'s answers stand at least 44px tall`,
    true,
    attending.height >= 44 && declined.height >= 44,
  );
}

/**
 * The guest RSVP sheet on a phone, with Attending chosen: its close × and its
 * answer pair, measured and shot in `design`.
 */
export async function guestSheet(
  flow: Flow,
  guest: Page,
  sheet: Locator,
  design: "classic" | "gala",
): Promise<void> {
  await guest.setViewportSize(PHONE);
  await guest.emulateMedia({ colorScheme: "light" });
  const close = await painted(sheet.getByRole("button", { name: "Close", exact: true }));
  flow.check(`buttons: ${design} sheet's close box`, "44x44", close.size);
  flow.check(
    `buttons: ${design} sheet's close is a filled disc`,
    true,
    close.fill !== CLEAR && close.radius >= 22,
  );
  await pair(flow, `${design} sheet`, sheet);
  const attending = sheet.getByRole("button", { name: "Attending", exact: true });
  await flow.step(`buttons: shoot the ${design} sheet's answer pair`, () =>
    shoot(guest, `invite-${design}-pair`, PHONE, async () => {
      await attending.evaluate((el) => el.scrollIntoView({ block: "center" }));
      await expect(attending).toBeInViewport();
    }),
  );
}

/** The marketing site's demo sheet on a phone, with Attending chosen for its first guest. */
export async function demoPair(flow: Flow, demo: Locator): Promise<void> {
  await pair(flow, "the demo", demo);
}
