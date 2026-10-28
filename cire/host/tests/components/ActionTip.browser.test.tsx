// Types only, and first: this file sorts ahead of every other test, and the
// type checker merges matcher declarations in the order it meets them. Met
// first, `vitest/browser`'s `toHaveTextContent(string | number)` would win over
// jest-dom's `(string | RegExp)` that the fast tier's tests call.
/// <reference types="@testing-library/jest-dom/vitest" />
import { cleanup, render, screen } from "@solidjs/testing-library";
import { createSignal, Show } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";

import "../../src/styles/global.css";

import { IconButton, TipLayer, TipNote, TipTrigger } from "../../src/components/ActionTip";

/**
 * One tooltip for the whole page. An icon-only control carries its name as its
 * `aria-label` and as `data-tip`; a passive badge (`TipNote`) carries its
 * explanation as hidden text and as `data-tip`. `TipLayer`, mounted once by the
 * module shell, watches the page and draws a single panel beside whichever of
 * them the pointer rests on or the keyboard reaches — so a list of 300
 * households builds no tooltip of its own per control.
 *
 * One case per way it can fail (NEW-FEAT.md §TipLayer failure list):
 *
 * 1. a mouse hover opens it only after the delay;
 * 2. a second hover within the skip window opens it at once;
 * 3. a touch never opens it;
 * 4. keyboard focus opens it at once, and a focus that follows a pointer press
 *    does not;
 * 5. Escape, a click on the control (Enter included) and a pointer press close
 *    it, leaving the control closes a hover tip, and blur a focus tip;
 * 6. a control removed while its tip is open leaves no panel behind;
 * 7. the panel sits in `<body>`, above its control, over a sticky `z-30` bar,
 *    `role="tooltip"` and `aria-hidden`, its text the label;
 * 8. `tipDisabled` shows none, and `TipTrigger` keeps its own description;
 * 9. a `TipNote` shows its text on hover, carries it as hidden text, and is no
 *    tab stop;
 * 10. a tap — whose focus arrives after the finger lifts — never shows one;
 * 11. a press before the delay cancels the pending open;
 * 12. Escape is left for whatever else listens: the layer never consumes it.
 *
 * In the browser tier because what fails is real: pointer events, focus, the
 * stacking of a panel against a sticky bar, and where Kobalte's positioner puts
 * it.
 */

afterEach(() => {
  cleanup();
});

/** The one panel, if open. `aria-hidden`, so a role query would skip it. */
const panel = () => document.querySelector<HTMLElement>("[data-tip-panel]");

const frames = (n = 2) =>
  new Promise<void>((resolve) => {
    const step = (left: number) =>
      requestAnimationFrame(() => (left <= 1 ? resolve() : step(left - 1)));
    step(n);
  });
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function opened(): Promise<HTMLElement> {
  return vi.waitFor(
    () => {
      const shown = panel();
      expect(shown).not.toBeNull();
      return shown!;
    },
    { timeout: 2_000 },
  );
}

async function closed() {
  await vi.waitFor(() => expect(panel()).toBeNull(), { timeout: 2_000 });
}

/** A page with a sticky top bar over the controls, as the portal draws it.
 *  The real pointer is parked on plain text first: it stays wherever the last
 *  test left it, which may be over one of these controls. */
async function mount(extra?: () => unknown) {
  const view = render(() => (
    <div>
      <header data-bar class="bg-bg sticky top-0 z-30 h-14 border-b">
        <span>Cire</span>
      </header>
      <div class="flex items-center gap-4 p-6 pt-4">
        <button type="button">Before</button>
        <IconButton label="Copy message" variant="quiet" size="icon">
          <span aria-hidden="true">C</span>
        </IconButton>
        <IconButton label="Allow everyone" variant="quiet" size="icon">
          <span aria-hidden="true">A</span>
        </IconButton>
        <IconButton label="Deactivate" variant="quiet" size="icon" tipDisabled>
          <span aria-hidden="true">D</span>
        </IconButton>
        <TipTrigger label="RSVPs" aria-describedby="hint">
          <span aria-hidden="true">R</span>
          <span class="sr-only">RSVPs</span>
        </TipTrigger>
        <TipNote text="A guest opened this invite">
          <span>Opened</span>
        </TipNote>
        {extra?.() as never}
      </div>
      <p id="hint" class="p-6">
        The replies, by event.
      </p>
      <TipLayer />
    </div>
  ));
  await userEvent.hover(screen.getByText("The replies, by event."));
  await wait(SKIP_MS);
  return view;
}

/** Longer than the skip window, so the next hover is a cold one. */
const SKIP_MS = 350;

const control = (name: string) => screen.getByRole("button", { name });

describe("the page's one tooltip", () => {
  it("opens on a mouse hover only after its delay", async () => {
    await page.viewport(800, 600);
    await mount();
    await userEvent.hover(control("Copy message"));
    await wait(100);
    expect(panel()).toBeNull();
    const shown = await opened();
    expect(shown.textContent).toBe("Copy message");
  });

  it("opens at once on a second hover within the skip window", async () => {
    await page.viewport(800, 600);
    await mount();
    await userEvent.hover(control("Copy message"));
    await opened();
    await userEvent.hover(control("Allow everyone"));
    await frames();
    expect(panel()?.textContent).toBe("Allow everyone");
  });

  it("never opens for a touch", async () => {
    await page.viewport(800, 600);
    await mount();
    // A finger arriving on the control and resting there: no press or lift
    // follows to close anything, so only the touch itself can refuse.
    control("Copy message").dispatchEvent(
      new PointerEvent("pointerover", { pointerType: "touch", bubbles: true, isPrimary: true }),
    );
    await wait(600);
    expect(panel()).toBeNull();
  });

  it("opens at once on keyboard focus, and not on a focus a pointer press gave", async () => {
    await page.viewport(800, 600);
    await mount();
    control("Before").focus();
    await userEvent.keyboard("{Tab}");
    expect(document.activeElement).toBe(control("Copy message"));
    await frames();
    expect(panel()?.textContent).toBe("Copy message");

    control("Before").focus();
    await closed();
    // A press that focuses the control: the pointer is on it, so no tip.
    const target = control("Allow everyone");
    target.dispatchEvent(
      new PointerEvent("pointerdown", { pointerType: "mouse", bubbles: true, isPrimary: true }),
    );
    target.focus();
    target.dispatchEvent(
      new PointerEvent("pointerup", { pointerType: "mouse", bubbles: true, isPrimary: true }),
    );
    await wait(100);
    expect(panel()).toBeNull();
  });

  it("closes on Escape, on activation, on a press, on leaving and on blur", async () => {
    await page.viewport(800, 600);
    await mount();
    const copy = control("Copy message");

    copy.focus();
    await opened();
    await userEvent.keyboard("{Escape}");
    await closed();

    control("Before").focus();
    copy.focus();
    await opened();
    await userEvent.keyboard("{Enter}");
    await closed();

    control("Before").focus();
    copy.focus();
    await opened();
    control("Before").focus();
    await closed();

    await userEvent.hover(copy);
    await opened();
    await userEvent.unhover(copy);
    await closed();

    await userEvent.hover(copy);
    await opened();
    copy.dispatchEvent(
      new PointerEvent("pointerdown", { pointerType: "mouse", bubbles: true, isPrimary: true }),
    );
    await closed();
    expect(panel()).toBeNull();
  });

  it("leaves no panel behind when its control goes", async () => {
    await page.viewport(800, 600);
    const [there, setThere] = createSignal(true);
    await mount(() => (
      <Show when={there()}>
        <IconButton label="Reactivate" variant="quiet" size="icon">
          <span aria-hidden="true">R</span>
        </IconButton>
      </Show>
    ));
    control("Reactivate").focus();
    await opened();
    setThere(false);
    await closed();
    // Hovered, with the pointer left still where the control was.
    setThere(true);
    await userEvent.hover(control("Reactivate"));
    await opened();
    setThere(false);
    await closed();
    expect(document.querySelectorAll("[data-tip-panel]")).toHaveLength(0);
  });

  it("draws one panel in <body>, above its control and over the sticky bar", async () => {
    await page.viewport(800, 600);
    const view = await mount();
    const copy = control("Copy message");
    copy.focus();
    const shown = await opened();
    await frames();
    expect(shown.getAttribute("role")).toBe("tooltip");
    expect(shown.getAttribute("aria-hidden")).toBe("true");
    expect(view.container.contains(shown)).toBe(false);
    expect(document.body.contains(shown)).toBe(true);
    expect(document.querySelectorAll("[data-tip-panel]")).toHaveLength(1);
    // Above the control, a few pixels clear of it.
    const p = shown.getBoundingClientRect();
    const c = copy.getBoundingClientRect();
    expect(p.bottom).toBeLessThanOrEqual(c.top);
    expect(c.top - p.bottom).toBeLessThanOrEqual(8);
    // It reaches up over the sticky bar, and is what is painted there.
    const bar = document.querySelector("[data-bar]")!.getBoundingClientRect();
    expect(p.top).toBeLessThan(bar.bottom);
    shown.style.pointerEvents = "auto";
    for (let el: HTMLElement | null = shown; el; el = el.parentElement) {
      el.style.pointerEvents = "auto";
    }
    const hit = document.elementFromPoint(p.left + p.width / 2, p.top + 2);
    expect(hit !== null && shown.contains(hit)).toBe(true);
  });

  it("shows nothing for a control whose tip is off, and keeps a trigger's own description", async () => {
    await page.viewport(800, 600);
    await mount();
    const off = control("Deactivate");
    off.focus();
    await userEvent.hover(off);
    await wait(600);
    expect(panel()).toBeNull();
    const tab = control("RSVPs");
    tab.focus();
    await opened();
    expect(tab.getAttribute("aria-describedby")).toBe("hint");
  });

  it("never flashes a panel for a tap, whose focus lands after the finger lifts", async () => {
    await page.viewport(800, 600);
    await mount();
    const target = control("Copy message");
    const touch = (type: string) =>
      target.dispatchEvent(
        new PointerEvent(type, { pointerType: "touch", bubbles: true, isPrimary: true }),
      );
    // Chrome's order for a tap: pointer down and up, then the compatibility
    // mouse events, at whose mousedown the focus arrives, then the click.
    touch("pointerdown");
    touch("pointerup");
    await wait(20);
    target.focus();
    await frames();
    expect(panel()).toBeNull();
    target.click();
    await wait(50);
    expect(panel()).toBeNull();
  });

  it("cancels a pending open when the control is pressed first", async () => {
    await page.viewport(800, 600);
    await mount();
    const copy = control("Copy message");
    await userEvent.hover(copy);
    await wait(100);
    copy.dispatchEvent(
      new PointerEvent("pointerdown", { pointerType: "mouse", bubbles: true, isPrimary: true }),
    );
    await wait(500);
    expect(panel()).toBeNull();
  });

  it("leaves Escape for whatever else listens", async () => {
    await page.viewport(800, 600);
    await mount();
    let prevented: boolean | undefined;
    const later = (e: KeyboardEvent) => {
      if (e.key === "Escape") prevented = e.defaultPrevented;
    };
    window.addEventListener("keydown", later);
    try {
      control("Copy message").focus();
      await opened();
      await userEvent.keyboard("{Escape}");
      await closed();
      expect(prevented).toBe(false);
    } finally {
      window.removeEventListener("keydown", later);
    }
  });

  it("shows a note's explanation on hover, which is also its hidden text, with no tab stop", async () => {
    await page.viewport(800, 600);
    await mount();
    const word = screen.getByText("Opened");
    const note = word.closest<HTMLElement>("[data-tip]")!;
    expect(note.textContent).toContain("A guest opened this invite");
    expect(note.tabIndex).toBe(-1);
    expect(note.querySelector("[tabindex], button, a")).toBeNull();
    await userEvent.hover(word);
    const shown = await opened();
    expect(shown.textContent).toBe("A guest opened this invite");
  });
});
