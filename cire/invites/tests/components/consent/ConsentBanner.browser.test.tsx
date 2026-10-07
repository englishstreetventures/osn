import { cleanup, render, within } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";

import "../../../src/styles/global.css";
import { ConsentBanner } from "../../../src/components/consent/ConsentBanner";
import { readConsentFromDocument } from "../../../src/lib/consent/cookie";
import { resetConsentForTest } from "../../../src/lib/consent/testing";

/**
 * The first-layer consent prompt in a real engine: on the invite's pages a
 * modal dialog the guest has to answer, at every width; on the legal pages the
 * bottom banner.
 *
 * `ConsentBanner.test.tsx` covers what the component decides — which form
 * shows, what each answer records, that a refused `cancel` stays refused and a
 * forced close brings the dialog straight back — with dispatched events. What
 * it cannot see is anything the platform does: `showModal()`'s top layer,
 * `closedby`, a real Escape, where focus lands and what it can reach, and
 * whether the highlighted answer is painted as the highlighted one.
 */

type Viewport = readonly [width: number, height: number];

const PHONE: Viewport = [390, 844];
/** The Reflow floor (WCAG 1.4.10), where three buttons are likeliest to wrap. */
const NARROW_PHONE: Viewport = [320, 568];
const DESKTOP: Viewport = [1440, 900];
/** The tester iframe's own default, restored after every test. */
const DEFAULT: Viewport = [414, 896];

const banner = () => document.querySelector<HTMLElement>('section[aria-label="Privacy choices"]');
const dialog = () => document.querySelector("dialog");

/**
 * `close` is fired from an element task, not a microtask, so a close has not
 * reached `Modal`'s listener when the next line runs. A zero timeout is the
 * smallest thing that lands after it.
 */
const afterTheCloseEvent = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * The prompt's dialog once it is open and its entry has played. `Modal` enters
 * from `translateY(24px) scale(0.98)`, and a box read mid-flight is that far
 * off. A frame first, so the transition has started before it is awaited.
 */
async function openPrompt(): Promise<HTMLDialogElement> {
  const found = await vi.waitFor(() => {
    const element = dialog();
    if (!element?.matches(":modal")) throw new Error("the prompt has not opened");
    return element;
  });
  await new Promise(requestAnimationFrame);
  await Promise.allSettled(found.getAnimations({ subtree: true }).map((a) => a.finished));
  return found;
}

/** The centre of the part of `rect` inside the viewport. */
const visibleCentre = (rect: DOMRect) => ({
  x: (Math.max(rect.left, 0) + Math.min(rect.right, window.innerWidth)) / 2,
  y: (Math.max(rect.top, 0) + Math.min(rect.bottom, window.innerHeight)) / 2,
});

beforeEach(resetConsentForTest);

afterEach(async () => {
  cleanup();
  resetConsentForTest();
  await page.viewport(...DEFAULT);
});

describe.each([
  { name: "phone", size: PHONE },
  { name: "desktop", size: DESKTOP },
])("the prompt on a $name", ({ size }) => {
  it("is a modal dialog, with nothing at the foot of the screen", async () => {
    await page.viewport(...size);
    render(() => <ConsentBanner />);
    await openPrompt();

    expect(banner()).toBeNull();
  });

  it("opens on its heading and keeps focus inside itself", async () => {
    await page.viewport(...size);
    const { getByText } = render(() => (
      <>
        <button type="button">Behind the prompt</button>
        <ConsentBanner />
      </>
    ));
    const prompt = await openPrompt();

    // No answer holds focus when it opens: a focused answer is a nudge.
    expect(document.activeElement?.tagName).toBe("H2");
    expect(prompt.contains(document.activeElement)).toBe(true);

    // The page behind cannot take focus while the prompt is up.
    const behind = getByText("Behind the prompt");
    behind.focus();
    expect(document.activeElement).not.toBe(behind);

    // Tab walks the prompt's own controls, in reading order. Past the last
    // one, focus leaves the document for the browser, which no assertion
    // here can follow.
    const visited: string[] = [];
    for (let i = 0; i < 5; i++) {
      await userEvent.keyboard("{Tab}");
      expect(prompt.contains(document.activeElement)).toBe(true);
      visited.push((document.activeElement?.textContent ?? "").trim());
    }
    expect(visited).toEqual([
      "Privacy notice",
      "Terms",
      "Accept necessary",
      "Accept all",
      "Choose",
    ]);
  });

  it("keeps both legal links on screen and reachable", async () => {
    await page.viewport(...size);
    render(() => <ConsentBanner />);
    const prompt = await openPrompt();

    for (const href of ["/privacy", "/terms"]) {
      const link = prompt.querySelector<HTMLAnchorElement>(`a[href="${href}"]`)!;
      const rect = link.getBoundingClientRect();
      expect(rect.top).toBeGreaterThanOrEqual(0);
      expect(rect.bottom).toBeLessThanOrEqual(window.innerHeight);
      const point = visibleCentre(rect);
      expect(link.contains(document.elementFromPoint(point.x, point.y))).toBe(true);
    }
  });
});

describe("nothing but an answer closes the prompt", () => {
  it("ignores Escape — the close request never reaches it", async () => {
    await page.viewport(...PHONE);
    render(() => <ConsentBanner />);
    const before = await openPrompt();
    let cancels = 0;
    before.addEventListener("cancel", () => cancels++);

    // A real Escape: a dispatched `KeyboardEvent` is ignored by a modal
    // dialog. `closedby="none"` keeps the request away from the dialog
    // altogether, so not even a `cancel` is fired; refusing the `cancel` is the
    // fallback for an engine without `closedby`, and the unit tier covers it.
    await userEvent.keyboard("{Escape}");
    await afterTheCloseEvent();
    await userEvent.keyboard("{Escape}");
    await afterTheCloseEvent();

    expect(cancels).toBe(0);
    expect(dialog()).toBe(before);
    expect(before.matches(":modal")).toBe(true);
    expect(readConsentFromDocument()).toBeNull();
    expect(banner()).toBeNull();
  });

  it("ignores a click outside it", async () => {
    await page.viewport(...PHONE);
    render(() => <ConsentBanner />);
    const before = await openPrompt();
    const box = before.getBoundingClientRect();
    // A bottom sheet: the backdrop is everything above it.
    expect(box.top).toBeGreaterThan(20);

    // Dispatched rather than driven: the backdrop is a pseudo-element and
    // cannot be an event target, so a click on it arrives with the dialog as
    // `target`, outside the panel's own box — which is what this reproduces.
    before.dispatchEvent(
      new MouseEvent("click", { bubbles: true, clientX: box.left + 10, clientY: box.top - 20 }),
    );
    await afterTheCloseEvent();

    expect(dialog()).toBe(before);
    expect(before.matches(":modal")).toBe(true);
    expect(readConsentFromDocument()).toBeNull();
  });

  it("opens again at once, on its heading, if the browser closes it anyway", async () => {
    // Where `closedby` is not supported, a browser that will not let the
    // `cancel` be refused closes the dialog regardless.
    await page.viewport(...PHONE);
    render(() => <ConsentBanner />);
    const before = await openPrompt();

    before.close();
    await afterTheCloseEvent();

    const after = await openPrompt();
    expect(after).not.toBe(before);
    expect(document.activeElement?.tagName).toBe("H2");
    expect(after.contains(document.activeElement)).toBe(true);
    expect(readConsentFromDocument()).toBeNull();
    expect(banner()).toBeNull();
  });

  it("closes on an answer, and does not come back", async () => {
    await page.viewport(...PHONE);
    render(() => <ConsentBanner />);
    const prompt = await openPrompt();

    within(prompt).getByText("Accept necessary").click();
    await afterTheCloseEvent();

    expect(dialog()).toBeNull();
    expect(readConsentFromDocument()?.grants.embeds).toBe(false);
  });
});

describe.each([
  { name: "narrow phone", size: NARROW_PHONE },
  { name: "phone", size: PHONE },
  { name: "desktop", size: DESKTOP },
])("the answers on a $name", ({ size }) => {
  it("paint 'Accept necessary' first and highlighted, the other two alike", async () => {
    await page.viewport(...size);
    render(() => <ConsentBanner />);
    const prompt = await openPrompt();
    const button = (label: string) => within(prompt).getByText(label).closest("button")!;
    const necessary = button("Accept necessary");
    const all = button("Accept all");
    const choose = button("Choose");

    // First in reading order: above "Accept all", or level with it and to its
    // left. Not "on the same row": a long label in a wide organiser font may
    // wrap, and that is fine so long as the order holds.
    const n = necessary.getBoundingClientRect();
    const a = all.getBoundingClientRect();
    expect(n.top <= a.top && (n.top < a.top || n.right <= a.left)).toBe(true);
    // One size of button for all three; nothing is shrunk to be missed.
    expect(n.height).toBe(a.height);
    expect(choose.getBoundingClientRect().height).toBe(a.height);
    const panel = prompt.getBoundingClientRect();
    for (const rect of [n, a, choose.getBoundingClientRect()]) {
      expect(rect.left).toBeGreaterThanOrEqual(panel.left);
      expect(rect.right).toBeLessThanOrEqual(panel.right);
    }

    const looks = (el: HTMLElement) => {
      const s = getComputedStyle(el);
      return {
        font: [s.fontFamily, s.fontSize, s.fontWeight, s.textTransform],
        box: [s.paddingTop, s.paddingLeft, s.borderTopWidth],
        colour: [s.color, s.borderTopColor, s.backgroundColor],
      };
    };
    // "Accept all" and "Choose" are painted exactly alike.
    expect(looks(choose)).toEqual(looks(all));
    // "Accept necessary" shares their type and box, and is set apart by colour.
    expect(looks(necessary).font).toEqual(looks(all).font);
    expect(looks(necessary).box).toEqual(looks(all).box);
    expect(looks(necessary).colour[0]).not.toBe(looks(all).colour[0]);
    expect(looks(necessary).colour[1]).not.toBe(looks(all).colour[1]);
  });
});

describe("the legal pages' banner", () => {
  it.each([
    { name: "phone", size: PHONE },
    { name: "desktop", size: DESKTOP },
  ])("is the banner, with no dialog, on a $name", async ({ size }) => {
    await page.viewport(...size);
    render(() => <ConsentBanner prompt="banner" />);

    await vi.waitFor(() => expect(banner()).not.toBeNull());
    expect(dialog()).toBeNull();
  });
});
