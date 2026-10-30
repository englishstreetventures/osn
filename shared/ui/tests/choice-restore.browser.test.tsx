/**
 * Two guarantees the choice parts keep beyond a plain client render.
 *
 * A page the browser restores — a reload, a back navigation the cache missed —
 * can tick an input before the page hydrates, and hydration writes no property.
 * Each part puts the caller's value back once mounted, so a box never shows a
 * state the caller does not hold; that matters most for a consent box. The
 * tests flip the input from a sibling that runs after the part is built and
 * before anything mounts, which is where a restored state sits.
 *
 * And a Windows contrast theme drops `box-shadow` and repaints backgrounds in
 * system colours, so the drawn parts draw focus with an outline there, and the
 * drawn radio's dot and the switch's thumb stay visible.
 */

import { cleanup, render, screen } from "@solidjs/testing-library";
import { createRenderEffect } from "solid-js";
import { afterEach, describe, expect, it } from "vitest";
import { commands, userEvent } from "vitest/browser";

import { Checkbox } from "../src/ui/checkbox";
import { RadioGroup, RadioGroupItem } from "../src/ui/radio-group";
import { Switch } from "../src/ui/switch";

import "./test-support/tailwind.css";

type Media = { forcedColors?: "active" | "none" };
const emulate = (media: Media) =>
  (commands as unknown as { emulateMedia: (m: Media) => Promise<void> }).emulateMedia(media);

afterEach(async () => {
  cleanup();
  await emulate({ forcedColors: "none" });
});

/** Ticks every box and chooses every radio already built inside `holder`, before mount. */
function Restore(props: { holder: () => HTMLElement | undefined }) {
  createRenderEffect(() => {
    for (const input of props.holder()?.querySelectorAll("input") ?? []) input.checked = true;
  });
  return null;
}

describe("a state the browser put back before mount", () => {
  it("gives way to the caller's value, for every part and box", () => {
    let holder: HTMLDivElement | undefined;
    render(() => (
      <div ref={holder}>
        <Checkbox checked={false} label="Drawn" />
        <Checkbox box="native" checked={false} label="Native" />
        <Switch checked={false} label="Switch" />
        <RadioGroup box="native" value="a" aria-label="Pick">
          <RadioGroupItem value="a" label="A" />
          <RadioGroupItem value="b" label="B" />
        </RadioGroup>
        <Restore holder={() => holder} />
      </div>
    ));
    const states = [...holder!.querySelectorAll("input")].map((i) => i.checked);
    expect(states).toEqual([false, false, false, true, false]);
  });
});

describe("a contrast theme", () => {
  it("draws keyboard focus on the drawn box, circle and track as an outline", async () => {
    await emulate({ forcedColors: "active" });
    render(() => (
      <>
        <Checkbox checked={false} onChange={() => {}} label="Box" />
        <RadioGroup value="a" aria-label="Pick">
          <RadioGroupItem value="a" label="Circle" />
        </RadioGroup>
        <Switch checked={false} label="Track" />
      </>
    ));
    for (const name of ["Box", "Circle", "Track"]) {
      await userEvent.tab();
      const painted = (document.activeElement as HTMLElement).nextElementSibling!;
      const s = getComputedStyle(painted);
      expect([name, s.outlineStyle, s.outlineWidth]).toEqual([name, "solid", "2px"]);
    }
  });

  it("keeps the chosen radio's dot apart from the circle", async () => {
    await emulate({ forcedColors: "active" });
    render(() => (
      <RadioGroup value="a" aria-label="Pick">
        <RadioGroupItem value="a" label="Chosen" />
      </RadioGroup>
    ));
    const circle = screen.getByRole("radio").nextElementSibling as HTMLElement;
    const dot = getComputedStyle(circle.firstElementChild!, "::after");
    expect(dot.backgroundColor).not.toBe(getComputedStyle(circle).backgroundColor);
  });

  it("keeps the switch's thumb apart from its track, on or off", async () => {
    await emulate({ forcedColors: "active" });
    render(() => (
      <>
        <Switch checked={false} label="Off" />
        <Switch checked label="On" />
      </>
    ));
    for (const name of ["Off", "On"]) {
      const track = screen.getByRole("switch", { name }).nextElementSibling as HTMLElement;
      const thumb = getComputedStyle(track.firstElementChild!);
      expect([name, thumb.backgroundColor === getComputedStyle(track).backgroundColor]).toEqual([
        name,
        false,
      ]);
    }
  });
});
