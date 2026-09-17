/**
 * Does the consent dialog paint the way its own `class` asks?
 *
 * It did not, and no string assertion anywhere could have said so. `Modal`'s
 * defaults are `base:`-prefixed — `:where(…)`, zero specificity — precisely so
 * a caller's utility wins. That only works when the caller's utility is
 * **plain**. A `base:` one ties on specificity, and a tie is resolved by
 * Tailwind's stylesheet order, which is neither the class-attribute order nor
 * anything the call site can see: `.base\:max-w-ui-sm` is emitted after
 * `.base\:max-w-lg`, so the component silently beat its own caller.
 *
 * Measured before the fix, on this dialog: 480px wide instead of 512px, and
 * painted on `--ui-surface-raised` instead of `--color-bg`, which put the
 * panel on the same colour as the `bg-surface-raised/40` category rows inside
 * it — the rows stopped reading as rows.
 *
 * This is the one surface where that matters most. It is the guest's only route
 * to withdrawing consent, and a control that reads as an undifferentiated block
 * is a control that is harder to use.
 */

import { cleanup, render } from "@solidjs/testing-library";
import { afterEach, describe, expect, it } from "vitest";

import "../../../src/styles/global.css";
import { ConsentPreferences } from "../../../src/components/consent/ConsentPreferences";
import { resetConsentForTest } from "../../../src/lib/consent/testing";

/** Paint a value and read it back, so a `var()` chain and an `oklch()` compare. */
function paint(value: string): string {
  const probe = document.createElement("div");
  probe.style.color = value;
  document.body.append(probe);
  const computed = getComputedStyle(probe).color;
  probe.remove();
  return computed;
}

describe("the consent dialog, as painted", () => {
  afterEach(() => {
    cleanup();
    resetConsentForTest();
  });

  function panel(): HTMLDialogElement {
    render(() => <ConsentPreferences />);
    return document.querySelector("dialog")!;
  }

  it("sits on the page ground it asks for, not the component's raised surface", () => {
    const style = getComputedStyle(panel());

    expect(style.backgroundColor).toBe(paint("var(--color-bg)"));
    expect(style.backgroundColor).not.toBe(paint("var(--ui-surface-raised)"));
  });

  it("is as wide as it asks to be", () => {
    // `max-w-lg` is 32rem. `Modal`'s own default is `max-w-ui-sm`, 30rem.
    expect(getComputedStyle(panel()).maxWidth).toBe("512px");
  });

  it("keeps the category rows distinguishable from the panel behind them", () => {
    // The consequence of the background defect, stated as the thing a guest
    // would notice rather than as a token name.
    const dialog = panel();
    const row = dialog
      .querySelector<HTMLElement>("input[type=checkbox]")!
      .closest("div")!.parentElement!;
    expect(getComputedStyle(row).backgroundColor).not.toBe(
      getComputedStyle(dialog).backgroundColor,
    );
  });

  it("is a bottom sheet on a phone and stays reachable", async () => {
    const dialog = panel();
    // After the entry transition, not during it. `Modal` animates in from
    // `translateY(24px)`, and `getBoundingClientRect()` reports the
    // post-transform box — read mid-flight it puts the panel 24px below the
    // viewport floor, which reads exactly like the layout bug this asserts
    // against. A frame first, because the transition has not started until the
    // initial style has been resolved.
    await new Promise(requestAnimationFrame);
    await Promise.allSettled(dialog.getAnimations({ subtree: true }).map((a) => a.finished));
    const rect = dialog.getBoundingClientRect();

    expect(rect.width).toBeGreaterThan(0);
    expect(rect.bottom).toBeLessThanOrEqual(window.innerHeight + 1);
    expect(rect.top).toBeGreaterThanOrEqual(0);
  });
});
