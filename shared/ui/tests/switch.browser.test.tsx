/**
 * The switch, measured where its state is actually shown.
 *
 * A switch says "on" or "off" with nothing but paint: the thumb's position and
 * the track's colour. The unit tier can confirm `aria-checked` and a class
 * string and cannot tell whether either class emitted a rule, so every claim
 * below is made against computed style and layout in real Chromium.
 */

import { cleanup, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it } from "vitest";
import { commands, userEvent } from "vitest/browser";

import { Switch } from "../src/ui/switch";

import "./test-support/tailwind.css";

type MotionPreference = { reducedMotion: "reduce" | "no-preference" };
const emulateMedia = (options: MotionPreference) =>
  (commands as unknown as { emulateMedia: (o: MotionPreference) => Promise<void> }).emulateMedia(
    options,
  );

afterEach(async () => {
  cleanup();
  await emulateMedia({ reducedMotion: "no-preference" });
});

/** The track and thumb of the switch named `label`. */
function partsOf(label: string): { track: HTMLElement; thumb: HTMLElement } {
  const input = screen.getByRole("switch", { name: label });
  const track = input.nextElementSibling as HTMLElement;
  return { track, thumb: track.firstElementChild as HTMLElement };
}

/** Where the thumb sits inside its track, once any transition has finished. */
async function thumbOffset(label: string): Promise<number> {
  const { track, thumb } = partsOf(label);
  await Promise.all(thumb.getAnimations().map((a) => a.finished));
  return thumb.getBoundingClientRect().left - track.getBoundingClientRect().left;
}

describe("Switch", () => {
  it("moves the thumb to the far end when on", async () => {
    render(() => (
      <>
        <Switch checked={false} label="off" />
        <Switch checked label="on" />
      </>
    ));
    const off = await thumbOffset("off");
    const on = await thumbOffset("on");
    // The track is 36px wide and the thumb 14px: the thumb travels most of the
    // difference, not a pixel or two a stray rule could explain.
    expect(on - off).toBeGreaterThanOrEqual(14);
  });

  it("paints on and off in different track colours", () => {
    render(() => (
      <>
        <Switch checked={false} label="off" />
        <Switch checked label="on" />
      </>
    ));
    const off = getComputedStyle(partsOf("off").track).backgroundColor;
    const on = getComputedStyle(partsOf("on").track).backgroundColor;
    expect(on).not.toBe(off);
    expect(on).toBe("rgb(47, 75, 216)"); // --ui-accent in the test palette
  });

  it("paints read-only exactly as the live control, because the state is the content", () => {
    render(() => (
      <>
        <Switch checked label="live" />
        <Switch checked readOnly label="read-only" />
      </>
    ));
    const live = partsOf("live");
    const readOnly = partsOf("read-only");
    for (const prop of ["backgroundColor", "opacity"] as const) {
      expect(getComputedStyle(readOnly.track)[prop]).toBe(getComputedStyle(live.track)[prop]);
      expect(getComputedStyle(readOnly.thumb)[prop]).toBe(getComputedStyle(live.thumb)[prop]);
    }
    expect(getComputedStyle(readOnly.track).cursor).toBe("default");
    expect(getComputedStyle(live.track).cursor).toBe("pointer");
  });

  it("dims a disabled switch", () => {
    render(() => <Switch checked disabled label="disabled" />);
    expect(Number(getComputedStyle(partsOf("disabled").track).opacity)).toBeLessThan(1);
  });

  it("rings the track when the hidden input takes keyboard focus", async () => {
    render(() => <Switch checked={false} label="focus me" />);
    const { track } = partsOf("focus me");
    expect(getComputedStyle(track).boxShadow).toBe("none");
    await userEvent.tab();
    expect(document.activeElement).toBe(screen.getByRole("switch", { name: "focus me" }));
    expect(getComputedStyle(track).boxShadow).not.toBe("none");
  });

  it("toggles on Space from the keyboard", async () => {
    let asked: boolean | null = null;
    render(() => (
      <Switch
        checked={false}
        label="space"
        onChange={(next) => {
          asked = next;
        }}
      />
    ));
    await userEvent.tab();
    await userEvent.keyboard(" ");
    expect(asked).toBe(true);
  });

  it("drops the thumb's transition under reduced motion", async () => {
    await emulateMedia({ reducedMotion: "reduce" });
    render(() => <Switch checked label="still" />);
    const { track, thumb } = partsOf("still");
    expect(getComputedStyle(thumb).transitionProperty).toBe("none");
    expect(getComputedStyle(track).transitionProperty).toBe("none");
  });
});
