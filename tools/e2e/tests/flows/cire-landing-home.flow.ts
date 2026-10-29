/**
 * Cire: the home page at cireweddings.com, read as a couple deciding whether
 * to start.
 *
 * The hero is a fan of phones whose middle one is a finished invitation, and
 * four chips under it switch that phone between sealed, opened, the RSVP and
 * the day itself. The chips are radios, so they switch with JavaScript off.
 * Below it: the working no-op RSVP demo, the guest-and-organiser journey in
 * five tabs (radios again), the three plans with their prices and guest caps,
 * and a closing field that previews the couple's link and carries their names
 * to the organiser portal.
 *
 * The flow never loads the portal: the portal calls cire-api as it loads, and
 * those lines would land in results.json in a different order on each run. It
 * checks every organiser link's href instead, and follows the claim link once,
 * into a page the flow itself serves at the portal's address. The portal's
 * half, the form opening with the names, is `cire-checklist-starter`'s.
 *
 * The stack starts the landing site with no `PUBLIC_DEMO_INVITE_URL`, so "See
 * a live invite" is the in-page anchor. A developer's own `cire/landing/.env`
 * can set it, and then the first step fails locally and nowhere else.
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

import type { Locator, Page, Route } from "@playwright/test";

import { ORIGINS, SCREENSHOT_DIR } from "../../src/config";
import { expect, test } from "../support/fixtures";

const HOME = `${ORIGINS.cireLanding}/`;
const SHOTS = resolve(SCREENSHOT_DIR, "cire-landing-home");
const PORTAL = ORIGINS.cireHost;

/**
 * The hero's four states, in the order the chips list them, and the caption a
 * screen reader hears for each: the phones are hidden from assistive
 * technology, so the figure's name is all it says of the invitation.
 */
const HERO_STATES = [
  {
    id: "sealed",
    label: "Sealed",
    caption:
      "Sealed: the invitation as a guest first sees it, with the couple’s names, the date and a field for their household’s code.",
  },
  {
    id: "opened",
    label: "Opened",
    caption: "Opened: the couple’s words, the date, and the ceremony and reception to reply to.",
  },
  {
    id: "rsvp",
    label: "RSVP",
    caption: "The reply: each person in the household answers for each event, with dietary notes.",
  },
  {
    id: "on-the-day",
    label: "On the day",
    caption: "On the day: the timings, the dress code and the way to the venue.",
  },
] as const;

/** The three plans' ids, in the order the pricing section shows them. */
const PLAN_IDS = ["ivory", "gold", "crimson"] as const;

/** The craft section's photograph, by its alt text. */
const CRAFT_PHOTO = "A beautifully laid place setting with a handwritten name card";

/** The journey's five tabs, the heading of each panel, and the plan it needs. */
const JOURNEY = [
  { id: "invite", label: "Invite", heading: "An invitation in your colours.", gold: false },
  { id: "rsvp", label: "RSVP", heading: "Every reply, counted as it lands.", gold: false },
  { id: "seating", label: "Seating", heading: "Seat everyone who said yes.", gold: true },
  { id: "on-the-day", label: "On the day", heading: "Run the day from one sheet.", gold: true },
  { id: "gifts", label: "Gifts", heading: "A gift list nobody doubles up on.", gold: true },
] as const;

/** The section ids the page is built from, top to bottom. */
const SECTIONS = ["hero", "see-it-live", "journey", "pricing", "faq", "cta"] as const;

/** Every text node on the page, hidden states included, without scripts and styles. */
async function allText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) =>
        node.parentElement?.closest("script, style, template, astro-dev-toolbar")
          ? NodeFilter.FILTER_REJECT
          : NodeFilter.FILTER_ACCEPT,
    });
    const parts: string[] = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      parts.push(node.textContent ?? "");
    }
    return parts.join(" ").replace(/\s+/g, " ");
  });
}

/** Every link into the organiser portal, by href, in document order. */
async function organiserHrefs(page: Page): Promise<string[]> {
  return page
    .locator(`a[href^="${PORTAL}"]`)
    .evaluateAll((links) => links.map((link) => link.getAttribute("href") ?? ""));
}

/** The href of the link named `name` inside `scope`. */
async function hrefOf(scope: Locator, name: string): Promise<string> {
  return (await scope.getByRole("link", { name, exact: true }).getAttribute("href")) ?? "";
}

/** How many figures in the hero a screen reader names exactly `caption`. */
async function heroFiguresNamed(page: Page, caption: string): Promise<number> {
  return page.locator("#hero").getByRole("figure", { name: caption, exact: true }).count();
}

/** The hero state on screen, once exactly one is. */
async function visibleHeroState(page: Page): Promise<string> {
  const shown = page.locator("#hero [data-state]:visible");
  await expect(shown).toHaveCount(1);
  return (await shown.getAttribute("data-state")) ?? "";
}

/** The journey panel on screen, once exactly one is. */
async function visibleJourneyStep(page: Page): Promise<string> {
  const shown = page.locator("#journey [data-step]:visible");
  await expect(shown).toHaveCount(1);
  return (await shown.getAttribute("data-step")) ?? "";
}

/** The claim field's link preview, whitespace collapsed. */
async function claimPreview(page: Page): Promise<string> {
  return ((await page.locator("[data-claim-preview]").textContent()) ?? "").replace(/\s+/g, "");
}

/** Whether the document is wider than the viewport. */
async function overflowsSideways(page: Page): Promise<boolean> {
  return page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
}

/** Paint every scroll-revealed block and hide the dev toolbar, for a screenshot. */
async function readyForScreenshot(page: Page): Promise<void> {
  await page.addStyleTag({ content: "astro-dev-toolbar { display: none !important; }" });
  await page.evaluate(() => {
    for (const el of document.querySelectorAll("[data-reveal]"))
      el.setAttribute("data-revealed", "");
  });
}

test("cire-landing-home", async ({ page, browser, flow }) => {
  let organiserLinkCount = 0;

  await flow.step("open the home page at 1280 px", async () => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(HOME);
    await expect(
      page.getByRole("heading", { name: "Invitations worthy of the moment", level: 1 }),
    ).toBeVisible();
    flow.check(
      "the page's sections, in order",
      SECTIONS.join(" "),
      (
        await page
          .locator(SECTIONS.map((id) => `#${id}`).join(", "))
          .evaluateAll((sections) => sections.map((section) => section.id))
      ).join(" "),
    );
    const text = await allText(page);
    flow.check(
      "no copy on the page, hidden states included, has an em-dash",
      false,
      text.includes("—"),
    );
    flow.check("no copy on the page says premium", false, /premium/i.test(text));
    const anchors = await page.locator('a[href^="#"], a[href^="/#"]').evaluateAll((links) =>
      links.map((link) => {
        const id = (link.getAttribute("href") ?? "").replace(/^\/?#/, "");
        return { id, found: document.getElementById(id) !== null };
      }),
    );
    flow.check("the page has in-page links", true, anchors.length > 0);
    flow.check(
      "every in-page link lands on an element of the page",
      "",
      anchors
        .filter((anchor) => !anchor.found)
        .map((anchor) => anchor.id)
        .join(" "),
    );
    flow.check(
      "with no demo invite configured, See a live invite scrolls to the demo",
      "#see-it-live",
      (await page
        .locator("#hero")
        .getByRole("link", { name: "See a live invite" })
        .getAttribute("href")) ?? "",
    );
  });

  await flow.step("every organiser link points at the portal", async () => {
    // Counted here for the JavaScript-off step to compare with, where the
    // count lands in results.json; each link a couple can press to start is
    // checked by name below.
    const hrefs = await organiserHrefs(page);
    organiserLinkCount = hrefs.length;
    flow.check(
      "every organiser link is the portal root, or the claim link carrying a name",
      "",
      hrefs.filter((href) => href !== PORTAL && !href.startsWith(`${PORTAL}/?name=`)).join(" "),
    );
    flow.check(
      "the nav's call to action opens the portal",
      PORTAL,
      await hrefOf(page.locator("[data-site-nav]"), "Create your invitation"),
    );
    flow.check(
      "the hero's primary call to action opens the portal",
      PORTAL,
      await hrefOf(page.locator("#hero"), "Create your invitation"),
    );
    for (const id of PLAN_IDS) {
      flow.check(
        `the ${id} plan's call to action opens the portal`,
        PORTAL,
        await hrefOf(page.locator(`#pricing [data-plan="${id}"]`), "Create your invitation"),
      );
    }
    flow.check(
      "the footer's Create an invitation opens the portal",
      PORTAL,
      await hrefOf(page.getByRole("contentinfo"), "Create an invitation"),
    );
  });

  await flow.step("read the closing thread before typing a name", async () => {
    const cta = page.locator("#cta");
    flow.check(
      "the thread carries the couple's guest link",
      "invite.cireweddings.com/cire/invite?slug=amara-sam-4c1e9a",
      ((await cta.locator("[data-thread-link]").textContent()) ?? "").trim(),
    );
    flow.check(
      "with the field empty, the preview shows the fallback slug",
      "invite.cireweddings.com/cire/invite?slug=wedding-······",
      await claimPreview(page),
    );
    flow.check(
      "with the field empty, the claim link opens the portal with no name",
      PORTAL,
      (await cta.locator("[data-claim-cta]").getAttribute("href")) ?? "",
    );
  });

  await flow.step("type the couple's names into the claim field", async () => {
    await page.locator("#cta").getByLabel("Your names").fill("Amara & Sam");
    await expect(page.locator("[data-claim-preview]")).toContainText("amara-sam");
    flow.check(
      "the preview shows the slug Cire would make",
      "invite.cireweddings.com/cire/invite?slug=amara-sam-······",
      await claimPreview(page),
    );
    flow.check(
      "the claim link carries the names to the portal",
      `${PORTAL}/?name=Amara%20%26%20Sam`,
      (await page.locator("[data-claim-cta]").getAttribute("href")) ?? "",
    );
    flow.check(
      "the claim link is still a link the portal accepts",
      "",
      (await organiserHrefs(page))
        .filter((href) => href !== PORTAL && !href.startsWith(`${PORTAL}/?name=`))
        .join(" "),
    );
    const field = page.locator("#cta").getByLabel("Your names");
    const claimLink = page.locator("[data-claim-cta]");
    await field.fill("   ");
    flow.check(
      "with only spaces in the field, the claim link opens the portal with no name",
      PORTAL,
      (await claimLink.getAttribute("href")) ?? "",
    );
    await field.fill("  Amara & Sam  ");
    flow.check(
      "the claim link carries the names without the spaces around them",
      `${PORTAL}/?name=Amara%20%26%20Sam`,
      (await claimLink.getAttribute("href")) ?? "",
    );
    flow.check(
      "the field takes no more than the 120 characters cire-api accepts",
      "120",
      (await field.getAttribute("maxlength")) ?? "",
    );
  });

  await flow.step("press Enter in the claim field", async () => {
    // The field sits in no form, so Enter is the field's own handler following
    // the link. A page served here stands in for the portal, so no request
    // reaches the portal or cire-api.
    const portal = (url: URL): boolean => url.origin === PORTAL;
    const standIn = (route: Route) =>
      route.fulfill({ status: 200, contentType: "text/html", body: "<title>portal</title>" });
    await page.route(portal, standIn);
    await page.locator("#cta").getByLabel("Your names").press("Enter");
    await page.waitForURL(portal);
    flow.check(
      "Enter in the claim field follows the claim link",
      `${PORTAL}/?name=Amara%20%26%20Sam`,
      page.url(),
    );
    // Back on the home page the link must match the field, whether or not the
    // browser put the names back in it, so the check is that they agree and
    // not what either holds.
    await page.goBack();
    const back = await page.locator("[data-claim]").evaluate((claim) => ({
      value: claim.querySelector<HTMLInputElement>("[data-claim-input]")?.value ?? "",
      href: claim.querySelector("[data-claim-cta]")?.getAttribute("href") ?? "",
    }));
    const trimmed = back.value.trim();
    const expected = trimmed === "" ? PORTAL : `${PORTAL}/?name=${encodeURIComponent(trimmed)}`;
    flow.check(
      "back on the home page, the claim link matches the field",
      true,
      back.href === expected,
    );
    await page.unroute(portal, standIn);
  });

  await flow.step("switch the hero's invitation with the chips", async () => {
    await page.locator("#hero").scrollIntoViewIfNeeded();
    flow.check("the hero opens on the sealed invitation", "sealed", await visibleHeroState(page));
    flow.check(
      "a screen reader hears the sealed invitation's caption, and only it",
      1,
      await heroFiguresNamed(page, HERO_STATES[0].caption),
    );
    const sealed = page.locator('#hero [data-state="sealed"]');
    const sealedText = ((await sealed.textContent()) ?? "").replace(/\s+/g, " ");
    flow.check("the sealed invitation names the couple", true, sealedText.includes("Amara & Sam"));
    flow.check(
      "the sealed invitation carries the date",
      true,
      sealedText.includes("Saturday 20 March 2027"),
    );
    flow.check(
      "the sealed invitation shows the guest site's button",
      true,
      sealedText.includes("Open Invitation"),
    );
    flow.check(
      "the chips, in order",
      HERO_STATES.map((state) => state.label).join(" | "),
      (await page.locator("#hero label[for^='hs-']").allTextContents())
        .map((text) => text.trim())
        .join(" | "),
    );
    for (const state of HERO_STATES.slice(1)) {
      await page.locator(`#hero label[for="hs-${state.id}"]`).click();
      flow.check(
        `the ${state.label} chip shows that invitation`,
        state.id,
        await visibleHeroState(page),
      );
      flow.check(
        `a screen reader hears the ${state.label} invitation's caption, and only it`,
        1,
        await heroFiguresNamed(page, state.caption),
      );
    }
    await page.locator("#hs-on-the-day").focus();
    await page.keyboard.press("ArrowRight");
    flow.check(
      "ArrowRight from the last chip wraps to the first",
      "sealed",
      await visibleHeroState(page),
    );
    await page.keyboard.press("ArrowLeft");
    flow.check(
      "ArrowLeft from the first chip wraps to the last",
      "on-the-day",
      await visibleHeroState(page),
    );
    await page.keyboard.press("ArrowLeft");
    flow.check("ArrowLeft steps back one chip", "rsvp", await visibleHeroState(page));
    // A fieldset, not role=radiogroup: the group also holds the phones, so the
    // radios can sit before them for the sibling selectors, and a radiogroup
    // may own only radios.
    flow.check(
      "the chips are one named group",
      1,
      await page.getByRole("group", { name: "Show the invitation" }).count(),
    );
    await page.locator('#hero label[for="hs-sealed"]').click();
    await visibleHeroState(page);
  });

  await flow.step("reply to the demo invitation, and see nothing sent", async () => {
    const demo = page.locator("#see-it-live");
    await demo.scrollIntoViewIfNeeded();
    await expect(demo.locator("astro-island:not([ssr])")).toHaveCount(1);
    // `astro dev`'s toolbar audit fetches each of the page's own images to
    // weigh them, whenever it runs; that is the dev server, not the demo, so
    // a GET of exactly one of those files is not counted.
    const pageImages = new Set(
      await page
        .locator("img[src]")
        .evaluateAll((images: HTMLImageElement[]) => images.map((image) => image.src)),
    );
    const sent: string[] = [];
    const collect = (request: { resourceType(): string; method(): string; url(): string }) => {
      if (request.method() === "GET" && pageImages.has(request.url())) return;
      if (["fetch", "xhr", "eventsource", "ping"].includes(request.resourceType())) {
        sent.push(`${request.method()} ${request.url()}`);
      }
    };
    page.on("request", collect);
    await demo.getByRole("button", { name: "Respond" }).first().click();
    const sheet = page.getByRole("dialog");
    await expect(sheet.getByRole("heading", { name: "The Ceremony" })).toBeVisible();
    // By each person's fieldset name: "Sam" as text also matches "Sesame" in
    // the dietary list.
    const amara = sheet.getByRole("group", { name: "Amara Reyes", exact: true });
    const sam = sheet.getByRole("group", { name: "Sam Reyes", exact: true });
    await amara.getByRole("button", { name: "Attending", exact: true }).click();
    await sam.getByRole("button", { name: "Not attending" }).click();
    await sheet.getByRole("button", { name: "Send RSVP" }).click();
    await expect(sheet.getByRole("heading", { name: /That.s the feeling/ })).toBeVisible();
    flow.check(
      "the demo confirms the reply",
      true,
      await sheet.getByText(/nothing is saved/).isVisible(),
    );
    page.off("request", collect);
    flow.check("requests the demo sent", "", sent.join(" "));
    // The sheet's × and the confirmation's button are both named Close.
    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();
  });

  await flow.step("walk the journey's five tabs", async () => {
    const journey = page.locator("#journey");
    await journey.scrollIntoViewIfNeeded();
    flow.check(
      "the journey's tabs, in order",
      JOURNEY.map((step) => step.label).join(" "),
      (await journey.locator("label[for^='js-']").allTextContents())
        .map((text) => text.trim())
        .join(" "),
    );
    flow.check("the journey opens on the invitation", "invite", await visibleJourneyStep(page));
    for (const step of JOURNEY) {
      await journey.locator(`label[for="js-${step.id}"]`).click();
      flow.check(`the ${step.label} tab shows its panel`, step.id, await visibleJourneyStep(page));
      const panel = journey.locator(`[data-step="${step.id}"]`);
      flow.check(
        `the ${step.label} panel's heading`,
        step.heading,
        ((await panel.getByRole("heading", { level: 3 }).textContent()) ?? "").trim(),
      );
      flow.check(
        `the ${step.label} panel ${step.gold ? "is" : "is not"} marked Gold`,
        step.gold ? "Gold" : "",
        (await panel.locator("[data-tier]").allTextContents()).join(" ").trim(),
      );
      flow.check(
        `the ${step.label} panel says its data is a sample`,
        true,
        ((await panel.textContent()) ?? "").includes("Sample wedding"),
      );
    }
    await journey.locator('label[for="js-invite"]').click();
    await visibleJourneyStep(page);
  });

  await flow.step("read the plans", async () => {
    const pricing = page.locator("#pricing");
    await pricing.scrollIntoViewIfNeeded();
    const cards = await pricing.locator("[data-plan]").evaluateAll((articles) =>
      articles.map((article) => {
        const [name, price, cap] = ["[data-plan-name]", "[data-plan-price]", "[data-plan-cap]"].map(
          (part) => (article.querySelector(part)?.textContent ?? "").replace(/\s+/g, ""),
        );
        return { name: name ?? "", price: price ?? "", cap: cap ?? "" };
      }),
    );
    flow.check(
      "each plan's name, price and guest cap",
      "Ivory, Free, 100 / Gold, A$79, 500 / Crimson, A$149, 1,000",
      cards.map((card) => `${card.name}, ${card.price}, ${card.cap}`).join(" / "),
    );
    const upgrade = (await pricing.locator("[data-plan-upgrade]").textContent()) ?? "";
    flow.check("the footnote prices the move from Gold to Crimson", true, upgrade.includes("A$70"));
    // Each plan's price and cap as the cards show them, bound to its name, so
    // a FAQ with two caps swapped, or an old price, fails.
    const faq = ((await page.locator("#faq").textContent()) ?? "").replace(/\s+/g, " ");
    flow.check(
      "the FAQ gives each plan the price and guest cap its card shows",
      "",
      cards
        .map(
          (card) =>
            `${card.name} is ${card.price === "Free" ? "free" : card.price} for up to ${card.cap} guests`,
        )
        .filter((phrase) => !faq.includes(phrase))
        .join(" / "),
    );
    flow.check(
      "the FAQ prices the move from Gold to Crimson as the footnote does",
      true,
      faq.includes(`from Gold, Crimson is ${upgrade.match(/A\$\d+/)?.[0] ?? "no price"}`),
    );
  });

  await flow.step("see the craft photograph served from the site itself", async () => {
    const photo = page.getByRole("img", { name: CRAFT_PHOTO, exact: true });
    await photo.scrollIntoViewIfNeeded();
    // Lazy: it loads once it nears the viewport.
    await expect
      .poll(() => photo.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0))
      .toBe(true);
    const source = await photo.evaluate((img: HTMLImageElement) => img.currentSrc);
    flow.check(
      "the craft photograph loads from the landing site's own origin",
      ORIGINS.cireLanding,
      new URL(source).origin,
    );
    flow.check(
      "the craft photograph credits its photographer",
      "Photo: Jonathan Borba / Unsplash",
      (
        (await page.locator("figure", { has: photo }).locator("figcaption").textContent()) ?? ""
      ).trim(),
    );
  });

  await flow.step("read the page with JavaScript off", async () => {
    const context = await browser.newContext({
      javaScriptEnabled: false,
      viewport: { width: 1280, height: 900 },
    });
    const noScript = await context.newPage();
    await noScript.goto(HOME);
    flow.check(
      "with JavaScript off the hero opens sealed",
      "sealed",
      await visibleHeroState(noScript),
    );
    for (const state of HERO_STATES.slice(1)) {
      await noScript.locator(`#hero label[for="hs-${state.id}"]`).click();
      flow.check(
        `with JavaScript off the ${state.label} chip still switches`,
        state.id,
        await visibleHeroState(noScript),
      );
    }
    for (const step of JOURNEY.slice(1)) {
      await noScript.locator(`#journey label[for="js-${step.id}"]`).click();
      flow.check(
        `with JavaScript off the ${step.label} tab still switches`,
        step.id,
        await visibleJourneyStep(noScript),
      );
    }
    flow.check(
      "with JavaScript off the page has the same organiser links",
      organiserLinkCount,
      (await organiserHrefs(noScript)).length,
    );
    await noScript.locator("#cta").getByLabel("Your names").fill("Amara & Sam");
    flow.check(
      "with JavaScript off the claim link opens the portal with no name",
      PORTAL,
      (await noScript.locator("[data-claim-cta]").getAttribute("href")) ?? "",
    );
    await context.close();
  });

  await flow.step("ask for reduced motion", async () => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.locator("#hero").scrollIntoViewIfNeeded();
    const seconds = await page
      .locator('#hero [data-state="sealed"]')
      .evaluate((screen) => parseFloat(getComputedStyle(screen).transitionDuration));
    flow.check("with reduced motion the hero's screens switch at once", true, seconds < 0.01);
    await page.emulateMedia({ reducedMotion: "no-preference" });
  });

  await flow.step("lay out at phone and tablet width", async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(HOME);
    await expect(
      page.getByRole("heading", { name: "Invitations worthy of the moment", level: 1 }),
    ).toBeVisible();
    flow.check("at 390 px nothing pans sideways", false, await overflowsSideways(page));
    const middle = await page.locator('#hero [data-fan="centre"]').boundingBox();
    flow.check(
      "at 390 px the invitation phone sits inside the screen",
      true,
      middle !== null && middle.x >= 0 && middle.x + middle.width <= 390,
    );
    const cta = await page
      .locator("#hero")
      .getByRole("link", { name: "Create your invitation" })
      .boundingBox();
    flow.check(
      "at 390 x 844 the primary call to action is above the fold",
      true,
      cta !== null && cta.y + cta.height <= 844,
    );
    flow.check(
      "at 390 px the outer pair of phones is not drawn",
      "none none",
      (
        await page
          .locator('#hero [data-fan^="far-"]')
          .evaluateAll((phones) => phones.map((phone) => getComputedStyle(phone).display))
      ).join(" "),
    );
    const chipHeights = await page
      .locator("#hero label[for^='hs-']")
      .evaluateAll((labels) => labels.map((label) => label.getBoundingClientRect().height));
    flow.check(
      "at 390 px every chip is at least 44 px tall",
      true,
      chipHeights.length === 4 && chipHeights.every((height) => height >= 44),
    );
    await page.setViewportSize({ width: 768, height: 1024 });
    flow.check("at 768 px nothing pans sideways", false, await overflowsSideways(page));
  });

  await flow.step("screenshot the page, each hero state and each journey tab", async () => {
    mkdirSync(SHOTS, { recursive: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(HOME);
    await readyForScreenshot(page);
    await page.screenshot({
      path: resolve(SHOTS, "home-390.png"),
      fullPage: true,
      animations: "disabled",
    });
    for (const state of HERO_STATES) {
      await page.locator(`#hero label[for="hs-${state.id}"]`).click();
      await visibleHeroState(page);
      await page.locator("#hero").screenshot({
        path: resolve(SHOTS, `hero-${state.id}-390.png`),
        animations: "disabled",
      });
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(HOME);
    await readyForScreenshot(page);
    await page.screenshot({
      path: resolve(SHOTS, "home-1280.png"),
      fullPage: true,
      animations: "disabled",
    });
    for (const step of JOURNEY) {
      await page.locator(`#journey label[for="js-${step.id}"]`).click();
      await visibleJourneyStep(page);
      await page.locator("#journey").screenshot({
        path: resolve(SHOTS, `journey-${step.id}-1280.png`),
        animations: "disabled",
      });
    }
    await page.locator("#hero").scrollIntoViewIfNeeded();
    await page.locator('#hero label[for="hs-sealed"]').click();
    await visibleHeroState(page);
    await page.evaluate(() => window.scrollTo(0, 0));
  });
});
