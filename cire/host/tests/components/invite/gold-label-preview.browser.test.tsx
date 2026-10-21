import { derivePalette, PALETTE_PRESETS } from "@cire/theme";
import { cleanup, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it } from "vitest";

import "../../../src/styles/global.css";
import { SectionSample } from "../../../src/components/invite/previews";
import PaletteField from "../../../src/components/PaletteField";

/*
 * The organiser's two previews of the guest's gold "Respond" button paint it
 * the way the guest site does: the scheme's gold, with the derived on-gold
 * label.
 *
 * The portal has an `--color-on-gold` of its own, and each preview reads the
 * invite's from the derived token map on its wrapper. A chip that kept the
 * page colour, or fell through to the portal's ink, would show an organiser a
 * button their guests never see — cream on brass on chapel, where the guest
 * site writes near-black. Read back as painted colours, because the inline
 * `var()` strings say nothing about which declaration wins.
 */

/** A colour as Chromium resolves it, so a `var()` chain and an `oklch()` compare. */
function paint(value: string): string {
  const probe = document.createElement("div");
  probe.style.color = value;
  document.body.append(probe);
  const resolved = getComputedStyle(probe).color;
  probe.remove();
  return resolved;
}

function respondChip(within: HTMLElement): HTMLElement {
  return [...within.querySelectorAll("span")].find((s) => s.textContent?.trim() === "Respond")!;
}

afterEach(() => cleanup());

describe.each(["chapel", "garden"] as const)("on the %s scheme", (preset) => {
  const tokens = derivePalette(PALETTE_PRESETS[preset]);

  it("the colour-scheme preview paints the guest's gold button", () => {
    render(() => <PaletteField value={{ preset, seeds: {} }} onChange={() => {}} />);
    const chip = getComputedStyle(
      respondChip(screen.getByRole("figure", { name: "Colour scheme preview" })),
    );
    expect(chip.backgroundColor).toBe(paint(tokens["--color-gold"]));
    expect(chip.color).toBe(paint(tokens["--color-on-gold"]));
  });

  it("the events-section sample paints the guest's gold button", () => {
    const { container } = render(() => (
      <div style={tokens}>
        <SectionSample
          surface="var(--color-bg)"
          heading="Your Events"
          body="Your events."
          card={{ name: "Ceremony", meta: "Saturday, 4pm" }}
        />
      </div>
    ));
    const chip = getComputedStyle(respondChip(container));
    expect(chip.backgroundColor).toBe(paint(tokens["--color-gold"]));
    expect(chip.color).toBe(paint(tokens["--color-on-gold"]));
  });
});
