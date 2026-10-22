/**
 * Cire: the invite's top and bottom edge strips, on the real invite page
 * (issue #1700).
 *
 * A device with a notch reports a safe-area inset; Chromium does not, so the
 * flow sets one through CDP (`Emulation.setSafeAreaInsetsOverride`) before the
 * page loads. The probe reads that inset, the classes are set, the strips take
 * their heights, and the first-paint colours come from the server. Rotating the
 * phone changes the insets and the viewport without a reload. A second context
 * with no inset checks the regression: no strips, no classes.
 *
 * The flow makes no guest claim. It opens the seeded household's invitation
 * and only reads it.
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

import type { BrowserContext, Page } from "@playwright/test";

import { CIRE_GIFT_LIST, CIRE_HOUSEHOLD, ORIGINS, SCREENSHOT_DIR } from "../../src/config";
import { expect, test } from "../support/fixtures";

const SHOTS = resolve(SCREENSHOT_DIR, "cire-invite-edges");
const INVITE = `${ORIGINS.cireInvites}/${CIRE_HOUSEHOLD.slug}`;
const VIEWPORT_META =
  'name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover"';

/** A phone with a notch: a status bar inset at the top and a home indicator at the bottom. */
const PHONE = { width: 390, height: 844 };
const NOTCH = { top: 47, bottom: 34, left: 0, right: 0 };

/** Landscape with side insets, for the body padding. */
const LANDSCAPE = { width: 844, height: 390 };
const SIDES = { top: 0, bottom: 21, left: 47, right: 47 };

const HEX = /^#[0-9a-f]{6}$/;

async function setInsets(page: Page, insets: typeof NOTCH) {
  const session = await page.context().newCDPSession(page);
  // All four sides every time: the protocol treats an omitted side as undefined.
  await session.send("Emulation.setSafeAreaInsetsOverride", { insets });
}

/** Let the browser run the resize listeners and the edge loop's frame. */
async function settle(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))),
  );
}

/** Answer the first-visit consent prompt, which idle-hydrates after the page is up. */
async function rejectConsent(page: Page) {
  const prompt = page.getByRole("dialog", { name: "Privacy choices" });
  await expect(prompt).toBeVisible({ timeout: 60_000 });
  await prompt.getByRole("button", { name: "Reject all" }).click();
  await expect(prompt).toBeHidden();
}

async function openInvite(page: Page) {
  await page.goto(INVITE);
  await expect(page.getByLabel("Invitation code")).toBeVisible();
  await rejectConsent(page);
}

async function stripMetrics(page: Page) {
  return page.evaluate(() => {
    const read = (sel: string) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const cs = getComputedStyle(el);
      return {
        display: cs.display,
        position: cs.position,
        pointerEvents: cs.pointerEvents,
        height: Math.round(parseFloat(cs.height)),
      };
    };
    return {
      classes: [...document.documentElement.classList].toSorted().join(" "),
      top: read(".edge-top"),
      bottom: read(".edge-bottom"),
      topVar: document.documentElement.style.getPropertyValue("--edge-top-bg"),
      bottomVar: document.documentElement.style.getPropertyValue("--edge-bottom-bg"),
      themeColor:
        document.querySelector('meta[name="theme-color"]')?.getAttribute("content") ?? null,
      scrollPaddingTop: getComputedStyle(document.documentElement).scrollPaddingTop,
      bodyPaddingLeft: getComputedStyle(document.body).paddingLeft,
      bodyPaddingRight: getComputedStyle(document.body).paddingRight,
    };
  });
}

test("cire-invite-edges", async ({ page, browser, flow }) => {
  mkdirSync(SHOTS, { recursive: true });

  await flow.step(
    "the served pages carry viewport-fit=cover only where the edge strips are",
    async () => {
      const served = async (url: string) => await (await page.request.get(url)).text();
      const invite = await served(INVITE);
      flow.check("invite page has viewport-fit=cover", true, invite.includes(VIEWPORT_META));
      flow.check(
        "invite page first paint carries both edge colours",
        true,
        /--edge-top-bg:#[0-9a-f]{6};--edge-bottom-bg:#[0-9a-f]{6}/.test(invite),
      );
      flow.check(
        "invite page theme-color is a hex value",
        true,
        /<meta name="theme-color" content="#[0-9a-f]{6}"/.test(invite),
      );
      flow.check(
        "invite page renders both strip elements",
        true,
        invite.includes("edge-strip edge-bottom"),
      );

      const gift = await served(`${ORIGINS.cireInvites}/${CIRE_GIFT_LIST.slug}/registry`);
      flow.check(
        "gift-registry page has no viewport-fit=cover",
        false,
        gift.includes("viewport-fit=cover"),
      );
      const missing = await served(`${ORIGINS.cireInvites}/no-such-wedding-for-edges`);
      flow.check(
        "not-found page has no viewport-fit=cover",
        false,
        missing.includes("viewport-fit=cover"),
      );
      const legal = await served(`${ORIGINS.cireInvites}/privacy`);
      flow.check(
        "legal page has no viewport-fit=cover",
        false,
        legal.includes("viewport-fit=cover"),
      );
    },
  );

  await flow.step("a notched phone gets both strips at the inset height", async () => {
    await page.setViewportSize(PHONE);
    await setInsets(page, NOTCH);
    await openInvite(page);
    const m = await stripMetrics(page);
    flow.check("classes on a notched phone", "has-safe-bottom has-safe-top", m.classes);
    flow.check("top strip display", "block", m.top?.display ?? "missing");
    flow.check("top strip position", "fixed", m.top?.position ?? "missing");
    flow.check("top strip ignores taps", "none", m.top?.pointerEvents ?? "missing");
    flow.check("top strip height", 47, m.top?.height ?? -1);
    flow.check("bottom strip display", "block", m.bottom?.display ?? "missing");
    flow.check("bottom strip position", "fixed", m.bottom?.position ?? "missing");
    flow.check("bottom strip ignores taps", "none", m.bottom?.pointerEvents ?? "missing");
    flow.check("bottom strip height", 34, m.bottom?.height ?? -1);
    flow.check("top colour is a hex value", true, HEX.test(m.topVar));
    flow.check("bottom colour is a hex value", true, HEX.test(m.bottomVar));
    flow.check("theme-color matches the top colour", m.topVar, m.themeColor ?? "missing");
    flow.check("anchors scroll below the top strip", "47px", m.scrollPaddingTop);
    await page.screenshot({ path: resolve(SHOTS, "phone-top.png") });
  });

  await flow.step("rotating a notched phone updates the strips without a reload", async () => {
    await setInsets(page, SIDES);
    await page.setViewportSize(LANDSCAPE);
    await settle(page);
    const m = await stripMetrics(page);
    flow.check(
      "top edge has no inset when held sideways",
      false,
      m.classes.includes("has-safe-top"),
    );
    flow.check(
      "bottom edge keeps its inset when held sideways",
      true,
      m.classes.includes("has-safe-bottom"),
    );
    flow.check("body keeps its left side inset", "47px", m.bodyPaddingLeft);
    flow.check("body keeps its right side inset", "47px", m.bodyPaddingRight);
    await page.screenshot({ path: resolve(SHOTS, "landscape.png") });
  });

  await flow.step("a phone with no inset gets no strips and no classes", async () => {
    const context: BrowserContext = await browser.newContext({ viewport: PHONE, hasTouch: true });
    try {
      const plain = await context.newPage();
      await openInvite(plain);
      const m = await stripMetrics(plain);
      flow.check("no classes without an inset", "", m.classes);
      flow.check("top strip hidden without an inset", "none", m.top?.display ?? "missing");
      flow.check("bottom strip hidden without an inset", "none", m.bottom?.display ?? "missing");
      flow.check("no scroll padding without an inset", "auto", m.scrollPaddingTop);
    } finally {
      await context.close();
    }
  });
});
