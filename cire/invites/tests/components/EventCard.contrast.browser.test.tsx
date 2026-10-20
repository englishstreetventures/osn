import { PALETTE_PRESET_KEYS, contrastRatio, WCAG_TEXT_MIN, WCAG_UI_MIN } from "@cire/theme";
import Button from "@cire/ui/button";
import { cleanup, render } from "@solidjs/testing-library";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { userEvent } from "vitest/browser";

import "../../src/styles/global.css";
import { EventCard } from "../../src/components/EventCard";
import { applyPaletteToRoot } from "../../src/components/invite-theme";
import type { EventSummary } from "../../src/components/types";

/**
 * Every label the event card writes on a fill, MEASURED on every built-in
 * scheme.
 *
 * `palette.test.ts` in `@cire/theme` proves the derived token pairs clear
 * 4.5:1. It cannot prove the card paints those pairs: that the label sits on
 * the fill it was measured against (the bloom fill is a SIBLING of the label,
 * not an ancestor, so nothing in the DOM says which colour is behind the
 * word), that the ink class flips with the fill, or that a hover does not
 * blend the gold into the card behind it. Each of those failures leaves every
 * class-presence test green. This reads back what Chromium painted and
 * composites it the way a guest sees it.
 */

const event: EventSummary = {
  id: "event-1",
  name: "Mehndi",
  description: "An evening of henna",
  startAt: "2026-09-18T16:00:00+10:00",
  endAt: "2026-09-18T22:00:00+10:00",
  timezone: "Australia/Sydney",
  address: "12 Banksia Lane",
  dressCodeDescription: null,
  dressCodePalette: null,
  pinterestUrl: null,
  mapsUrl: null,
  sortOrder: 0,
  imageUrl: null,
};

const noop = () => {};

/**
 * Colours painted one over another, as the 8-bit sRGB pixel the screen shows.
 * A canvas does the compositing, so a translucent layer is blended with what
 * is under it rather than measured as if it were opaque.
 */
function painted(...layers: string[]): string {
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const ctx = canvas.getContext("2d")!;
  for (const layer of layers) {
    ctx.fillStyle = layer;
    ctx.fillRect(0, 0, 1, 1);
  }
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
  return `rgb(${r}, ${g}, ${b})`;
}

function ratio(fg: string, ...bg: string[]): number {
  return contrastRatio(painted(fg), painted(...bg)) ?? 0;
}

function renderCard(props: { responded?: boolean; replied?: boolean; rsvpClosed?: boolean }) {
  return render(() => (
    <EventCard
      event={event}
      responded={props.responded}
      replied={props.replied}
      rsvpClosed={props.rsvpClosed}
      rsvpClosedNoticeId={props.rsvpClosed ? "rsvp-notice" : undefined}
      onRespond={noop}
      onDetails={noop}
    />
  ));
}

/** The card's surface, and the answer button with its two layers. */
function parts(container: HTMLElement) {
  const article = container.querySelector("article")!;
  const button = [...container.querySelectorAll("button")].find((b) =>
    ["Respond", "RSVP given"].includes(b.textContent ?? ""),
  )!;
  const fill = button.querySelector<HTMLElement>("span[aria-hidden='true']")!;
  const label = button.querySelector<HTMLElement>("span.relative")!;
  return {
    surface: getComputedStyle(article).backgroundColor,
    button,
    buttonFill: () => getComputedStyle(button).backgroundColor,
    bloom: getComputedStyle(fill).backgroundColor,
    ink: () => getComputedStyle(label).color,
  };
}

beforeAll(() => {
  // A colour read straight after a state change returns the pre-transition
  // value under `transition-colors`. How the button animates is a question for
  // `EventCard.browser.test.tsx`; this file reads settled states.
  const stop = document.createElement("style");
  stop.textContent = "*, *::before, *::after { transition: none !important; }";
  document.head.append(stop);
});

afterEach(() => {
  cleanup();
  // Back to the built-in scheme, then clear every custom property the apply
  // set, so the next preset starts from the stylesheet's own defaults.
  applyPaletteToRoot(null);
  const root = document.documentElement;
  // Copied first: removing a property shifts the live declaration's indices.
  const names = Array.from(root.style);
  for (const name of names) {
    if (name.startsWith("--")) root.style.removeProperty(name);
  }
});

describe.each(PALETTE_PRESET_KEYS)("the %s scheme", (palettePreset) => {
  const apply = () => applyPaletteToRoot({ palettePreset, headingFont: null, bodyFont: null });

  it("writes Respond in the on-gold ink at 4.5:1, at rest and on hover", async () => {
    apply();
    const { container } = renderCard({});
    const { surface, button, buttonFill, ink } = parts(container);
    expect(ratio(ink(), surface, buttonFill())).toBeGreaterThanOrEqual(WCAG_TEXT_MIN);

    await userEvent.hover(button);
    // Hover may not blend the gold with the card behind it: the measured pair
    // is the solid gold, so the fill must stay solid.
    expect(painted(surface, buttonFill())).toBe(painted(buttonFill()));
    expect(ratio(ink(), surface, buttonFill())).toBeGreaterThanOrEqual(WCAG_TEXT_MIN);
  });

  it("writes “RSVP given” and its tick on the bloom fill at 4.5:1", () => {
    apply();
    const { container } = renderCard({ responded: true });
    const { surface, button, bloom, ink } = parts(container);
    expect(button.textContent).toBe("RSVP given");
    expect(ratio(ink(), surface, bloom)).toBeGreaterThanOrEqual(WCAG_TEXT_MIN);
    const tick = button.querySelector("svg path")!;
    expect(ratio(getComputedStyle(tick).stroke, surface, bloom)).toBeGreaterThanOrEqual(
      WCAG_TEXT_MIN,
    );
    // The fill is the shape of a control on the card.
    expect(ratio(bloom, surface)).toBeGreaterThanOrEqual(WCAG_UI_MIN);
  });

  it("keeps the label readable on the closed answered card, filled and plain", () => {
    apply();
    const full = parts(renderCard({ responded: true, rsvpClosed: true }).container);
    expect(ratio(full.ink(), full.surface, full.bloom)).toBeGreaterThanOrEqual(WCAG_TEXT_MIN);
    cleanup();

    // Part of the household answered: plain gold, on-gold ink.
    const part = parts(renderCard({ replied: true, rsvpClosed: true }).container);
    expect(part.button.textContent).toBe("RSVP given");
    expect(ratio(part.ink(), part.surface, part.buttonFill())).toBeGreaterThanOrEqual(
      WCAG_TEXT_MIN,
    );
  });

  it("sets the RSVPs-closed badge in readable ink on the card", () => {
    apply();
    const { container } = renderCard({ rsvpClosed: true });
    const badge = [...container.querySelectorAll("span")].find(
      (s) => s.textContent === "RSVPs closed",
    )!;
    const { backgroundColor } = getComputedStyle(container.querySelector("article")!);
    expect(ratio(getComputedStyle(badge).color, backgroundColor)).toBeGreaterThanOrEqual(
      WCAG_TEXT_MIN,
    );
  });

  it("writes the shared primary button's label at 4.5:1 on gold, and the cta's on hover", async () => {
    // Every other gold fill on the invite comes from `@cire/ui`'s Button, which
    // reads `--ui-on-accent`; the guest site maps that to the on-gold ink.
    apply();
    const { getByRole } = render(() => (
      <div class="bg-surface-raised p-4">
        <Button variant="primary">Accept</Button>
        <Button variant="cta">Save</Button>
      </div>
    ));
    const surface = getComputedStyle(
      getByRole("button", { name: "Accept" }).parentElement!,
    ).backgroundColor;
    const primary = getComputedStyle(getByRole("button", { name: "Accept" }));
    expect(ratio(primary.color, surface, primary.backgroundColor)).toBeGreaterThanOrEqual(
      WCAG_TEXT_MIN,
    );

    const cta = getByRole("button", { name: "Save" });
    await userEvent.hover(cta);
    const hovered = getComputedStyle(cta);
    expect(ratio(hovered.color, surface, hovered.backgroundColor)).toBeGreaterThanOrEqual(
      WCAG_TEXT_MIN,
    );
  });
});
