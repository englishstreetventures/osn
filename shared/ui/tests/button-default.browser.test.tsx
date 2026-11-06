/**
 * How `Button` draws outside a contrast theme, held exactly: every computed
 * style it carries that a plain `<button>` beside it, in the same state, does
 * not, for each variant at the default size and each size at the default
 * variant, at rest and with keyboard focus.
 *
 * pulse, musubi, `@osn/auth-ui` and the lab all draw this Button, so this file
 * is what lets a change to it claim that nothing moves outside a contrast
 * theme. It imports only `Button` and its props type, so it runs on the code
 * before such a change as well as after it, and the snapshot beside it was
 * written by the code before. Rewriting that snapshot with `-u` changes how
 * every one of those apps draws a button: do it only in a pull request that
 * says so in its body and that the owner approves.
 *
 * The plain button is a baseline, not a filter: a property that matches it
 * before and after a change matches in both dumps, and any other change shows
 * up as a key added, removed or altered. Each focused entry also checks that
 * the dump holds a custom property the ring sets, since a dump that silently
 * left custom properties out would hide a change made through one.
 *
 * The buttons carry no text, so no width or height comes from a platform font.
 */

import { cleanup, render, screen } from "@solidjs/testing-library";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { commands, userEvent } from "vitest/browser";

import { Button, type ButtonProps } from "../src/ui/button";

import "./test-support/tailwind.css";

type Variant = NonNullable<ButtonProps["variant"]>;
type Size = NonNullable<ButtonProps["size"]>;

// Keyed objects rather than arrays, so a variant or size added to `Button`
// without a line here is a type error rather than a look nobody holds.
const VARIANTS = Object.keys({
  default: 1,
  destructive: 1,
  outline: 1,
  secondary: 1,
  ghost: 1,
  ghostDanger: 1,
  link: 1,
} satisfies Record<Variant, 1>) as Variant[];
const SIZES = Object.keys({ default: 1, sm: 1, lg: 1, icon: 1 } satisfies Record<
  Size,
  1
>) as Size[];

const CASES: { variant: Variant; size: Size }[] = [
  ...VARIANTS.map((variant) => ({ variant, size: "default" as Size })),
  ...SIZES.filter((size) => size !== "default").map((size) => ({
    variant: "default" as Variant,
    size,
  })),
];

const emulateMedia = (options: { forcedColors: "active" | "none" }) =>
  (
    commands as unknown as {
      emulateMedia: (o: { forcedColors: "active" | "none" }) => Promise<void>;
    }
  ).emulateMedia(options);

beforeAll(async () => {
  await emulateMedia({ forcedColors: "none" });
});

afterEach(() => {
  cleanup();
});

/** Jump every running transition to its end, so no value is read part-way. */
function settle() {
  for (const animation of document.getAnimations()) animation.finish();
}

/**
 * Every computed property of `element`, plus any of `names` it does not
 * enumerate, read now: a focused entry reads the target and the plain button
 * one after the other, since only one of them can hold focus at a time.
 */
function readStyle(element: Element, names: Iterable<string> = []): Map<string, string> {
  const style = getComputedStyle(element);
  const out = new Map<string, string>();
  for (const name of [...Array.from(style), ...names]) out.set(name, style.getPropertyValue(name));
  return out;
}

/** Every property whose value in `ours` differs from `theirs`, with ours. */
function differences(ours: Map<string, string>, theirs: Map<string, string>) {
  const out: Record<string, string> = {};
  const names = [...new Set([...ours.keys(), ...theirs.keys()])];
  names.sort();
  for (const name of names) {
    const value = ours.get(name) ?? "";
    if (value !== (theirs.get(name) ?? "")) out[name] = value;
  }
  return out;
}

function renderCase(variant: Variant, size: Size) {
  render(() => (
    <div>
      <div data-testid="away" style={{ width: "40px", height: "40px" }} />
      <button type="button" aria-label="Before" />
      <Button variant={variant} size={size} aria-label="Target" />
      <button type="button" aria-label="Plain" />
    </div>
  ));
  return {
    away: screen.getByTestId("away"),
    target: screen.getByRole("button", { name: "Target" }),
    plain: screen.getByRole("button", { name: "Plain" }),
  };
}

describe("Button outside a contrast theme", () => {
  it.each(CASES)("$variant, size $size, at rest", async ({ variant, size }) => {
    const { away, target, plain } = renderCase(variant, size);
    await userEvent.hover(away);
    settle();
    expect(matchMedia("(forced-colors: active)").matches).toBe(false);
    expect(target.matches(":hover")).toBe(false);
    expect(document.activeElement).not.toBe(target);
    const ours = readStyle(target);
    expect(differences(ours, readStyle(plain, ours.keys()))).toMatchSnapshot("computed style");
  });

  // The plain button is read with keyboard focus too, so the browser's own
  // focus ring, whose colour the platform picks, is on both sides and drops
  // out.
  it.each(CASES)("$variant, size $size, with keyboard focus", async ({ variant, size }) => {
    const { away, target, plain } = renderCase(variant, size);
    await userEvent.hover(away);
    screen.getByRole("button", { name: "Before" }).focus();
    await userEvent.keyboard("{Tab}");
    settle();
    expect(matchMedia("(forced-colors: active)").matches).toBe(false);
    expect(document.activeElement).toBe(target);
    expect(target.matches(":focus-visible")).toBe(true);
    expect(target.matches(":hover")).toBe(false);
    const ours = readStyle(target);

    await userEvent.keyboard("{Tab}");
    settle();
    expect(document.activeElement).toBe(plain);
    expect(plain.matches(":focus-visible")).toBe(true);
    const dump = differences(ours, readStyle(plain, ours.keys()));

    expect(Object.keys(dump)).toContain("--tw-ring-shadow");
    expect(dump).toMatchSnapshot("computed style");
  });
});
