import { contrastRatio, WCAG_TEXT_MIN } from "@cire/theme";
import { cleanup, render } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { commands } from "vitest/browser";

import "../styles/global.css";

/**
 * The two things about this panel that only a real engine can answer.
 *
 * **1. Is the mandatory-column ink actually readable?** The fast tier can assert
 * the chip carries `text-gold-ink` and not `text-gold-dim`. It cannot assert
 * that the class emitted any CSS at all (Tailwind ignores an unknown class
 * silently), that it won the cascade against the `classList` branch beside it,
 * or — the part that made the old chips unreadable — what the ink contrasts
 * against once `bg-gold/12` over `bg-surface/30` over the page has been
 * composited. Every one of those needs a stylesheet and a compositor.
 *
 * `tokens.test.ts` measures the *tokens* and is the right place for that. This
 * measures what an organiser's screen ends up with.
 *
 * **2. Does the first-run glow exist?** `attention-glow` is a hand-written
 * `@utility`, so it is exactly the kind of class that can be renamed in
 * `global.css` and go on "passing" as a string in the DOM forever. And its
 * reduced-motion behaviour is the global clamp in `global.css`, which needs the
 * cascade plus media emulation to observe.
 */

vi.mock("@shared/rp-auth/solid", () => ({ useAuth: () => ({ authFetch: vi.fn() }) }));
vi.mock("../lib/api", () => ({
  apiUrl: (path: string) => `https://api.test${path}`,
  isAuthExpired: () => false,
  redirectToLogin: () => {},
}));

import { resetImportHelpSeen } from "../lib/import-help";
import ImportPanel from "./ImportPanel";

/**
 * The colour an element is painted ON — every ancestor background composited in
 * paint order, bottom-up, ending at the element's own.
 *
 * Done on a canvas rather than by hand because the canvas composites the way the
 * browser does (source-over, in the device space) and, more importantly, parses
 * whatever syntax `getComputedStyle` hands back. Tailwind's `/12` opacity
 * modifier computes to a `color-mix(…)` result, which Chrome serialises as
 * `oklab(… / .12)` — a form no colour parser in this repo reads, and one that
 * will change again the next time the CSS Color spec moves. `ctx.fillStyle`
 * accepts all of it and hands back plain `rgb`.
 */
function paintedBackdrop(element: Element): string {
  const layers: string[] = [];
  for (let node: Element | null = element; node; node = node.parentElement) {
    const bg = getComputedStyle(node).backgroundColor;
    if (bg && bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent") layers.push(bg);
  }
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext("2d")!;
  // Bottom-up: the outermost ancestor was collected last.
  for (const layer of layers.toReversed()) {
    ctx.fillStyle = layer;
    ctx.fillRect(0, 0, 1, 1);
  }
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
  return `rgb(${r}, ${g}, ${b})`;
}

/** The ink an element is painted IN, composited over its own backdrop — the
 *  portal's ink tokens are routinely translucent, and a ratio measured against
 *  an uncomposited colour is a ratio for a colour nobody sees. */
function paintedInk(element: Element): string {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = paintedBackdrop(element);
  ctx.fillRect(0, 0, 1, 1);
  ctx.fillStyle = getComputedStyle(element).color;
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
  return `rgb(${r}, ${g}, ${b})`;
}

function ratioOn(element: Element): number {
  return contrastRatio(paintedInk(element), paintedBackdrop(element))!;
}

/** The `Event Name` chip — a required column, and the first one rendered. */
const mandatoryChip = () =>
  [...document.querySelectorAll("code")].find((c) =>
    (c.textContent ?? "").startsWith("Event Name"),
  )!;

/** `Location` — an optional column, for the contrast floor on the muted half. */
const optionalChip = () =>
  [...document.querySelectorAll("code")].find((c) => (c.textContent ?? "").trim() === "Location")!;

/** The `@keyframes` rule by name, straight off the generated stylesheet. */
function keyframeRule(name: string): CSSKeyframesRule | undefined {
  const rules = [...document.styleSheets].flatMap((sheet) => Array.from(sheet.cssRules));
  return rules.find(
    (rule): rule is CSSKeyframesRule => rule instanceof CSSKeyframesRule && rule.name === name,
  );
}

const helpDisclosure = () =>
  [...document.querySelectorAll("details")].find((d) =>
    /csv format/i.test(d.querySelector("summary")?.textContent ?? ""),
  )!;

beforeEach(() => {
  resetImportHelpSeen();
});

afterEach(async () => {
  cleanup();
  // The browser context is shared across tests in this file — a leaked
  // preference silently changes every assertion after it.
  await commands.emulateMedia({ colorScheme: "no-preference", reducedMotion: "no-preference" });
});

describe("ImportPanel — mandatory column chips, as painted", () => {
  for (const scheme of ["dark", "light"] as const) {
    it(`puts the mandatory chip's ink over 4.5:1 in the ${scheme} ramp`, async () => {
      await commands.emulateMedia({ colorScheme: scheme });
      render(() => <ImportPanel weddingId="wed_a" kind="events" />);

      const ratio = ratioOn(mandatoryChip());
      // The failure message carries the number, because "expected true to be
      // false" tells whoever broke this nothing about how far off they are.
      expect(ratio, `mandatory chip ink measured ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(
        WCAG_TEXT_MIN,
      );
    });

    it(`keeps the optional chip readable too in the ${scheme} ramp`, async () => {
      await commands.emulateMedia({ colorScheme: scheme });
      render(() => <ImportPanel weddingId="wed_a" kind="events" />);

      const ratio = ratioOn(optionalChip());
      expect(ratio, `optional chip ink measured ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(
        WCAG_TEXT_MIN,
      );
    });
  }

  it("distinguishes mandatory from optional by more than a colour swap", () => {
    // WCAG 1.4.1: the two kinds must differ where colour is unavailable. The
    // chips differ in ink AND ground AND border AND a literal `*` — this pins
    // the two that survive greyscale and a screen reader respectively.
    render(() => <ImportPanel weddingId="wed_a" kind="events" />);
    const mandatory = mandatoryChip();
    const optional = optionalChip();

    expect(getComputedStyle(mandatory).color).not.toBe(getComputedStyle(optional).color);
    expect(paintedBackdrop(mandatory)).not.toBe(paintedBackdrop(optional));
    expect(mandatory.textContent).toContain("*");
    expect(optional.textContent).not.toContain("*");
  });

  it("edges the mandatory chip differently from an optional one", () => {
    // The chip's gold hairline is DECORATION, and this test says so on purpose.
    // Measured, it lands around 1.5:1 against the card behind it — nowhere near
    // the 3:1 non-text floor, and it should not be held to it: WCAG 1.4.11 asks
    // that for boundaries carrying information a user needs to identify a
    // component or its state, and nothing here depends on seeing this edge. What
    // marks a column mandatory is the `*` and the `sr-only` word (asserted
    // above); the ink and the tint are the visual reinforcement. Chasing 3:1 on
    // a 1px chip border would darken the whole panel to guard a cue that isn't
    // doing the work. What IS worth pinning is that the required branch applied
    // at all — the two `classList` arms differ in border as well as ink, so an
    // arm that silently stopped matching shows up here.
    render(() => <ImportPanel weddingId="wed_a" kind="events" />);
    const mandatory = getComputedStyle(mandatoryChip());
    const optional = getComputedStyle(optionalChip());
    expect(Number.parseFloat(mandatory.borderTopWidth)).toBeGreaterThan(0);
    expect(mandatory.borderTopColor).not.toBe(optional.borderTopColor);
  });
});

describe("ImportPanel — the first-run glow, as animated", () => {
  it("runs a real, finite animation on the guide's first appearance", () => {
    render(() => <ImportPanel weddingId="wed_a" kind="guests" />);
    // The animation lives on the `::after` ring, not the box — see the
    // compositor note in `global.css`. `getComputedStyle(el, "::after")` is the
    // only way to see it, and it is a thing happy-dom cannot report at all.
    const ring = getComputedStyle(helpDisclosure(), "::after");

    // The name proves `@utility attention-glow` emitted CSS and matched — a
    // renamed utility leaves the class in the DOM and the animation absent.
    expect(ring.animationName).toBe("attention-glow");
    expect(Number.parseFloat(ring.animationDuration)).toBeGreaterThan(0);
    // Finite on purpose: a permanent pulse stops being a signal.
    expect(ring.animationIterationCount).toBe("3");
  });

  it("animates opacity ONLY — the property the compositor can take", () => {
    // The whole point of the pseudo-element (P-W1): an animated `box-shadow`
    // re-paints and re-rasters the open guide — the tallest box on screen —
    // every frame for 7.8s, on the same thread that has to scroll it. A static
    // shadow faded by `opacity` is rastered once and composited on the GPU. If
    // a future edit moves the shadow back into the keyframes this fails.
    render(() => <ImportPanel weddingId="wed_a" kind="guests" />);
    const keyframes = keyframeRule("attention-glow")!;
    expect(keyframes).toBeTruthy();
    expect(keyframes.cssText).toContain("opacity");
    expect(keyframes.cssText).not.toContain("box-shadow");

    // And the ring itself must be out of the layout and untouchable, or it would
    // shift the guide and eat its clicks.
    const ring = getComputedStyle(helpDisclosure(), "::after");
    expect(ring.position).toBe("absolute");
    expect(ring.pointerEvents).toBe("none");
  });

  it("emits a shadow rather than a border or an outline", () => {
    // Load-bearing choice: a box-shadow can't fight the element's own border
    // utility, doesn't move anything, and leaves the focus ring's space free.
    render(() => <ImportPanel weddingId="wed_a" kind="guests" />);
    expect(getComputedStyle(helpDisclosure()).outlineStyle).toBe("none");
    const ring = getComputedStyle(helpDisclosure(), "::after");
    expect(ring.boxShadow).not.toBe("none");
    // Zero WIDTH, not `border-style: none` — Tailwind's preflight sets
    // `border-style: solid` on `*, ::before, ::after` and zeroes the width, so
    // the style alone says nothing about whether a border is drawn.
    expect(Number.parseFloat(ring.borderTopWidth)).toBe(0);
  });

  it("is silenced by prefers-reduced-motion", async () => {
    await commands.emulateMedia({ reducedMotion: "reduce" });
    render(() => <ImportPanel weddingId="wed_a" kind="guests" />);
    // The clamp targets `*::after` as well as `*`, which is exactly why the ring
    // could be moved into a pseudo-element without losing it.
    const ring = getComputedStyle(helpDisclosure(), "::after");

    // The global clamp in `global.css` — one iteration, effectively zero
    // duration. The guide is still expanded, which is the actual affordance.
    expect(Number.parseFloat(ring.animationDuration)).toBeLessThan(0.001);
    expect(ring.animationIterationCount).toBe("1");
    expect(helpDisclosure().open).toBe(true);
  });

  it("does not glow once the guide has been met", () => {
    render(() => <ImportPanel weddingId="wed_a" kind="guests" />);
    cleanup();
    render(() => <ImportPanel weddingId="wed_a" kind="guests" />);
    // No `attention-glow` class ⇒ no `::after` rule ⇒ no ring at all, rather
    // than a ring sitting at opacity 0 waiting to be revealed by a stray style.
    const ring = getComputedStyle(helpDisclosure(), "::after");
    expect(ring.animationName).toBe("none");
    expect(ring.content).toBe("none");
  });
});
