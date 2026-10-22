import { cleanup, render, waitFor } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";

import "../../src/styles/global.css";
import {
  EDGE_HERO_ATTR,
  EDGE_STRIP_CLASS,
  oklchToHex,
  startEdgeColours,
} from "../../src/components/edge-boot";
import ClassicInviteHeader from "../../src/designs/classic/InviteHeader";
import GalaInviteHeader from "../../src/designs/gala/InviteHeader";
import type { InviteCustomisation } from "../../src/designs/types";
import { Z_CLASS } from "../../src/lib/z-index";

/**
 * The edge loop in a real engine, against the real classic hero.
 *
 * Chromium reports no safe-area inset, so the loop is driven with an injected
 * inset reader (`startEdgeColours`' second argument). Everything else is the
 * real thing: the hero's markup and gradient, the custom properties from
 * global.css, the stacking the z-index classes produce, and scrolling.
 * Whether the device really reports an inset is checked by the E2E flow, not here.
 */

const insets = (top: number, bottom: number) => () => ({ top, bottom });

function invite(): InviteCustomisation {
  return {
    hero: { title: "Anita & Ben", subtitle: null, imageUrl: null },
    story: { eyebrow: null, heading: "How it began", body: null, imageUrl: null },
    heroDisplay: { blur: 28, titleBackdrop: { opacity: 0, blur: 0 } },
    theme: { headingFont: null, bodyFont: null, palette: null, tones: null },
  };
}

function mountStrips(): { top: HTMLElement; bottom: HTMLElement } {
  const top = document.createElement("div");
  top.className = `${EDGE_STRIP_CLASS} edge-top ${Z_CLASS.EDGE}`;
  top.setAttribute("aria-hidden", "true");
  const bottom = document.createElement("div");
  bottom.className = `${EDGE_STRIP_CLASS} edge-bottom ${Z_CLASS.EDGE}`;
  bottom.setAttribute("aria-hidden", "true");
  document.body.append(top, bottom);
  return { top, bottom };
}

async function mountHeader() {
  const { container } = render(() => (
    <>
      <ClassicInviteHeader apiUrl="https://api.test" slug="anita-and-ben" initial={invite()} />
      <div style={{ height: "200vh" }} />
    </>
  ));
  await document.fonts.ready;
  return container.querySelector("section") as HTMLElement;
}

/** Let the loop's next animation frame run. */
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

async function scrollTo(y: number) {
  window.scrollTo(0, y);
  window.dispatchEvent(new Event("scroll"));
  await frame();
  await frame();
}

const cssVar = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name);

describe("startEdgeColours in the real classic hero", () => {
  let stop: (() => void) | undefined;

  afterEach(() => {
    stop?.();
    stop = undefined;
    cleanup();
    document.querySelectorAll(`.${EDGE_STRIP_CLASS}`).forEach((el) => el.remove());
    document.documentElement.removeAttribute("style");
    document.documentElement.classList.remove("has-safe-top", "has-safe-bottom");
    document.querySelector('meta[name="theme-color"]')?.remove();
  });

  it("paints the hero colours at the top and bottom at rest, and the page colour once the hero has scrolled off the bottom strip", async () => {
    await page.viewport(390, 844);
    const hero = await mountHeader();
    hero.setAttribute(EDGE_HERO_ATTR, "");
    mountStrips();
    stop = startEdgeColours(document, insets(0, 34));
    await frame();

    const grad1 = oklchToHex(cssVar("--invite-hero-grad-1"));
    const grad3 = oklchToHex(cssVar("--invite-hero-grad-3"));
    const page_ = oklchToHex(cssVar("--color-bg"));

    expect(document.documentElement.style.getPropertyValue("--edge-top-bg")).toBe(grad1);
    expect(document.documentElement.style.getPropertyValue("--edge-bottom-bg")).toBe(grad3);
    expect(document.querySelector('meta[name="theme-color"]')?.getAttribute("content")).toBe(grad1);

    // The hero is one viewport tall, so scrolling 33px leaves it covering the
    // 34px bottom zone, and 34px takes the strip to the page colour.
    expect(window.scrollY).toBe(0);
    await scrollTo(33);
    expect(window.scrollY, "the page must really scroll").toBe(33);
    expect(document.documentElement.style.getPropertyValue("--edge-bottom-bg")).toBe(grad3);

    await scrollTo(34);
    expect(document.documentElement.style.getPropertyValue("--edge-bottom-bg")).toBe(page_);
  });

  it("switches the top edge to the page colour when there is no hero, and back when the hero arrives", async () => {
    await page.viewport(390, 844);
    const hero = await mountHeader();
    hero.removeAttribute(EDGE_HERO_ATTR);
    mountStrips();
    stop = startEdgeColours(document, insets(34, 34));
    await frame();

    expect(document.documentElement.style.getPropertyValue("--edge-top-bg")).toBe(
      oklchToHex(cssVar("--color-bg")),
    );

    hero.setAttribute(EDGE_HERO_ATTR, "");
    document.dispatchEvent(new Event("cire:palette"));
    await frame();
    expect(document.documentElement.style.getPropertyValue("--edge-top-bg")).toBe(
      oklchToHex(cssVar("--invite-hero-grad-1")),
    );
  });

  it("stops updating once cleaned up", async () => {
    await page.viewport(390, 844);
    const hero = await mountHeader();
    hero.setAttribute(EDGE_HERO_ATTR, "");
    mountStrips();
    stop = startEdgeColours(document, insets(0, 34));
    await frame();
    stop();
    stop = undefined;

    const before = document.documentElement.style.getPropertyValue("--edge-bottom-bg");
    await scrollTo(200);
    expect(document.documentElement.style.getPropertyValue("--edge-bottom-bg")).toBe(before);
  });

  it("gives the strip pointer-events none, so it never takes a tap", async () => {
    await page.viewport(390, 844);
    await mountHeader();
    const { top, bottom } = mountStrips();
    document.documentElement.classList.add("has-safe-top", "has-safe-bottom");
    // The strip rules live in global.css under html.has-safe-*; these computed
    // values come from that stylesheet, not from inline styles.
    expect(getComputedStyle(top).pointerEvents).toBe("none");
    expect(getComputedStyle(bottom).pointerEvents).toBe("none");
    expect(getComputedStyle(bottom).position).toBe("fixed");
  });

  it("paints the scroll cue above the bottom strip where they overlap", async () => {
    await page.viewport(390, 844);
    const hero = await mountHeader();
    const cue = hero.querySelector("[data-scroll-cue]") as HTMLElement;
    mountStrips();
    document.documentElement.classList.add("has-safe-bottom");
    const strip = document.querySelector(`.edge-bottom`) as HTMLElement;

    expect(Number(getComputedStyle(cue).zIndex)).toBeGreaterThan(
      Number(getComputedStyle(strip).zIndex),
    );
    // A z-index only ranks inside its own stacking context. No ancestor of the
    // cue below <body> may create one, or the cue could fall under the strip
    // while the numbers still compare correctly.
    const trapping: string[] = [];
    for (let el = cue.parentElement; el && el !== document.body; el = el.parentElement) {
      const cs = getComputedStyle(el);
      const creates =
        cs.zIndex !== "auto" ||
        cs.transform !== "none" ||
        cs.filter !== "none" ||
        cs.isolation === "isolate" ||
        cs.willChange !== "auto" ||
        cs.contain.includes("paint") ||
        cs.contain.includes("layout") ||
        Number(cs.opacity) < 1;
      if (creates) trapping.push(el.tagName.toLowerCase());
    }
    expect(trapping, "ancestors that would trap the cue's z-index").toEqual([]);
  });

  it("re-reads the insets when the viewport changes, so a rotated phone gets the right strips", async () => {
    await page.viewport(390, 844);
    await mountHeader();
    mountStrips();
    let current = { top: 0, bottom: 0 };
    stop = startEdgeColours(document, () => current);
    await frame();
    expect(document.documentElement.classList.contains("has-safe-bottom")).toBe(false);

    current = { top: 0, bottom: 34 };
    window.dispatchEvent(new Event("resize"));
    await frame();
    await frame();
    expect(document.documentElement.classList.contains("has-safe-bottom")).toBe(true);
  });
  it.each([
    ["classic", ClassicInviteHeader],
    ["gala", GalaInviteHeader],
  ] as const)(
    "takes the hero colour on the top edge when the %s invite arrives after start-up, with no event sent by the test",
    async (_name, Header) => {
      await page.viewport(390, 844);
      // A scroll left by an earlier case would clamp when this page's content
      // changes, and that scroll event would re-run the loop and hide the gap.
      window.scrollTo(0, 0);
      await frame();
      const body = {
        hero: { title: "Anita & Ben", subtitle: null, imageUrl: null },
        story: { eyebrow: null, heading: "How it began", body: null, imageUrl: null },
        heroDisplay: { blur: 28, titleBackdrop: { opacity: 0, blur: 0 } },
        theme: { headingFont: null, bodyFont: null, palette: null, tones: null },
      };
      vi.stubGlobal(
        "fetch",
        vi.fn(
          async () =>
            new Response(JSON.stringify(body), {
              status: 200,
              headers: { "content-type": "application/json" },
            }),
        ),
      );
      try {
        mountStrips();
        stop = startEdgeColours(document, insets(0, 34));
        const { container } = render(() => (
          <>
            <Header apiUrl="https://api.test" slug="anita-and-ben" initial={null} />
            <div style={{ height: "200vh" }} />
          </>
        ));
        await waitFor(() => {
          expect(container.querySelector(`[${EDGE_HERO_ATTR}]`)).not.toBeNull();
        });
        await frame();
        await frame();

        const grad1 = oklchToHex(cssVar("--invite-hero-grad-1"));
        expect(document.documentElement.style.getPropertyValue("--edge-top-bg")).toBe(grad1);
      } finally {
        vi.unstubAllGlobals();
      }
    },
  );
});
