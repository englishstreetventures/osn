import { contrastRatio, WCAG_TEXT_MIN } from "@cire/theme";
import { cleanup, render, screen, waitFor, within } from "@solidjs/testing-library";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { commands } from "vitest/browser";

import "../../src/styles/global.css";

/**
 * The section nav's hidden labels, as painted.
 *
 * A hidden section's label is faded and marked with an eye-off icon. The fade
 * sits under the 4.5:1 WCAG 1.4.3 asks of text this small — the owner's choice,
 * with the icon as the cue that is not colour and the accessible name carrying
 * the state (see `FADED_LABEL` in `src/components/invite/fields.tsx`). What
 * this pins is the floor that choice rests on: every faded label, and so the
 * icon drawn in its ink, clears 3:1 (the WCAG 1.4.11 floor for a graphic), and
 * the icon actually paints. The fast tier proves the classes and the icon are
 * there; only a stylesheet and a compositor can say what they paint over the
 * sticky bar, the menu panel, the gold wash and the page.
 *
 * It mounts the real builder, so what is measured is what the nav renders, on
 * the ancestors it really has.
 */

// Declared inline, as `ImportPanel.browser.test.tsx` does: the browser runner
// cannot resolve a factory that imports `../test-support/mocks`.
const { authFetchMock } = vi.hoisted(() => ({ authFetchMock: vi.fn() }));
vi.mock("@shared/rp-auth/solid", () => ({ useAuth: () => ({ authFetch: authFetchMock }) }));
vi.mock("@shared/toast", () => ({ toast: { success: () => {}, error: () => {} } }));
vi.mock("../../src/lib/api", async () => {
  const actual = await vi.importActual<typeof import("../../src/lib/api")>("../../src/lib/api");
  return {
    ...actual,
    apiUrl: (path: string) => `https://api.test${path}`,
    isAuthExpired: () => false,
    redirectToLogin: () => {},
  };
});
vi.mock("@cire/invite-designs", () => ({
  DESIGNS: [{ id: "classic", name: "Classic", tier: "free" }],
  DEFAULT_DESIGN_ID: "classic",
}));

import InviteBuilder from "../../src/components/invite/InviteBuilder";

/** Every switchable section empty, so Hero, Our Story and Closing are hidden. */
const EMPTY_CUSTOMISATION = {
  designId: "classic",
  hero: { title: null, subtitle: null, imageUrl: null },
  story: { eyebrow: null, heading: null, body: null, imageUrl: null },
  heroDisplay: { blur: 28, titleBackdrop: { opacity: 0, blur: 0 } },
  theme: {
    headingFont: null,
    bodyFont: null,
    palettePreset: null,
    palette: { ground: null, card: null, ink: null, gilt: null, bloom: null },
    tones: { hero: null, story: null, details: null, welcome: null },
  },
};

/**
 * The colour an element is painted ON — every ancestor background composited
 * in paint order, bottom-up. On a canvas because it composites the way the
 * browser does and parses whatever `getComputedStyle` hands back, including the
 * `oklab(… / .12)` that Tailwind's `/12` modifier computes to. Same method as
 * `ImportPanel.browser.test.tsx`.
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
  for (const layer of layers.toReversed()) {
    ctx.fillStyle = layer;
    ctx.fillRect(0, 0, 1, 1);
  }
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
  return `rgb(${r}, ${g}, ${b})`;
}

/** The ink an element is painted IN, composited over its own backdrop. */
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

const ratioOn = (element: Element) => contrastRatio(paintedInk(element), paintedBackdrop(element))!;

/**
 * Transitions off, for this file only. It measures colours, not motion, and a
 * transition makes a reading depend on timing: every element carries one under
 * the reduced-motion rule in `global.css`, so a label's inherited ink can still
 * be on its old value after its tab has settled on the new one. Appended after
 * the imported stylesheet, so it wins the tie between two `!important` rules.
 */
beforeAll(() => {
  const style = document.createElement("style");
  style.textContent = "*, *::before, *::after { transition-property: none !important; }";
  document.head.append(style);
});

/** Let a class change reach the page: two frames. */
const settle = () =>
  new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );

async function mountAt(width: number) {
  authFetchMock.mockResolvedValueOnce(
    new Response(JSON.stringify(EMPTY_CUSTOMISATION), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
  render(() => (
    <div style={{ width: `${width}px` }}>
      <InviteBuilder weddingId="wed_1" weddingSlug="anita-ben" entitlements={[]} />
    </div>
  ));
  await waitFor(() => screen.getByText("Save invite"));
  await settle();
}

const tab = (name: string | RegExp) => screen.getByRole("tab", { name });
/** A tab's visible label: the text span, whichever of its children it is. */
const labelOf = (name: string | RegExp, text: RegExp) => within(tab(name)).getByText(text);
const iconIn = (element: Element) => element.querySelector("[data-hidden-icon]");
const fmt = (n: number) => `${n.toFixed(2)}:1`;

/** The floor a faded label, and the icon drawn in its ink, must still clear. */
const FADED_MIN = 3;

/** Asserts a painted ratio clears `min`, naming it and the ratio on failure. */
function expectContrast(element: Element, min: number, what: string) {
  const ratio = ratioOn(element);
  expect(ratio, `${what} measured ${fmt(ratio)}`).toBeGreaterThanOrEqual(min);
}

/** Asserts the eye-off icon is inside `element`, drawn at a real size, and as
 *  legible as a graphic needs to be. */
function expectIcon(element: Element, what: string) {
  const icon = iconIn(element);
  expect(icon, `${what}: eye-off icon`).not.toBeNull();
  const box = icon!.getBoundingClientRect();
  expect(box.width, `${what}: icon width`).toBeGreaterThan(8);
  expectContrast(icon!, FADED_MIN, `${what} icon`);
}

afterEach(async () => {
  cleanup();
  authFetchMock.mockReset();
  // The browser context is shared across tests in this file — a leaked
  // preference silently changes every assertion after it.
  await commands.emulateMedia({ colorScheme: "no-preference" });
});

describe("InviteBuilder section nav — hidden labels, as painted", () => {
  for (const scheme of ["dark", "light"] as const) {
    it(`fades the tab row's hidden labels to no less than 3:1, with the icon, ${scheme}`, async () => {
      await commands.emulateMedia({ colorScheme: scheme });
      // Wide enough for the static tab row (`@3xl/builder`, 48rem).
      await mountAt(1200);

      // Selected and shown, not selected and shown: readable, no icon.
      expectContrast(labelOf("Design", /^Design$/), WCAG_TEXT_MIN, "selected tab");
      expect(iconIn(tab("Design"))).toBeNull();
      expectContrast(labelOf("Welcome", /^Welcome$/), WCAG_TEXT_MIN, "idle tab");

      // Not selected and hidden: faded, over the floor, and marked.
      expectContrast(labelOf(/^Hero/, /^Hero$/), FADED_MIN, "hidden tab");
      expectIcon(tab(/^Hero/), "hidden tab");

      // Selected and hidden: on the gold wash.
      tab(/^Hero/).click();
      await settle();
      expect(tab(/^Hero/).getAttribute("aria-selected")).toBe("true");
      expectContrast(labelOf(/^Hero/, /^Hero$/), FADED_MIN, "selected hidden tab");
      expectIcon(tab(/^Hero/), "selected hidden tab");
    });

    it(`fades the menu's hidden labels to no less than 3:1, with the icon, ${scheme}`, async () => {
      await commands.emulateMedia({ colorScheme: scheme });
      // Narrow: the tabs collapse behind the trigger and open on their own
      // opaque panel, a different ground from the wide row's.
      await mountAt(480);
      const trigger = screen.getByRole("button", { name: /Choose a section/ });
      const triggerLabel = () => within(trigger).getByText(/^(Design|Hero)$/);
      expectContrast(triggerLabel(), WCAG_TEXT_MIN, "trigger label");
      expect(iconIn(trigger)).toBeNull();

      // The collapsed tablist is `display: none`, out of the accessibility
      // tree, so open the menu first, as an organiser would.
      trigger.click();
      await settle();
      expectContrast(labelOf(/^Our Story/, /^Our Story$/), FADED_MIN, "hidden tab in the menu");
      expectIcon(tab(/^Our Story/), "hidden tab in the menu");
      expectContrast(labelOf("Welcome", /^Welcome$/), WCAG_TEXT_MIN, "idle tab in the menu");

      tab(/^Hero/).click();
      await settle();
      expect(triggerLabel().textContent).toBe("Hero");
      expectContrast(triggerLabel(), FADED_MIN, "hidden trigger label");
      expectIcon(trigger, "hidden trigger label");

      // Reopen: the selected, hidden tab on the wash over the menu panel.
      if (trigger.getAttribute("aria-expanded") !== "true") {
        trigger.click();
        await settle();
      }
      expectContrast(labelOf(/^Hero/, /^Hero$/), FADED_MIN, "selected hidden tab in the menu");
      expectIcon(tab(/^Hero/), "selected hidden tab in the menu");
    });
  }
});
