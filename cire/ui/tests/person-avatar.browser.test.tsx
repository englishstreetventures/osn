/**
 * `PersonAvatar` and the account trigger, measured in Chromium against cire's
 * two ramps.
 *
 * Each case is one way a face can stop being the one the owner chose: an
 * initial under 4.5:1 on its disc, a letter that is not half the circle, a
 * stack ring that eats into the photo or is not the page's colour, a blank
 * disc the page shows through, and a trigger whose edge does not answer the
 * pointer or whose ring is not the house ring.
 */

import { cleanup, render, screen } from "@solidjs/testing-library";
import type { JSX } from "solid-js";
import { afterEach, describe, expect, it } from "vitest";
import { commands, userEvent } from "vitest/browser";

import PersonAvatar, { avatarTriggerClass } from "../src/person-avatar";
import { composite, inkRatio, painted } from "./test-support/paint";

import "./test-support/tailwind.css";

const RAMPS = ["dark", "light"] as const;
type Ramp = (typeof RAMPS)[number];

type MediaPreference = { reducedMotion?: "reduce" | "no-preference" };
const emulateMedia = (options: MediaPreference) =>
  (commands as unknown as { emulateMedia: (o: MediaPreference) => Promise<void> }).emulateMedia(
    options,
  );

afterEach(async () => {
  await emulateMedia({ reducedMotion: "no-preference" });
  cleanup();
});

function Ramp(props: { ramp: Ramp; children: JSX.Element; class?: string }) {
  return (
    <div
      data-ramp={props.ramp === "light" ? "light" : undefined}
      class={`bg-ui-ground flex items-center gap-4 p-4 ${props.class ?? ""}`}
    >
      {props.children}
    </div>
  );
}

function token(from: Element, name: string): string {
  return getComputedStyle(from).getPropertyValue(name).trim();
}

async function settled(el: Element) {
  await Promise.all(el.getAnimations().map((a) => a.finished));
}

describe("PersonAvatar", () => {
  for (const ramp of RAMPS) {
    it(`holds the initial at 4.5:1 on its disc, ${ramp}`, () => {
      render(() => (
        <Ramp ramp={ramp}>
          <PersonAvatar fallback="initial" name="Ada" class="size-9" />
          <PersonAvatar fallback="initial" name="Wren" class="size-10" />
        </Ramp>
      ));
      for (const letter of screen.getAllByText(/^[AW]$/)) {
        expect(inkRatio(letter)).toBeGreaterThanOrEqual(4.5);
      }
    });
  }

  it("sets the letter at half the circle's inside width, at weight 600", () => {
    render(() => (
      <Ramp ramp="dark">
        <PersonAvatar fallback="initial" name="Ada" class="size-9" />
        <PersonAvatar fallback="initial" name="Wren" class="size-10" />
      </Ramp>
    ));
    const size = (letter: string) => getComputedStyle(screen.getByText(letter));
    // 36px less its 1px edges is 34px inside, so 17px; 40px gives 19px.
    expect(parseFloat(size("A").fontSize)).toBeCloseTo(17, 1);
    expect(parseFloat(size("W").fontSize)).toBeCloseTo(19, 1);
    expect(size("A").fontWeight).toBe("600");
  });

  it("is round, with its letter centred in the display face, fading on --dur-fast", () => {
    render(() => (
      <Ramp ramp="dark">
        <PersonAvatar fallback="initial" name="Ada" class="size-9" />
      </Ramp>
    ));
    const letter = screen.getByText("A");
    const avatar = letter.closest("[aria-hidden='true']")!;
    const box = avatar.getBoundingClientRect();
    expect(parseFloat(getComputedStyle(avatar).borderTopLeftRadius)).toBeGreaterThanOrEqual(
      box.width / 2,
    );
    // The text's own box, not its span's, which fills the circle.
    const range = document.createRange();
    range.selectNodeContents(letter);
    const glyph = range.getBoundingClientRect();
    // Within 1.5px: a face's line box sits a little off its glyph's middle.
    expect(Math.abs(glyph.left + glyph.width / 2 - (box.left + box.width / 2))).toBeLessThan(1.5);
    expect(Math.abs(glyph.top + glyph.height / 2 - (box.top + box.height / 2))).toBeLessThan(1.5);
    expect(getComputedStyle(letter).fontFamily).toBe(token(letter, "--font-ui-display"));
    expect(getComputedStyle(avatar).transitionDuration).toBe("0.09s");
  });

  it("rings a face in the page's colour outside the circle, keeping the photo whole", () => {
    const { container } = render(() => (
      <Ramp ramp="dark">
        <PersonAvatar fallback="blank" ring url="https://photos.example/ring.png" class="size-7" />
      </Ramp>
    ));
    const avatar = container.querySelector("[aria-hidden='true']")!;
    // Tailwind stacks several shadows; the ring is the one spread 2px.
    const band = /((?:oklch|rgba?|color)\([^)]*\))\s+0px 0px 0px 2px/.exec(
      getComputedStyle(avatar).boxShadow,
    );
    expect(band).not.toBeNull();
    expect(painted(band![1]!)).toBe(painted(token(avatar, "--ui-ground")));
    // The photo's box is the circle's: the band adds nothing inside it.
    const photo = avatar.firstElementChild!.getBoundingClientRect();
    expect([photo.width, photo.height]).toEqual([28, 28]);
  });

  for (const ramp of RAMPS) {
    it(`paints the blank disc opaque, with the figure in the page's colour, ${ramp}`, () => {
      const { container } = render(() => (
        <Ramp ramp={ramp}>
          <PersonAvatar fallback="blank" class="size-8" />
        </Ramp>
      ));
      const disc = container.querySelector("[data-blank-avatar]")!;
      const style = getComputedStyle(disc);
      // Opaque: over red and over black the disc's ground paints the same.
      expect(composite(["rgb(255, 0, 0)", style.backgroundColor])).toEqual(
        composite(["rgb(0, 0, 0)", style.backgroundColor]),
      );
      expect(painted(style.backgroundColor)).toBe(painted(token(disc, "--ui-ground")));
      expect(style.backgroundImage).toMatch(/^linear-gradient/);
      expect(painted(style.color)).toBe(painted(token(disc, "--ui-ground")));
    });
  }
});

describe("avatarTriggerClass", () => {
  for (const ramp of RAMPS) {
    it(`turns the avatar's edge under the pointer and draws the house ring, ${ramp}`, async () => {
      render(() => (
        <Ramp ramp={ramp}>
          <button type="button" aria-label="Account menu" class={avatarTriggerClass}>
            <PersonAvatar fallback="initial" name="Ada" class="size-full" />
          </button>
        </Ramp>
      ));
      const button = screen.getByRole("button", { name: "Account menu" });
      const avatar = button.firstElementChild!;
      expect(button.getBoundingClientRect().width).toBe(36);
      // The trigger lays the portals' 40% surface; the avatar adds no fill.
      const surface = token(button, "--ui-surface");
      expect(composite(["#000", getComputedStyle(button).backgroundColor])).toEqual(
        composite(["#000", `color-mix(in oklab, ${surface} 40%, transparent)`]),
      );
      expect(composite(["#000", getComputedStyle(avatar).backgroundColor])).toEqual([0, 0, 0]);
      for (const letter of screen.getAllByText("A")) {
        expect(inkRatio(letter)).toBeGreaterThanOrEqual(4.5);
      }
      const rest = getComputedStyle(avatar).borderTopColor;
      expect(painted(rest)).toBe(painted(token(avatar, "--ui-hairline")));
      await userEvent.hover(button);
      await settled(avatar);
      expect(painted(getComputedStyle(avatar).borderTopColor)).toBe(
        painted(token(avatar, "--ui-accent-soft")),
      );
      await userEvent.unhover(button);
      await userEvent.tab();
      expect(document.activeElement).toBe(button);
      const style = getComputedStyle(button);
      expect([style.outlineStyle, style.outlineWidth, style.outlineOffset]).toEqual([
        "solid",
        "2px",
        "2px",
      ]);
      expect(painted(style.outlineColor)).toBe(painted(token(button, "--ui-focus")));
      expect(getComputedStyle(avatar).transitionProperty).not.toMatch(/outline|all/);
    });
  }

  it("fades the edge on the app's ease-out, and not at all with reduced motion", async () => {
    render(() => (
      <Ramp ramp="dark">
        <PersonAvatar fallback="initial" name="Ada" class="size-9" />
      </Ramp>
    ));
    const avatar = screen.getByText("A").closest("[aria-hidden='true']")!;
    const squash = (value: string) => value.replace(/\s+/g, "");
    expect(getComputedStyle(avatar).transitionProperty).toBe("border-color");
    expect(squash(getComputedStyle(avatar).transitionTimingFunction)).toBe(
      squash(token(avatar, "--ease-out")),
    );
    await emulateMedia({ reducedMotion: "reduce" });
    expect(getComputedStyle(avatar).transitionProperty).toBe("none");
  });
});
