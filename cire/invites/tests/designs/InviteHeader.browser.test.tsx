import { cleanup, render, within } from "@solidjs/testing-library";
import type { Component } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { commands, page } from "vitest/browser";

import "../../src/styles/global.css";
import { ConsentBanner } from "../../src/components/consent/ConsentBanner";
import { setReturningHousehold } from "../../src/components/returning-household";
import ClassicInviteHeader from "../../src/designs/classic/InviteHeader";
import GalaInviteHeader from "../../src/designs/gala/InviteHeader";
import type { InviteCustomisation } from "../../src/designs/types";
import { resetConsentForTest } from "../../src/lib/consent/testing";

/**
 * The hero's scroll cue in both packs, measured in a real engine.
 *
 * `HeroScrollCue.test.tsx` pins the wiring and the class contract. What it
 * cannot see is whether the guest gets the cue: that it is painted once its
 * entry has played, on screen, inside the hero; that its drift really moves,
 * and the motion lasts under five seconds; that the first scroll fades it out and
 * scrolling back does not bring it back; that it keeps clear of a title tall
 * enough to grow the hero; that the first-visit consent prompt leaves the hero
 * uncovered once answered; and that reduced motion leaves it there and still.
 * Each is a fact of the compiled stylesheet, layout or the animation
 * timeline, none of which jsdom computes.
 *
 * Every render puts a tall block after the header, standing in for the rest of
 * the invite, so the page can scroll at all.
 */

type Header = Component<{ apiUrl: string; slug: string; initial?: InviteCustomisation | null }>;

const PACKS: readonly (readonly [string, Header, "center" | "end"])[] = [
  ["classic", ClassicInviteHeader, "center"],
  ["gala", GalaInviteHeader, "end"],
];

type Viewport = readonly [width: number, height: number];

const PHONE: Viewport = [390, 844];
/** Past the 1024px step where the root font-size, and so every rem, grows. */
const DESKTOP: Viewport = [1440, 900];
const VIEWPORTS: readonly { name: string; size: Viewport }[] = [
  { name: "phone", size: PHONE },
  { name: "desktop", size: DESKTOP },
];

/** The tester iframe's own default, restored after every test. */
const DEFAULT: Viewport = [414, 896];

/** Typed accessor for the command registered in `vitest.config.ts`. */
const emulate = (options: { reducedMotion?: "reduce" | "no-preference" }) =>
  (commands as unknown as { emulateMedia: (o: typeof options) => Promise<void> }).emulateMedia(
    options,
  );

function invite(hero: { title?: string; subtitle?: string } = {}): InviteCustomisation {
  return {
    hero: { title: hero.title ?? "Anita & Ben", subtitle: hero.subtitle ?? null, imageUrl: null },
    story: { eyebrow: null, heading: "How it began", body: null, imageUrl: null },
    heroDisplay: { blur: 28, titleBackdrop: { opacity: 0, blur: 0 } },
    theme: { headingFont: null, bodyFont: null, palette: null, tones: null },
  };
}

async function mount(InviteHeader: Header, initial: InviteCustomisation) {
  const { container } = render(() => (
    <>
      <InviteHeader apiUrl="https://api.test" slug="anita-and-ben" initial={initial} />
      <div style={{ height: "200vh" }} />
    </>
  ));
  await document.fonts.ready;
  const hero = container.querySelector("section") as HTMLElement;
  const cue = hero.querySelector("[data-scroll-cue]") as HTMLElement;
  const glyph = cue.querySelector("svg") as SVGSVGElement;
  // The block holding the couple's title (and the subtitle, when there is one).
  const titleBlock = hero.querySelector("span.font-display")!.parentElement as HTMLElement;
  return { hero, cue, glyph, titleBlock };
}

/** The smallest phone the invite is laid out for. */
const NARROWEST: Viewport = [320, 568];

/**
 * A hero with no couple title draws its fallback, which reads "Welcome back to
 * your invite" for a household that has replied before: about twice the
 * length of "You're Invited", so more lines at the same size.
 */
async function mountWelcomeBack(InviteHeader: Header) {
  setReturningHousehold(true);
  const initial = invite({ subtitle: "Saturday 18 September" });
  const { hero, glyph, titleBlock } = await mount(InviteHeader, {
    ...initial,
    hero: { ...initial.hero, title: null },
  });
  return {
    title: within(hero).queryByText("Welcome back to your invite"),
    glyphTop: glyph.getBoundingClientRect().top,
    titleBottom: titleBlock.getBoundingClientRect().bottom,
  };
}

/** A `layout-shift` performance entry; TypeScript's DOM types do not carry it. */
type LayoutShift = PerformanceEntry & { value: number };

/** The consent banner's panel — which must never appear over an invite. */
const consentPanel = () =>
  document.querySelector<HTMLElement>('section[aria-label="Privacy choices"]');

/** The wrapper's running CSS transitions, by the property each one moves. */
function transitionOf(cue: HTMLElement, property: string) {
  return cue
    .getAnimations()
    .find(
      (a): a is CSSTransition => a instanceof CSSTransition && a.transitionProperty === property,
    );
}

/** The cue's two CSS animations, found by name rather than by position. */
function animationsOf(glyph: SVGSVGElement) {
  const all = glyph.getAnimations() as CSSAnimation[];
  return {
    all,
    entry: all.find((a) => a.animationName === "scroll-cue-in"),
    drift: all.find((a) => a.animationName === "scroll-cue-drift"),
  };
}

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

function scrollPageTo(top: number) {
  window.scrollTo({ top, behavior: "instant" });
}

const rootPx = () => Number.parseFloat(getComputedStyle(document.documentElement).fontSize);

// The scroll position, the motion preference, the viewport and the consent
// cookie all outlive a test, and a cue that mounts on a scrolled page starts
// out hidden.
afterEach(async () => {
  cleanup();
  setReturningHousehold(false);
  resetConsentForTest();
  scrollPageTo(0);
  await vi.waitFor(() => {
    if (window.scrollY !== 0) throw new Error(`page still scrolled to ${window.scrollY}`);
  });
  await emulate({ reducedMotion: "no-preference" });
  await page.viewport(...DEFAULT);
});

describe.each(PACKS)("%s hero scroll cue", (_pack, InviteHeader, align) => {
  describe.each(VIEWPORTS)("at $name width", ({ size }) => {
    it("is painted at the top of the page, on screen and inside the hero", async () => {
      await page.viewport(...size);
      const { hero, cue, glyph } = await mount(InviteHeader, invite());

      // Without these the rest of the file could pass on a page that cannot
      // scroll, or on a cue that mounted already latched.
      expect(document.documentElement.scrollHeight).toBeGreaterThan(window.innerHeight);
      expect(window.scrollY).toBe(0);
      expect(cue.dataset.scrollCue).toBe("shown");

      // The entry waits a beat after the title, then fades the glyph in. Its
      // `backwards` fill holds the glyph hidden until then, so play it to its
      // end rather than sleeping through 1.6s.
      const { entry, drift } = animationsOf(glyph);
      expect(entry?.effect?.getTiming()).toMatchObject({ delay: 1000, duration: 600 });
      // Inside the delay the glyph is held at its first frame, not shown and
      // then snatched away when the fade starts.
      entry!.pause();
      entry!.currentTime = 500;
      expect(getComputedStyle(glyph).opacity).toBe("0");
      entry!.finish();

      // On the glyph, so the wrapper's opacity counts as well (an ancestor).
      expect(glyph.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })).toBe(true);
      expect(getComputedStyle(glyph).opacity).toBe("1");

      const box = glyph.getBoundingClientRect();
      const frame = hero.getBoundingClientRect();
      expect(box.width).toBeGreaterThan(0);
      expect(box.top).toBeGreaterThanOrEqual(0);
      expect(box.bottom).toBeLessThanOrEqual(window.innerHeight);
      expect(box.left).toBeGreaterThanOrEqual(frame.left);
      expect(box.right).toBeLessThanOrEqual(frame.right);
      expect(box.bottom).toBeLessThanOrEqual(frame.bottom);

      // Centred, or on the hero's 1.5rem gutter (25.5px once the root steps up).
      const offAlign =
        align === "center"
          ? (box.left + box.right) / 2 - window.innerWidth / 2
          : window.innerWidth - box.right - 1.5 * rootPx();
      expect(Math.abs(offAlign)).toBeLessThanOrEqual(1);

      // The drift is under way: the token compiled to real CSS.
      expect(drift?.playState).toBe("running");
    });

    it("fades out on the first scroll and does not come back at the top", async () => {
      await page.viewport(...size);
      const { cue, glyph } = await mount(InviteHeader, invite());
      animationsOf(glyph).entry!.finish();

      scrollPageTo(200);
      await vi.waitFor(() => expect(cue.dataset.scrollCue).toBe("hidden"));
      // A fade, not a blink: held mid-way, the cue is part-way out.
      const fade = transitionOf(cue, "opacity");
      expect(fade?.effect?.getTiming().duration).toBe(500);
      fade!.pause();
      fade!.currentTime = 250;
      const midway = Number(getComputedStyle(cue).opacity);
      expect(midway).toBeGreaterThan(0);
      expect(midway).toBeLessThan(1);
      fade!.finish();
      await vi.waitFor(() => expect(getComputedStyle(cue).opacity).toBe("0"), { timeout: 2000 });
      expect(glyph.checkVisibility({ checkOpacity: true })).toBe(false);
      // A hidden cue runs nothing.
      expect(animationsOf(glyph).drift?.playState).toBe("paused");

      scrollPageTo(0);
      await vi.waitFor(() => expect(window.scrollY).toBe(0));
      await nextFrame();
      await nextFrame();
      expect(cue.dataset.scrollCue).toBe("hidden");
      expect(getComputedStyle(cue).opacity).toBe("0");
    });

    it("sits below the title block, even when a long title grows the hero", async () => {
      await page.viewport(...size);
      const long = invite({
        title: "Anita Konstantinopoulou & Bartholomew Featherstonehaugh ".repeat(8).trim(),
        subtitle: "Together with their families, request the pleasure of your company ".repeat(2),
      });
      const tall = await mount(InviteHeader, long);
      // The case the bottom padding exists for: without it the title would run
      // on to the hero's bottom edge, under the cue.
      expect(tall.hero.getBoundingClientRect().height).toBeGreaterThan(window.innerHeight);
      const tallGlyph = tall.glyph.getBoundingClientRect();
      expect(tallGlyph.top).toBeGreaterThanOrEqual(tall.titleBlock.getBoundingClientRect().bottom);
      // The drift moves it 6px down; that must stay inside the hero too.
      expect(tallGlyph.bottom + 6).toBeLessThanOrEqual(tall.hero.getBoundingClientRect().bottom);
      cleanup();

      const short = await mount(InviteHeader, invite({ subtitle: "Saturday 18 September" }));
      expect(short.glyph.getBoundingClientRect().top).toBeGreaterThanOrEqual(
        short.titleBlock.getBoundingClientRect().bottom,
      );
    });

    it("sits below the longer welcome-back title a returning household gets", async () => {
      await page.viewport(...size);
      const { title, glyphTop, titleBottom } = await mountWelcomeBack(InviteHeader);
      expect(title).not.toBeNull();
      expect(glyphTop).toBeGreaterThanOrEqual(titleBottom);
    });
  });

  it("sits below the welcome-back title on the narrowest phone", async () => {
    await page.viewport(...NARROWEST);
    const { title, glyphTop, titleBottom } = await mountWelcomeBack(InviteHeader);
    expect(title).not.toBeNull();
    expect(glyphTop).toBeGreaterThanOrEqual(titleBottom);
  });

  it("drifts 6px down and back twice, all within five seconds, then rests in view", async () => {
    await page.viewport(...PHONE);
    const { glyph } = await mount(InviteHeader, invite());
    const { entry, drift } = animationsOf(glyph);
    const shown = entry!.effect!.getTiming();
    const moving = drift!.effect!.getTiming();
    expect(moving).toMatchObject({ delay: 1600, duration: 2000, iterations: 2 });

    // WCAG 2.2.2: motion that starts by itself and runs past five seconds
    // needs a way to stop it. From the first frame of the fade to the last of
    // the drift, this stays under that.
    const motionMs = Number(moving.delay) + Number(moving.duration) * Number(moving.iterations);
    expect(motionMs - Number(shown.delay)).toBeLessThan(5000);

    // Driven, not raced: hold the timeline at the middle of an iteration.
    drift!.pause();
    drift!.currentTime = 1600 + 1000;
    expect(new DOMMatrixReadOnly(getComputedStyle(glyph).transform).m42).toBeCloseTo(6, 3);
    drift!.currentTime = 1600 + 2000;
    expect(new DOMMatrixReadOnly(getComputedStyle(glyph).transform).m42).toBeCloseTo(0, 3);

    // Once both have played out the cue stays, still and at rest.
    entry!.finish();
    drift!.finish();
    expect(drift!.playState).toBe("finished");
    expect(getComputedStyle(glyph).transform).toBe("none");
    // Nothing is left in effect to hold the glyph on its own compositor layer.
    expect(glyph.getAnimations()).toEqual([]);
    expect(glyph.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })).toBe(true);
  });

  it("stays, still, when the guest asks for less motion — and still hides on scroll", async () => {
    await emulate({ reducedMotion: "reduce" });
    await page.viewport(...PHONE);
    const { cue, glyph } = await mount(InviteHeader, invite());

    // Nothing is finished by hand here: the global clamp lands the entry on
    // its end state and runs the drift out at once.
    await vi.waitFor(() => expect(getComputedStyle(glyph).opacity).toBe("1"));
    expect(glyph.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })).toBe(true);
    expect(glyph.getAnimations().filter((a) => a.playState === "running")).toEqual([]);
    // The drift animates `transform`, so this is the property that would move.
    expect(getComputedStyle(glyph).transform).toBe("none");

    scrollPageTo(200);
    await vi.waitFor(() => expect(getComputedStyle(cue).opacity).toBe("0"));
  });
});

/**
 * The first-visit consent prompt over the hero, at the sizes where the old
 * bottom banner covered the couple's name or put the cue on it — gala's
 * two-name title at 375x667 and 390x844, classic's at 320x568 — plus a
 * landscape phone and a desktop, where it covered gala's title too.
 *
 * The prompt is a modal dialog at every width, so it publishes nothing into
 * the page: the cue rests on the hero's foot, and once the guest answers
 * nothing sits over the hero at all.
 */
describe.each(PACKS)("%s hero under the consent prompt", (_pack, InviteHeader) => {
  const twoNames = () => invite({ title: "Alexandra Konstantinou & Maximilian Featherstone" });

  const overlaps = (a: DOMRect, b: DOMRect) =>
    !(a.bottom <= b.top || a.top >= b.bottom || a.right <= b.left || a.left >= b.right);

  /** The centre of the part of `rect` on screen, or null when none of it is. */
  const visibleCentre = (rect: DOMRect) => {
    const left = Math.max(rect.left, 0);
    const right = Math.min(rect.right, window.innerWidth);
    const top = Math.max(rect.top, 0);
    const bottom = Math.min(rect.bottom, window.innerHeight);
    return left < right && top < bottom ? { x: (left + right) / 2, y: (top + bottom) / 2 } : null;
  };

  describe.each([
    { name: "320x568 phone", size: [320, 568] as Viewport },
    { name: "375x667 phone", size: [375, 667] as Viewport },
    { name: "390x844 phone", size: PHONE },
    { name: "844x390 landscape phone", size: [844, 390] as Viewport },
    { name: "1440x900 desktop", size: DESKTOP },
  ])("on a $name", ({ size }) => {
    it("asks in a dialog that leaves the cue at rest, and nothing over the hero once answered", async () => {
      await page.viewport(...size);
      const { hero, cue, glyph, titleBlock } = await mount(InviteHeader, twoNames());
      const { entry, drift } = animationsOf(glyph);
      entry!.finish();
      await nextFrame();
      await nextFrame();

      // The prompt's island hydrates after the hero has painted. Nothing in
      // the page's flow may move as it arrives: the dialog is in the top
      // layer, and this fails if it is ever rendered in flow or reserves
      // space in the page.
      const shifts: LayoutShift[] = [];
      const shiftObserver = new PerformanceObserver((list) => {
        shifts.push(...(list.getEntries() as LayoutShift[]));
      });
      shiftObserver.observe({ type: "layout-shift" });
      render(() => <ConsentBanner />);
      const prompt = await vi.waitFor(() => {
        const found = document.querySelector("dialog");
        if (!found?.matches(":modal")) throw new Error("the consent prompt has not opened");
        return found;
      });
      await nextFrame();
      await nextFrame();
      shifts.push(...(shiftObserver.takeRecords() as LayoutShift[]));
      shiftObserver.disconnect();
      expect(shifts.map((s) => s.value)).toEqual([]);
      expect(consentPanel()).toBeNull();

      // The cue rests on the hero's foot, clear of the title.
      drift!.finish();
      const resting = glyph.getBoundingClientRect();
      expect(resting.bottom).toBeCloseTo(hero.getBoundingClientRect().bottom - rootPx(), 0);
      expect(overlaps(resting, titleBlock.getBoundingClientRect())).toBe(false);

      // Answered: the dialog goes, and whatever is painted over the title and
      // the cue — the parts of them on screen; a tall title can push the cue
      // below the fold of a landscape phone — is the hero's own.
      within(prompt).getByText("Accept necessary").click();
      await vi.waitFor(() => expect(document.querySelector("dialog")).toBeNull());
      expect(consentPanel()).toBeNull();
      const title = visibleCentre(titleBlock.getBoundingClientRect());
      expect(title).not.toBeNull();
      const onScreen = [title, visibleCentre(glyph.getBoundingClientRect())].filter(
        (point) => point !== null,
      );
      for (const point of onScreen) {
        expect(hero.contains(document.elementFromPoint(point.x, point.y))).toBe(true);
      }
      expect(cue.dataset.scrollCue).toBe("shown");
    });
  });
});
