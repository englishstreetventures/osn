/**
 * `Button` in a Windows contrast theme (forced colours), which drops the
 * box-shadow ring that marks keyboard focus everywhere else. There a focused
 * button has to draw an outline the theme can paint, and only while focused
 * from the keyboard: an outline at rest would ring every button on the page,
 * which marks nothing.
 *
 * Under Chromium's forced-colours emulation, so the theme's own repaint is what
 * is measured. `button-default.browser.test.tsx` holds the look outside it.
 */

import { cleanup, render, screen } from "@solidjs/testing-library";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { commands, page, userEvent } from "vitest/browser";

import { Button, buttonVariants, type ButtonProps } from "../src/ui/button";
import { Checkbox } from "../src/ui/checkbox";

import "./test-support/tailwind.css";

type Variant = NonNullable<ButtonProps["variant"]>;
type Size = NonNullable<ButtonProps["size"]>;

const VARIANTS = Object.keys({
  default: 1,
  destructive: 1,
  outline: 1,
  secondary: 1,
  ghost: 1,
  ghostDanger: 1,
  link: 1,
} satisfies Record<Variant, 1>) as Variant[];
const SIZES = Object.keys({ default: 1, sm: 1, lg: 1, icon: 1, inline: 1 } satisfies Record<
  Size,
  1
>) as Size[];

/** A (variant, size) pair `Button` accepts: its props are a union, per member. */
type PairOf<P extends ButtonProps> = P extends unknown
  ? { variant: NonNullable<P["variant"]>; size: NonNullable<P["size"]> }
  : never;
type Pair = PairOf<ButtonProps>;

/** Every size at `variant`; `inline` goes with `link` only. */
const pairsAt = (variant: Variant): Pair[] =>
  SIZES.flatMap((size): Pair[] => {
    if (size === "inline") return variant === "link" ? [{ variant, size }] : [];
    if (size === "icon") return [{ variant, size }];
    return [{ variant, size }];
  });

const emulateMedia = (options: { forcedColors: "active" | "none" }) =>
  (
    commands as unknown as {
      emulateMedia: (o: { forcedColors: "active" | "none" }) => Promise<void>;
    }
  ).emulateMedia(options);

// Every test here wants the theme on, so it is set once for the file and
// restored once after it, before any other file's tests run.
beforeAll(async () => {
  await emulateMedia({ forcedColors: "active" });
});

afterAll(async () => {
  await emulateMedia({ forcedColors: "none" });
});

afterEach(() => {
  cleanup();
});

const shot = (name: string) => `__screenshots__/button.browser.test.tsx/${name}.png`;

/** The alpha of a computed colour: `rgb()` is opaque, `rgba()` names it. */
function alpha(colour: string): number {
  const match = /^rgba\((?:[^,]+,){3}\s*([\d.]+)\)$/.exec(colour);
  if (match) return Number(match[1]);
  if (colour.startsWith("rgb(")) return 1;
  throw new Error(`not a computed colour: ${colour}`);
}

/** The four values that make a focus outline seen. */
function outline(element: Element) {
  const style = getComputedStyle(element);
  return {
    style: style.outlineStyle,
    width: style.outlineWidth,
    offset: style.outlineOffset,
    colour: style.outlineColor,
  };
}

/**
 * Tab onto `target` from `from` (the plain button before it unless named), and
 * read the outline on `mark` (the target unless the mark is drawn on another
 * element) twice: at once, since a transition from a transparent colour would
 * leave nothing seen while it ran, and again with every animation finished.
 */
async function tabOnto(
  target: HTMLElement,
  { from, mark }: { from?: HTMLElement; mark?: Element } = {},
) {
  (from ?? screen.getByRole("button", { name: "Before" })).focus();
  await userEvent.keyboard("{Tab}");
  expect(matchMedia("(forced-colors: active)").matches).toBe(true);
  expect(document.activeElement).toBe(target);
  expect(target.matches(":focus-visible")).toBe(true);
  const now = outline(mark ?? target);
  for (const animation of document.getAnimations()) animation.finish();
  return { now, settled: outline(mark ?? target) };
}

/** What makes an outline seen: drawn, its width and offset, and not transparent. */
const seen = (o: ReturnType<typeof outline>) => [o.style, o.width, o.offset, alpha(o.colour) > 0];

describe("Button in a contrast theme", () => {
  for (const variant of VARIANTS) {
    it.each(pairsAt(variant))(`${variant}, size $size, outlines keyboard focus`, async (pair) => {
      render(() => (
        <div data-testid="frame" style={{ padding: "12px", display: "inline-block" }}>
          <button type="button">Before</button>
          <Button {...pair} aria-label="Target">
            {pair.size === "icon" ? "+" : "Save"}
          </Button>
        </div>
      ));
      const { now, settled } = await tabOnto(screen.getByRole("button", { name: "Target" }));
      expect(seen(now)).toEqual(["solid", "2px", "2px", true]);
      expect(settled).toEqual(now);
      if (pair.size === "default" || pair.size === "inline")
        await page.screenshot({
          path: shot(`focus-${variant}${pair.size === "inline" ? "-inline" : ""}`),
          element: screen.getByTestId("frame"),
        });
    });
  }

  it("draws no outline on any button at rest", () => {
    render(() => (
      <div>
        {VARIANTS.map((variant) => (
          <Button variant={variant}>{variant}</Button>
        ))}
      </div>
    ));
    for (const variant of VARIANTS) {
      const button = screen.getByRole("button", { name: variant });
      expect(document.activeElement).not.toBe(button);
      expect(getComputedStyle(button).outlineStyle).toBe("none");
    }
  });

  it("draws no outline on a button pressed with the pointer", async () => {
    render(() => <Button>Save</Button>);
    const button = screen.getByRole("button", { name: "Save" });
    await userEvent.click(button);
    expect(document.activeElement).toBe(button);
    expect(button.matches(":focus-visible")).toBe(false);
    expect(getComputedStyle(button).outlineStyle).toBe("none");
  });

  // The drawn Checkbox box spells its contrast-theme outline another way
  // (`outline-2`, so its colour is `currentColor`), and the theme paints the
  // two in different system colours (Chromium's emulation on macOS: the box
  // rgb(0, 0, 0), Button rgba(5, 0, 73, 0.8)). So this holds the shape of the
  // mark, not its colour.
  it("draws a focus mark of the drawn Checkbox box's shape", async () => {
    render(() => (
      <div>
        <button type="button">Before</button>
        <Checkbox checked={false} label="Florals" />
        <Button>Save</Button>
      </div>
    ));
    const input = screen.getByRole("checkbox", { name: "Florals" });
    const box = await tabOnto(input, { mark: input.nextElementSibling as Element });
    const button = await tabOnto(screen.getByRole("button", { name: "Save" }), { from: input });
    expect(seen(box.settled)).toEqual(["solid", "2px", "2px", true]);
    expect(seen(button.now)).toEqual(seen(box.settled));
  });

  it("outlines keyboard focus on an inline link that wraps", async () => {
    render(() => (
      <div data-testid="frame" style={{ padding: "12px", width: "160px" }}>
        <button type="button">Before</button>
        <p>
          See{" "}
          <a href="#recovery" class={buttonVariants({ variant: "link", size: "inline" })}>
            how to recover an account you can no longer reach
          </a>
          .
        </p>
      </div>
    ));
    const link = screen.getByRole("link");
    const { now, settled } = await tabOnto(link);
    expect(link.getClientRects().length).toBeGreaterThan(1);
    expect(seen(now)).toEqual(["solid", "2px", "2px", true]);
    expect(settled).toEqual(now);
    await page.screenshot({
      path: shot("focus-inline-wrapped"),
      element: screen.getByTestId("frame"),
    });
  });

  it("outlines keyboard focus on a link that wears `buttonVariants`", async () => {
    render(() => (
      <div>
        <button type="button">Before</button>
        <a href="#recovery" class={buttonVariants({ variant: "outline", size: "sm" })}>
          Recovery codes
        </a>
      </div>
    ));
    const { now, settled } = await tabOnto(screen.getByRole("link", { name: "Recovery codes" }));
    expect(seen(now)).toEqual(["solid", "2px", "2px", true]);
    expect(settled).toEqual(now);
  });
});
