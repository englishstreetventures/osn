import { cleanup, render, within } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";

import "../../../src/styles/global.css";
import { ConsentBanner } from "../../../src/components/consent/ConsentBanner";
import { readConsentFromDocument } from "../../../src/lib/consent/cookie";
import { resetConsentForTest } from "../../../src/lib/consent/testing";

/**
 * The first-layer consent prompt in a real engine: a modal dialog below the
 * `md` breakpoint, the bottom banner from it up.
 *
 * `ConsentBanner.test.tsx` covers what the component decides — which form
 * shows, what each answer records, that a dismissal is not an answer — with a
 * stubbed `matchMedia` and a dispatched `close`. What it cannot see is
 * anything the platform does: the real media query and its `change` as the
 * window is resized, `showModal()`'s top layer, where focus lands and what it
 * can reach, a real Escape and a real backdrop tap, and whether the two
 * answers the guest weighs against each other are painted as equals.
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
 * `close` is fired from an element task, not a microtask, so the dismissal has
 * not reached `Modal`'s listener when the next line runs. A zero timeout is
 * the smallest thing that lands after it.
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
    if (!element) throw new Error("the prompt has not opened");
    return element;
  });
  await new Promise(requestAnimationFrame);
  await Promise.allSettled(found.getAnimations({ subtree: true }).map((a) => a.finished));
  return found;
}

const centre = (rect: DOMRect) => ({
  x: (rect.left + rect.right) / 2,
  y: (rect.top + rect.bottom) / 2,
});

beforeEach(resetConsentForTest);

afterEach(async () => {
  cleanup();
  resetConsentForTest();
  await page.viewport(...DEFAULT);
});

describe("on a phone", () => {
  it("asks in a modal dialog, with nothing at the foot of the screen", async () => {
    await page.viewport(...PHONE);
    render(() => <ConsentBanner />);
    const prompt = await openPrompt();

    expect(prompt.matches(":modal")).toBe(true);
    expect(banner()).toBeNull();
  });

  it("opens on its heading and keeps focus inside itself", async () => {
    await page.viewport(...PHONE);
    const { getByText } = render(() => (
      <>
        <button type="button">Behind the prompt</button>
        <ConsentBanner />
      </>
    ));
    const prompt = await openPrompt();

    // Neither answer holds focus when it opens: a focused "Accept all" is a
    // nudge.
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
    for (let i = 0; i < 4; i++) {
      await userEvent.keyboard("{Tab}");
      expect(prompt.contains(document.activeElement)).toBe(true);
      visited.push((document.activeElement?.textContent ?? "").trim());
    }
    expect(visited).toEqual(["Privacy notice", "Reject all", "Accept all", "Choose"]);
  });

  it("turns into the banner on Escape, and records nothing", async () => {
    await page.viewport(...PHONE);
    render(() => <ConsentBanner />);
    await openPrompt();

    // A real Escape: a dispatched `KeyboardEvent` is ignored by a modal
    // dialog, and `requestClose()` runs out of close-watcher budget once a
    // suite has opened a few dialogs without user activation.
    await userEvent.keyboard("{Escape}");
    await afterTheCloseEvent();

    expect(readConsentFromDocument()).toBeNull();
    expect(dialog()).toBeNull();
    await vi.waitFor(() => expect(banner()).not.toBeNull());
  });

  it("turns into the banner on a tap outside it, and records nothing", async () => {
    await page.viewport(...PHONE);
    render(() => <ConsentBanner />);
    const prompt = await openPrompt();
    const box = prompt.getBoundingClientRect();
    // A bottom sheet: the backdrop is everything above it.
    expect(box.top).toBeGreaterThan(20);

    // The backdrop is a pseudo-element and cannot be an event target, so a
    // tap on it arrives with the dialog as `target`, outside its own box.
    prompt.dispatchEvent(
      new MouseEvent("click", { bubbles: true, clientX: box.left + 10, clientY: box.top - 20 }),
    );
    await afterTheCloseEvent();

    expect(readConsentFromDocument()).toBeNull();
    expect(dialog()).toBeNull();
    await vi.waitFor(() => expect(banner()).not.toBeNull());
  });

  describe.each([
    { name: "phone", size: PHONE },
    { name: "narrow phone", size: NARROW_PHONE },
  ])("at $name width", ({ size }) => {
    it("paints 'Reject all' as the equal of 'Accept all', on the same row and first", async () => {
      await page.viewport(...size);
      render(() => <ConsentBanner />);
      const prompt = await openPrompt();
      const reject = within(prompt).getByText("Reject all").closest("button")!;
      const accept = within(prompt).getByText("Accept all").closest("button")!;
      const r = reject.getBoundingClientRect();
      const a = accept.getBoundingClientRect();

      // Not width: each button is as wide as its own label.
      expect(r.top).toBe(a.top);
      expect(r.height).toBe(a.height);
      expect(r.right).toBeLessThanOrEqual(a.left);

      const looks = (el: HTMLElement) => {
        const s = getComputedStyle(el);
        return [
          s.fontFamily,
          s.fontSize,
          s.fontWeight,
          s.textTransform,
          s.color,
          s.backgroundColor,
          s.borderTopColor,
          s.borderTopWidth,
          s.paddingTop,
          s.paddingLeft,
        ];
      };
      expect(looks(reject)).toEqual(looks(accept));
    });

    it("keeps its privacy notice link on screen and reachable", async () => {
      await page.viewport(...size);
      render(() => <ConsentBanner />);
      const prompt = await openPrompt();
      const link = prompt.querySelector<HTMLAnchorElement>('a[href="/privacy"]')!;
      const rect = link.getBoundingClientRect();

      expect(rect.top).toBeGreaterThanOrEqual(0);
      expect(rect.bottom).toBeLessThanOrEqual(window.innerHeight);
      const point = centre(rect);
      expect(link.contains(document.elementFromPoint(point.x, point.y))).toBe(true);
    });
  });

  it("follows the window across the breakpoint, both ways", async () => {
    await page.viewport(...PHONE);
    render(() => <ConsentBanner />);
    await openPrompt();

    await page.viewport(...DESKTOP);
    await vi.waitFor(() => expect(banner()).not.toBeNull());
    expect(dialog()).toBeNull();

    await page.viewport(...PHONE);
    await openPrompt();
    expect(banner()).toBeNull();
  });

  it("stays the banner where the page asks for it", async () => {
    await page.viewport(...PHONE);
    render(() => <ConsentBanner phone="banner" />);

    await vi.waitFor(() => expect(banner()).not.toBeNull());
    expect(dialog()).toBeNull();
  });
});

describe("on a desktop", () => {
  it("is the banner, with no dialog", async () => {
    await page.viewport(...DESKTOP);
    render(() => <ConsentBanner />);

    await vi.waitFor(() => expect(banner()).not.toBeNull());
    expect(dialog()).toBeNull();
  });
});
