/**
 * Cire: cireweddings.com/privacy is a common page that links to three
 * notices, each its own page — `/privacy/hosts`, `/privacy/guests` and
 * `/privacy/vendors` — through one row of links that marks the current page.
 * The pages need no JavaScript and each prints on its own.
 *
 * The guest notice is one component in `@cire/ui` that both sites render. A
 * step compares its text on the two sites, minus the one part that differs by
 * design: the guest site's button that opens its privacy choices.
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

import type { Page } from "@playwright/test";

import { ORIGINS, SCREENSHOT_DIR } from "../../src/config";
import { expect, test } from "../support/fixtures";

const PRIVACY = `${ORIGINS.cireLanding}/privacy`;
const SHOTS = resolve(SCREENSHOT_DIR, "cire-privacy-pages");

/** The four pages, in the order the row of links lists them. */
const PAGES = [
  { id: "overview", label: "Overview", path: "/privacy", heading: "Privacy at Cire" },
  { id: "hosts", label: "Hosts", path: "/privacy/hosts", heading: "Privacy Notice for Hosts" },
  { id: "guests", label: "Guests", path: "/privacy/guests", heading: "Privacy Notice for Guests" },
  {
    id: "vendors",
    label: "Vendors",
    path: "/privacy/vendors",
    heading: "Privacy Notice for Vendors",
  },
] as const;

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

/** Which link in the row is marked current, by label; empty when none is. */
async function currentLink(page: Page): Promise<string> {
  const nav = page.getByRole("navigation", { name: "Privacy notices" });
  const marked = nav.locator('a[aria-current="page"]');
  return (await marked.count()) === 1 ? ((await marked.textContent()) ?? "").trim() : "";
}

/** The main text of the page, whitespace collapsed. */
async function mainText(page: Page): Promise<string> {
  return ((await page.locator("main").textContent()) ?? "").replace(/\s+/g, " ");
}

test("cire-privacy-pages", async ({ page, browser, flow }) => {
  const nav = page.getByRole("navigation", { name: "Privacy notices" });

  await flow.step("open the common privacy page", async () => {
    await page.goto(PRIVACY);
    await expect(page.getByRole("heading", { name: "Privacy at Cire", level: 1 })).toBeVisible();
    flow.check(
      "the row of links names all four pages",
      "Overview Hosts Guests Vendors",
      (await nav.getByRole("link").allTextContents()).map((text) => text.trim()).join(" "),
    );
    flow.check(
      "the row of links points at each page",
      "/privacy /privacy/hosts /privacy/guests /privacy/vendors",
      (
        await nav
          .getByRole("link")
          .evaluateAll((links) => links.map((link) => link.getAttribute("href") ?? ""))
      ).join(" "),
    );
    flow.check("/privacy marks Overview as the current page", "Overview", await currentLink(page));
    const text = await mainText(page);
    flow.check(
      "/privacy links to the hosts' notice",
      true,
      text.includes("couples, co-hosts and organisers"),
    );
  });

  for (const target of PAGES.slice(1)) {
    await flow.step(`follow the ${target.label} link`, async () => {
      await nav.getByRole("link", { name: target.label, exact: true }).click();
      await expect(page).toHaveURL(`${ORIGINS.cireLanding}${target.path}`);
      await expect(page.getByRole("heading", { name: target.heading, level: 1 })).toBeVisible();
      flow.check(
        `${target.path} marks ${target.label} as the current page`,
        target.label,
        await currentLink(page),
      );
    });
  }

  await flow.step("tell the hosts' and the vendors' notices apart", async () => {
    await page.goto(`${PRIVACY}/hosts`);
    const hosts = await mainText(page);
    await page.goto(`${PRIVACY}/vendors`);
    const vendors = await mainText(page);
    flow.check(
      "the hosts' notice covers organiser accounts",
      true,
      hosts.includes("Organiser accounts"),
    );
    flow.check(
      "the hosts' notice leaves vendor listings to the vendors' notice",
      false,
      hosts.includes("the contact details on your directory listing"),
    );
    flow.check(
      "the vendors' notice covers directory listings",
      true,
      vendors.includes("the contact details on your directory listing"),
    );
    flow.check(
      "the vendors' notice leaves organiser records to the hosts' notice",
      false,
      vendors.includes("Which organiser changed a guest"),
    );
    flow.check(
      "the vendors' notice describes the vendor's own account",
      true,
      vendors.includes("Your vendor account"),
    );
  });

  await flow.step("compare the guests' page with the guest site's notice", async () => {
    await page.goto(`${PRIVACY}/guests`);
    const landing = await guestNoticeText(page);
    flow.check(
      "the notice's sections are level 2 on cireweddings.com",
      1,
      await page.getByRole("heading", { name: "Who decides what", level: 2 }).count(),
    );
    const choices = page.locator("[data-notice-choices]");
    flow.check(
      "cireweddings.com points at the invitation's footer",
      true,
      ((await choices.textContent()) ?? "")
        .replace(/\s+/g, " ")
        .includes("footer of every page of the site."),
    );
    flow.check(
      "cireweddings.com shows no privacy-choices button",
      0,
      await choices.getByRole("button").count(),
    );

    const invites = await page.context().newPage();
    await invites.goto(`${ORIGINS.cireInvites}/privacy`);
    await expect(invites.locator("[data-guest-notice]")).toBeVisible();
    const guestSite = await guestNoticeText(invites);
    flow.check(
      "the notice's sections are level 2 on the guest site",
      1,
      await invites.getByRole("heading", { name: "Who decides what", level: 2 }).count(),
    );
    // The button is a hydrated island passed through the notice's slot.
    await invites.getByRole("button", { name: "Open my privacy choices" }).click();
    const sheet = invites.getByRole("dialog", { name: "Your privacy choices" });
    await expect(sheet).toBeVisible();
    flow.check("the guest site's button opens the privacy choices", true, await sheet.isVisible());
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

  await flow.step("print the guests' page", async () => {
    await page.emulateMedia({ media: "print" });
    flow.check("print leaves out the row of links", false, await nav.isVisible());
    flow.check(
      "print carries the notice",
      true,
      await page.locator("[data-guest-notice]").isVisible(),
    );
    await page.emulateMedia({ media: "screen" });
  });

  await flow.step("read the pages with JavaScript off", async () => {
    const context = await browser.newContext({ javaScriptEnabled: false });
    const noScript = await context.newPage();
    for (const target of PAGES) {
      await noScript.goto(`${ORIGINS.cireLanding}${target.path}`);
      await expect(noScript.getByRole("heading", { name: target.heading, level: 1 })).toBeVisible();
      flow.check(
        `with JavaScript off ${target.path} marks ${target.label}`,
        target.label,
        await currentLink(noScript),
      );
    }
    await context.close();
  });

  await flow.step("screenshot every page at phone and desktop width, light and dark", async () => {
    mkdirSync(SHOTS, { recursive: true });
    // One arrival per page; the width and the colour scheme change on the live
    // page. The last shot, the guests' page at 1280 px in light, is the flow's
    // final state.
    for (const target of [PAGES[0], PAGES[1], PAGES[3], PAGES[2]]) {
      await page.goto(`${ORIGINS.cireLanding}${target.path}`);
      await expect(page.getByRole("heading", { name: target.heading, level: 1 })).toBeVisible();
      // `astro dev` draws its own toolbar over the page; it is not the page.
      await page.addStyleTag({ content: "astro-dev-toolbar { display: none !important; }" });
      for (const width of [390, 1280]) {
        for (const colorScheme of ["dark", "light"] as const) {
          await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
          await page.emulateMedia({ colorScheme });
          await page.screenshot({
            path: resolve(SHOTS, `${target.id}-${width}-${colorScheme}.png`),
            fullPage: true,
            animations: "disabled",
          });
        }
      }
    }
  });
});
