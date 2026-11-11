import { cleanup, render, screen } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { commands } from "vitest/browser";

import "../../src/styles/global.css";

/**
 * The command palette's arrival, as the engine runs it (`DESIGN.md` §4, The
 * command palette fades up). It fades up through the page from its centre —
 * no sideways offset at any frame, as the nav sheet's slide had — on
 * `--dur-base` with `--ease-out`, and its scrim fades in on the same clock.
 * It has no exit: Kobalte holds a closing dialog mounted only while an
 * animation runs on it, so the palette and its scrim leave in one frame.
 * Under reduced motion it appears at once. happy-dom runs no animation, so
 * none of this is visible to the fast tier.
 */

vi.mock("../../src/lib/touch-feedback", () => ({
  haptic: () => {},
  hapticsAvailable: () => false,
}));

import CommandPalette from "../../src/components/CommandPalette";
import type { WeddingSummary } from "../../src/components/CreateWeddingForm";

const RUTH: WeddingSummary = {
  id: "wed_1",
  slug: "ruth-and-vik",
  displayName: "Ruth & Vik",
  role: "owner",
  entitlements: [],
  guestCap: 100,
};

afterEach(async () => {
  cleanup();
  await commands.emulateMedia({ reducedMotion: "no-preference" });
});

/** Mounts the palette open, with a setter to close it. */
function mount() {
  const [open, setOpen] = createSignal(true);
  render(() => (
    <CommandPalette
      open={open()}
      onOpenChange={setOpen}
      wedding={RUTH}
      weddings={[RUTH]}
      onModule={() => {}}
      onWedding={() => {}}
      onAll={() => {}}
      onSecurity={() => {}}
      onSignOut={() => {}}
    />
  ));
  return setOpen;
}

/** The open panel and the scrim drawn behind it. */
async function parts() {
  const panel = await screen.findByRole("dialog", { name: "Command palette" });
  // Kobalte's portal holds the overlay, then the centring wrapper round the panel.
  const scrim = panel.parentElement!.previousElementSibling as HTMLElement;
  expect(scrim.hasAttribute("data-expanded")).toBe(true);
  return { panel, scrim };
}

/** A token resolved through the stylesheet, as an animation longhand reads it. */
function resolved(property: "animationDuration" | "animationTimingFunction", token: string) {
  const probe = document.createElement("div");
  probe.style[property] = `var(${token})`;
  document.body.append(probe);
  const value = getComputedStyle(probe)[property];
  probe.remove();
  return value;
}

/** Holds every animation on `element` at its first frame. */
function firstFrame(element: HTMLElement) {
  const running = element.getAnimations();
  expect(running.length).toBeGreaterThan(0);
  for (const animation of running) {
    animation.pause();
    animation.currentTime = 0;
  }
  return getComputedStyle(element);
}

describe("the command palette's arrival", () => {
  it("rises from below its place with no sideways offset, transparent at the first frame", async () => {
    mount();
    const { panel } = await parts();
    const style = firstFrame(panel);
    const matrix = new DOMMatrixReadOnly(style.transform);
    expect(matrix.m41).toBe(0);
    expect(matrix.m42).toBeGreaterThan(0);
    expect(matrix.a).toBeLessThan(1);
    expect(matrix.a).toBeGreaterThan(0.95);
    expect(Number.parseFloat(style.opacity)).toBeLessThan(1);
    // From its own centre: a modal is not anchored to the trigger that opened it.
    const [x, y] = style.transformOrigin.split(" ").map(Number.parseFloat);
    expect(x).toBeCloseTo(panel.offsetWidth / 2, 0);
    expect(y).toBeCloseTo(panel.offsetHeight / 2, 0);
  });

  it("runs the panel and the scrim on --dur-base with --ease-out", async () => {
    mount();
    const { panel, scrim } = await parts();
    for (const part of [panel, scrim]) {
      const style = getComputedStyle(part);
      expect(style.animationDuration).toBe(resolved("animationDuration", "--dur-base"));
      expect(style.animationTimingFunction).toBe(resolved("animationTimingFunction", "--ease-out"));
    }
    const scrimStart = firstFrame(scrim);
    expect(Number.parseFloat(scrimStart.opacity)).toBeLessThan(1);
  });

  it("leaves in one frame, panel and scrim together", async () => {
    const setOpen = mount();
    const { panel, scrim } = await parts();
    await Promise.all([...panel.getAnimations(), ...scrim.getAnimations()].map((a) => a.finished));
    setOpen(false);
    await new Promise(requestAnimationFrame);
    expect(panel.isConnected).toBe(false);
    expect(scrim.isConnected).toBe(false);
  });

  it("appears at once under reduced motion", async () => {
    await commands.emulateMedia({ reducedMotion: "reduce" });
    mount();
    const { panel, scrim } = await parts();
    for (const part of [panel, scrim]) {
      expect(Number.parseFloat(getComputedStyle(part).animationDuration)).toBeLessThan(0.001);
    }
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
    expect(getComputedStyle(panel).opacity).toBe("1");
    expect(getComputedStyle(panel).transform).toBe("none");
  });
});
