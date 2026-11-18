/**
 * How `Badge` draws when no app sets its weight, held exactly: every computed
 * style it carries that a plain `<div>` beside it does not, for each variant in
 * each treatment, at rest.
 *
 * pulse draws this Badge on every event card, venue carousel and event and
 * series page, and maps none of the type tokens, so this file is what lets a
 * change to Badge claim that pulse's badges do not move. It imports only
 * `Badge` and its props type, so it runs on the code before such a change as
 * well as after it, and the snapshot beside it was written by the code before.
 * Rewriting that snapshot with `-u` changes how pulse draws a badge: do it only
 * in a pull request that says so in its body and that the owner approves.
 *
 * The plain div is a baseline, not a filter: a property that matches it before
 * and after a change matches in both dumps, and any other change shows up as a
 * key added, removed or altered. Each entry also checks that the dump holds the
 * weight and the custom property the weight utility sets, since a dump that
 * silently left custom properties out would hide a change made through one.
 *
 * The badges carry no text, so no width or height comes from a platform font.
 */

import { cleanup, render, screen } from "@solidjs/testing-library";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { commands } from "vitest/browser";

import { Badge, type BadgeProps } from "../src/ui/badge";

import "./test-support/tailwind.css";

type Variant = NonNullable<BadgeProps["variant"]>;
type Treatment = NonNullable<BadgeProps["treatment"]>;

// Keyed objects rather than arrays, so a variant or treatment added to `Badge`
// without a line here is a type error rather than a look nobody holds.
const VARIANTS = Object.keys({
  default: 1,
  secondary: 1,
  destructive: 1,
  outline: 1,
} satisfies Record<Variant, 1>) as Variant[];
const TREATMENTS = Object.keys({ default: 1, eyebrow: 1 } satisfies Record<
  Treatment,
  1
>) as Treatment[];

const CASES = VARIANTS.flatMap((variant) =>
  TREATMENTS.map((treatment) => ({ variant, treatment })),
);

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

/** Every computed property of `element`, plus any of `names` it does not enumerate. */
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

describe("Badge with no weight token set", () => {
  it.each(CASES)("$variant, treatment $treatment, at rest", ({ variant, treatment }) => {
    render(() => (
      <div>
        <Badge variant={variant} treatment={treatment} data-testid="target" />
        <div data-testid="plain" />
      </div>
    ));
    const target = screen.getByTestId("target");
    const plain = screen.getByTestId("plain");
    settle();
    expect(matchMedia("(forced-colors: active)").matches).toBe(false);
    const ours = readStyle(target);
    const dump = differences(ours, readStyle(plain, ours.keys()));

    expect(Object.keys(dump)).toContain("font-weight");
    expect(Object.keys(dump)).toContain("--tw-font-weight");
    expect(dump).toMatchSnapshot("computed style");
  });
});
