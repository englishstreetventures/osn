/**
 * Cire: the invite's top and bottom edge strips, on the real invite page
 * (issue #1700).
 *
 * A device with a notch reports a safe-area inset; Chromium does not, so the
 * flow sets one through CDP (`Emulation.setSafeAreaInsetsOverride`) before the
 * page loads. The probe reads that inset, the classes are set, the strips take
 * their heights, and the first-paint colours come from the server. A second
 * context with no inset checks the regression: no strips, no classes.
 *
 * The flow makes no guest claim. It opens the seeded household's invitation
 * and only reads it.
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

import type { BrowserContext, Page } from "@playwright/test";

import { CIRE_HOUSEHOLD, ORIGINS, SCREENSHOT_DIR } from "../../src/config";
import { expect, test } from "../support/fixtures";

const SHOTS = resolve(SCREENSHOT_DIR, "cire-invite-edges");
const INVITE = `${ORIGINS.cireInvites}/${CIRE_HOUSEHOLD.slug}`;

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
        zIndex: cs.zIndex,
      };
    };
    return {
      classes: [...document.documentElement.classList],
      top: read(".edge-top"),
      bottom: read(".edge-bottom"),
      topVar: document.documentElement.style.getPropertyValue("--edge-top-bg"),
      bottomVar: document.documentElement.style.getPropertyValue("--edge-bottom-bg"),
      themeColor:
        document.querySelector('meta[name="theme-color"]')?.getAttribute("content") ?? null,
    };
  });
}

test("cire-invite-edges", async ({ page, browser, flow }) => {
  mkdirSync(SHOTS, { recursive: true });

  await flow.step("the server renders the edge colours into the first paint", async () => {
    const response = await page.request.get(INVITE);
    const html = await response.text();
    expect(html).toContain(
      'name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover"',
    );
    expect(html).toMatch(/--edge-top-bg:#[0-9a-f]{6};--edge-bottom-bg:#[0-9a-f]{6}/);
    expect(html).toMatch(/<meta name="theme-color" content="#[0-9a-f]{6}"/);
    expect(html).toContain('class="edge-strip edge-top');
    expect(html).toContain('class="edge-strip edge-bottom');
  });

  await flow.step("a notched phone gets both strips at the inset height", async () => {
    await page.setViewportSize(PHONE);
    await setInsets(page, NOTCH);
    await openInvite(page);
    const m = await stripMetrics(page);
    expect(m.classes).toEqual(expect.arrayContaining(["has-safe-top", "has-safe-bottom"]));
    expect(m.top).toMatchObject({
      display: "block",
      position: "fixed",
      pointerEvents: "none",
      height: 47,
    });
    expect(m.bottom).toMatchObject({
      display: "block",
      position: "fixed",
      pointerEvents: "none",
      height: 34,
    });
    expect(m.topVar).toMatch(HEX);
    expect(m.bottomVar).toMatch(HEX);
    expect(m.themeColor).toBe(m.topVar);
    await page.screenshot({ path: resolve(SHOTS, "phone-top.png") });
  });

  await flow.step("the body keeps its side insets on a notched phone held sideways", async () => {
    await page.setViewportSize(LANDSCAPE);
    await setInsets(page, SIDES);
    // The answer from the first load is kept, so the prompt does not come back.
    await page.reload();
    await expect(page.getByLabel("Invitation code")).toBeVisible();
    const padding = await page.evaluate(() => {
      const cs = getComputedStyle(document.body);
      return { left: cs.paddingLeft, right: cs.paddingRight };
    });
    expect(padding).toEqual({ left: "47px", right: "47px" });
    await page.screenshot({ path: resolve(SHOTS, "landscape.png") });
  });

  await flow.step("a phone with no inset gets no strips and no classes", async () => {
    const context: BrowserContext = await browser.newContext({ viewport: PHONE, hasTouch: true });
    try {
      const plain = await context.newPage();
      await openInvite(plain);
      const m = await stripMetrics(plain);
      expect(m.classes).not.toContain("has-safe-top");
      expect(m.classes).not.toContain("has-safe-bottom");
      expect(m.top?.display).toBe("none");
      expect(m.bottom?.display).toBe("none");
    } finally {
      await context.close();
    }
  });
});
