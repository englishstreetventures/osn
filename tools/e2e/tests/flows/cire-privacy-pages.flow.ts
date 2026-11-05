/**
 * Cire: cireweddings.com/privacy is a common page that links to three
 * notices, each its own page — `/privacy/hosts`, `/privacy/guests` and
 * `/privacy/vendors` — through one row of links that marks the current page.
 * The pages need no JavaScript and each prints on its own.
 *
 * The guest notice is one component in `@cire/ui` that both sites render. A
 * step compares its text on the two sites, minus the one part that differs by
 * design: the guest site's button that opens its privacy choices.
 *
 * Every legal page on both sites, the guest site's `/privacy` and `/terms` and
 * the marketing site's `/privacy`, `/terms` and `/refunds`, is `@cire/ui`'s
 * legal layout ending on `@cire/ui`'s footer. A step per page reads the tab's
 * title, the marketing site's line back home, the footer's legal links in
 * order, the version line and, on the guest site, the privacy-choices control
 * in the legal row; it checks the marketing sign-off is italic, that a tap
 * 18px above a link's centre still lands on it (the 44px hit area), and that
 * every word in the footer reads at 4.5:1 on the page — the links, the
 * version, the guest site's control, and the marketing site's sign-off,
 * tagline, section row and small print; and it shoots the top of the page and
 * the footer at 390 and 1280px. The guest footer's sign-off, which only an
 * invitation draws, is measured on every palette by the guest site's
 * `GuestFooter` browser test.
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

import type { Locator, Page } from "@playwright/test";

import { ORIGINS, SCREENSHOT_DIR } from "../../src/config";
import { inkRatio } from "../support/cire-buttons";
import { expect, type Flow, test } from "../support/fixtures";

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

/** WCAG 2's minimum contrast for body text. */
const TEXT_MIN = 4.5;

/** The legal pages each site serves, and the tab title each shows. */
const LEGAL_PAGES = [
  {
    site: "guest",
    origin: ORIGINS.cireInvites,
    path: "/privacy",
    title: "Privacy Notice",
    links: "Privacy notice /privacy/ | Terms /terms/",
  },
  {
    site: "guest",
    origin: ORIGINS.cireInvites,
    path: "/terms",
    title: "Terms of Use",
    links: "Privacy notice /privacy/ | Terms /terms/",
  },
  {
    site: "marketing",
    origin: ORIGINS.cireLanding,
    path: "/privacy",
    title: "Privacy — Cire",
    links: "Privacy notice /privacy/ | Terms /terms/ | Refunds /refunds/",
  },
  {
    site: "marketing",
    origin: ORIGINS.cireLanding,
    path: "/terms",
    title: "Terms of Service — Cire",
    links: "Privacy notice /privacy/ | Terms /terms/ | Refunds /refunds/",
  },
  {
    site: "marketing",
    origin: ORIGINS.cireLanding,
    path: "/refunds",
    title: "Refund Policy — Cire",
    links: "Privacy notice /privacy/ | Terms /terms/ | Refunds /refunds/",
  },
] as const;

/** What a tap `above` px over `target`'s centre lands on: "the link", or what it hit instead. */
function hitAbove(target: Locator, above: number): Promise<string> {
  return target.evaluate((el, dy) => {
    el.scrollIntoView({ block: "center", behavior: "instant" });
    const rect = el.getBoundingClientRect();
    const hit = document.elementFromPoint(
      rect.left + rect.width / 2,
      rect.top + rect.height / 2 - dy,
    );
    if (hit === el) return "the link";
    if (!hit) return "nothing";
    return `${hit.tagName.toLowerCase()}.${hit.className} "${(hit.textContent ?? "").trim().slice(0, 30)}"`;
  }, above);
}

/** The checks one legal page's frame and footer must pass, then its screenshots. */
async function legalPage(flow: Flow, page: Page, target: (typeof LEGAL_PAGES)[number]) {
  const name = `${target.site} ${target.path}`;
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${target.origin}${target.path}`);
  await expect(page.locator("footer.site-footer")).toBeVisible();
  // `astro dev` draws its own toolbar over the page; it is not the page.
  await page.addStyleTag({ content: "astro-dev-toolbar { display: none !important; }" });
  const footer = page.locator("footer.site-footer");
  const legal = footer.locator('nav[aria-label="Legal"]');

  flow.check(`${name}: the tab's title`, target.title, await page.title());
  flow.check(
    `${name}: the footer's legal links, in order`,
    target.links,
    (
      await legal
        .locator("a")
        .evaluateAll((links) =>
          links.map((a) => `${(a.textContent ?? "").trim()} ${a.getAttribute("href") ?? ""}`),
        )
    ).join(" | "),
  );
  const version = footer.locator(".version");
  // A local dev server is built from no commit.
  flow.check(
    `${name}: the footer prints the build's version`,
    "Version local",
    ((await version.textContent()) ?? "").trim(),
  );

  const words = [...(await legal.locator("a").all()), version];
  if (target.site === "guest") {
    // The standing control, inside the legal row, after the links.
    const choices = legal.getByRole("button", { name: "Privacy choices" });
    await expect(choices).toBeVisible({ timeout: 60_000 });
    flow.check(
      `${name}: the privacy-choices control is in the legal row`,
      1,
      await choices.count(),
    );
    flow.check(
      `${name}: the privacy-choices control carries the footer's class`,
      true,
      await choices.evaluate((el) => el.classList.contains("consent-link")),
    );
    words.push(choices);
  } else {
    const back = page.locator("main .legal-back a");
    flow.check(
      `${name}: the line back to the home page`,
      "← Back to Cire /",
      `${((await back.textContent()) ?? "").trim()} ${(await back.getAttribute("href")) ?? ""}`,
    );
    flow.check(
      `${name}: the sign-off is the italic logotype`,
      "Cire italic",
      await footer
        .locator(".signoff")
        .evaluate((el) => `${(el.textContent ?? "").trim()} ${getComputedStyle(el).fontStyle}`),
    );
    // The rest of the marketing footer's words: the sign-off and its tagline,
    // the section row and the small print.
    words.push(
      footer.locator(".signoff"),
      footer.locator(".tagline"),
      ...(await footer.locator('nav[aria-label="Sections"] a').all()),
      footer.locator(".small-print"),
    );
  }

  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    flow.check(
      `${name} at ${width}px: a tap 18px above a footer link's centre lands on it`,
      "the link",
      await hitAbove(legal.locator("a").first(), 18),
    );
  }

  const short: string[] = [];
  for (const word of words) {
    const ratio = await inkRatio(word);
    if (ratio < TEXT_MIN) short.push(`${(await word.textContent())?.trim()}: ${ratio.toFixed(2)}`);
  }
  flow.check(`${name}: every word in the footer reads at 4.5:1`, "", short.join(", "));

  mkdirSync(SHOTS, { recursive: true });
  const file = `${target.site}${target.path.replaceAll("/", "-")}`;
  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
    await page.screenshot({
      path: resolve(SHOTS, `${file}-${width}-top.png`),
      animations: "disabled",
    });
    await footer.screenshot({
      path: resolve(SHOTS, `${file}-${width}-footer.png`),
      animations: "disabled",
    });
  }
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
      "/privacy/ /privacy/hosts/ /privacy/guests/ /privacy/vendors/",
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
      await expect(page).toHaveURL(`${ORIGINS.cireLanding}${target.path}/`);
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
    // The page is still /privacy/vendors. Headings, not text: the section's
    // title is also the link text in the page's retention paragraph.
    flow.check(
      "the vendors' notice has a section on the vendor's own account",
      1,
      await page
        .getByRole("heading", { name: "Your vendor account", level: 2, exact: true })
        .count(),
    );
    flow.check(
      "the vendor account section has its four parts, in order",
      "What it holds | Why we keep it | Who sees it | How long we keep it",
      (await page.getByRole("heading", { level: 3 }).allTextContents())
        .map((text) => text.trim())
        .join(" | "),
    );
    flow.check(
      "the vendor account section keeps the id the retention paragraph links to",
      1,
      await page.locator("#your-vendor-account").count(),
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
    // The button is SSR markup until its island hydrates, and a click before
    // that does nothing.
    await expect(invites.locator("astro-island[ssr]")).toHaveCount(0, { timeout: 60_000 });
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

  await flow.step("answer the guest site's consent banner", async () => {
    // On a legal page the prompt is a banner at the foot of the window; answered,
    // it leaves the footer below it for the checks that follow.
    await page.goto(`${ORIGINS.cireInvites}/privacy`);
    const banner = page.getByRole("region", { name: "Privacy choices" });
    await expect(banner).toBeVisible({ timeout: 60_000 });
    await banner.getByRole("button", { name: "Reject all" }).click();
    await expect(banner).toBeHidden();
  });

  for (const target of LEGAL_PAGES) {
    await flow.step(`read the ${target.site} site's ${target.path} frame and footer`, async () => {
      await legalPage(flow, page, target);
    });
  }

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
