/**
 * Cire: cireweddings.com/privacy holds two notices, one for hosts and one for
 * guests, as tabs a reader can link to, use from the keyboard, print, and read
 * with JavaScript off; and its Guests tab says exactly what the guest site's
 * own notice says.
 *
 * The guest notice is one component in `@cire/ui` that both sites render. The
 * last steps compare its text on the two sites, minus the one part that
 * differs by design: the guest site's button that opens its privacy choices.
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

import type { Page } from "@playwright/test";

import { ORIGINS, SCREENSHOT_DIR } from "../../src/config";
import { expect, test } from "../support/fixtures";

const PRIVACY = `${ORIGINS.cireLanding}/privacy`;
const SHOTS = resolve(SCREENSHOT_DIR, "cire-privacy-notice");

/** The plus-one sentence an organiser's phone or paper reply relies on. */
const HOST_RECORDS_PLUS_ONE =
  "One of your hosts may also record your RSVP and dietary requirements";

/** The guest notice's text, whitespace collapsed, without the part that differs by site. */
async function guestNoticeText(page: Page): Promise<string> {
  return page.locator("[data-guest-notice]").evaluate((root) => {
    const copy = root.cloneNode(true) as HTMLElement;
    for (const node of copy.querySelectorAll("[data-notice-choices]")) node.remove();
    return (copy.textContent ?? "").replace(/\s+/g, " ").trim();
  });
}

test("cire-privacy-notice", async ({ page, browser, flow }) => {
  const tablist = page.getByRole("tablist", { name: "Privacy notices" });
  const hostsTab = page.getByRole("tab", { name: "Hosts", exact: true });
  const guestsTab = page.getByRole("tab", { name: "Guests", exact: true });
  const hostsPanel = page.locator("#hosts");
  const guestsPanel = page.locator("#guests");

  const selected = async (): Promise<string> =>
    `hosts=${await hostsTab.getAttribute("aria-selected")} guests=${await guestsTab.getAttribute("aria-selected")}`;

  await flow.step("open the privacy page with no hash", async () => {
    await page.goto(PRIVACY);
    await expect(tablist).toBeVisible();
    await expect(hostsTab).toHaveAttribute("aria-selected", "true");
    await expect(hostsPanel).toBeVisible();
    await expect(guestsPanel).toBeHidden();
    await expect(page.getByRole("tabpanel", { name: "Hosts" })).toBeVisible();
    flow.check("no hash opens the Hosts tab", "hosts=true guests=false", await selected());
  });

  await flow.step("choose the Guests tab", async () => {
    await guestsTab.click();
    await expect(guestsPanel).toBeVisible();
    await expect(hostsPanel).toBeHidden();
    await expect(page).toHaveURL(`${PRIVACY}#guests`);
    flow.check("a click selects Guests", "hosts=false guests=true", await selected());
    flow.check("a click puts #guests in the address", "#guests", new URL(page.url()).hash);
  });

  await flow.step("move between the tabs from the keyboard", async () => {
    await expect(guestsTab).toBeFocused();
    await page.keyboard.press("ArrowLeft");
    await expect(hostsTab).toBeFocused();
    flow.check("ArrowLeft selects Hosts", "hosts=true guests=false", await selected());
    await expect(hostsPanel).toBeVisible();
    await page.keyboard.press("ArrowLeft");
    await expect(guestsTab).toBeFocused();
    flow.check("ArrowLeft wraps to Guests", "hosts=false guests=true", await selected());
    await page.keyboard.press("Home");
    await expect(hostsTab).toBeFocused();
    flow.check("Home selects Hosts", "hosts=true guests=false", await selected());
    await page.keyboard.press("End");
    await expect(guestsTab).toBeFocused();
    flow.check("End selects Guests", "hosts=false guests=true", await selected());
    await page.keyboard.press("ArrowRight");
    await expect(hostsTab).toBeFocused();
    flow.check("ArrowRight wraps to Hosts", "hosts=true guests=false", await selected());
    flow.check("the keyboard keeps the address in step", "#hosts", new URL(page.url()).hash);
    flow.check(
      "only the selected tab is in the tab order",
      "0 -1",
      [await hostsTab.getAttribute("tabindex"), await guestsTab.getAttribute("tabindex")].join(" "),
    );
  });

  await flow.step("open the page at #guests", async () => {
    await page.goto("about:blank");
    await page.goto(`${PRIVACY}#guests`);
    await expect(guestsPanel).toBeVisible();
    await expect(hostsPanel).toBeHidden();
    flow.check("#guests opens the Guests tab", "hosts=false guests=true", await selected());
    flow.check(
      "arriving at #guests leaves focus where the page starts",
      "BODY",
      await page.evaluate(() => document.activeElement?.tagName ?? ""),
    );
    await page.getByRole("tab", { name: "Guests", exact: true }).focus();
    await page.keyboard.press("Tab");
    flow.check(
      "Tab from the selected tab moves into its panel",
      "tabpanel Guests",
      await page.evaluate(() => {
        const active = document.activeElement;
        const by = active?.getAttribute("aria-labelledby");
        const label = by ? document.getElementById(by)?.getAttribute("aria-labelledby") : null;
        const name = label ? document.getElementById(label)?.textContent?.trim() : "";
        return `${active?.getAttribute("role") ?? ""} ${name ?? ""}`;
      }),
    );
  });

  await flow.step("follow links to #hosts and back to #guests", async () => {
    await page.evaluate(() => {
      window.location.hash = "hosts";
    });
    await expect(hostsPanel).toBeVisible();
    flow.check("a link to #hosts selects Hosts", "hosts=true guests=false", await selected());
    await page.evaluate(() => {
      window.location.hash = "guests";
    });
    await expect(guestsPanel).toBeVisible();
    flow.check("a link to #guests selects Guests", "hosts=false guests=true", await selected());
  });

  await flow.step("print the Guests tab", async () => {
    await page.emulateMedia({ media: "print" });
    await expect(tablist).toBeHidden();
    await expect(guestsPanel).toBeVisible();
    await expect(hostsPanel).toBeHidden();
    const heading = guestsPanel.getByRole("heading", { name: "For guests", level: 2 });
    flow.check("print leaves out the tab list", false, await tablist.isVisible());
    flow.check("print carries the Guests notice", true, await guestsPanel.isVisible());
    flow.check("print leaves out the Hosts notice", false, await hostsPanel.isVisible());
    // On screen the heading is visually hidden to a 1px box, which still
    // counts as visible; on paper it is drawn at full size.
    const printed = (await heading.boundingBox())?.height ?? 0;
    flow.check("print shows the notice's own heading", true, printed > 16);
    await page.emulateMedia({ media: "screen" });
    const onScreen = (await heading.boundingBox())?.height ?? 0;
    flow.check("on screen the tab names the panel, not a heading", true, onScreen <= 1);
  });

  await flow.step("read the page with JavaScript off", async () => {
    const context = await browser.newContext({ javaScriptEnabled: false });
    const noScript = await context.newPage();
    await noScript.goto(`${PRIVACY}#guests`);
    await expect(noScript.locator("#hosts")).toBeVisible();
    await expect(noScript.locator("#guests")).toBeVisible();
    await expect(noScript.getByRole("tablist")).toHaveCount(0);
    await expect(noScript.getByRole("link", { name: "Hosts", exact: true })).toHaveAttribute(
      "href",
      "#hosts",
    );
    const text = (await noScript.locator("main").textContent()) ?? "";
    flow.check(
      "no-JS page carries the hosts notice",
      true,
      text.includes("Two kinds of people use Cire"),
    );
    flow.check(
      "no-JS page carries the plus-one section",
      true,
      text.includes("If a guest is bringing you"),
    );
    await noScript.emulateMedia({ media: "print" });
    await expect(noScript.locator("#hosts")).toBeVisible();
    await expect(noScript.locator("#guests")).toBeVisible();
    flow.check(
      "no-JS print carries both notices",
      "hosts=true guests=true",
      `hosts=${await noScript.locator("#hosts").isVisible()} guests=${await noScript.locator("#guests").isVisible()}`,
    );
    await context.close();
  });

  await flow.step("compare the Guests tab with the guest site's notice", async () => {
    await page.goto(`${PRIVACY}#guests`);
    const landing = await guestNoticeText(page);
    const invites = await page.context().newPage();
    await invites.goto(`${ORIGINS.cireInvites}/privacy`);
    await expect(invites.locator("[data-guest-notice]")).toBeVisible();
    const guestSite = await guestNoticeText(invites);
    await expect(invites.getByRole("button", { name: "Open my privacy choices" })).toBeVisible();
    await invites.close();
    flow.check("the guest notice is the same text on both sites", true, landing === guestSite);
    flow.check(
      "cireweddings.com names a host recording a plus-one",
      true,
      landing.includes(HOST_RECORDS_PLUS_ONE),
    );
    flow.check(
      "the guest site names a host recording a plus-one",
      true,
      guestSite.includes(HOST_RECORDS_PLUS_ONE),
    );
  });

  await flow.step("screenshot both tabs at phone and desktop width, light and dark", async () => {
    mkdirSync(SHOTS, { recursive: true });
    for (const tab of ["hosts", "guests"] as const) {
      for (const width of [390, 1280]) {
        for (const colorScheme of ["light", "dark"] as const) {
          await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
          await page.emulateMedia({ colorScheme });
          await page.goto("about:blank");
          await page.goto(`${PRIVACY}#${tab}`);
          await expect(page.locator(`#${tab}`)).toBeVisible();
          // `astro dev` draws its own toolbar over the page; it is not the page.
          await page.addStyleTag({ content: "astro-dev-toolbar { display: none !important; }" });
          await page.screenshot({
            path: resolve(SHOTS, `${tab}-${width}-${colorScheme}.png`),
            fullPage: true,
            animations: "disabled",
          });
        }
      }
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto(`${PRIVACY}#guests`);
    await expect(guestsPanel).toBeVisible();
  });
});
