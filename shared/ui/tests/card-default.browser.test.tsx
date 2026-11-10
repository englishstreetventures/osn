/**
 * How `CardTitle` draws when no app sets its title weight, held exactly: every
 * computed style `CardTitle` carries that a plain `<h3>` beside it does not.
 *
 * No app maps the title weight, so this is how Musubi, the metrics dashboard
 * and the lab draw a card title, and how any app that adds one will. It
 * imports only what `card.tsx` exported before the title read a token, so it
 * runs on the code before such a change as well as after it, and the snapshot
 * beside it was written by the code before. Rewriting that snapshot with `-u`
 * changes how every app that maps nothing draws a card title: do it only in a
 * pull request that says so in its body and that the owner approves.
 *
 * The two headings sit in a plain `<div>`, not in a `Card` or a `CardHeader`.
 * `Card` paints `--ui-ink`, which the plain heading would inherit, so the
 * title's own ink would never differ and never be held. `CardHeader` spaces
 * its children with a margin on all but the last, which would land on one
 * heading and not the other. Outside both, the snapshot holds the title's own
 * classes and nothing its parents add. Both headings carry no text, so no
 * height comes from a platform font.
 */

import { cleanup, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it } from "vitest";

import { CardTitle } from "../src/ui/card";

import "./test-support/tailwind.css";

afterEach(() => {
  cleanup();
});

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

describe("CardTitle with no weight token set", () => {
  it("computes the styles it computed before the token, beside a plain heading", () => {
    render(() => (
      <div>
        <CardTitle data-testid="target" />
        {/* oxlint-disable-next-line jsx-a11y/heading-has-content -- a style baseline, never read out: empty so no height comes from a platform font. */}
        <h3 data-testid="plain" />
      </div>
    ));
    const target = screen.getByTestId("target");
    const ours = readStyle(target);
    const dump = differences(ours, readStyle(screen.getByTestId("plain"), ours.keys()));

    expect(Object.keys(dump)).toContain("font-weight");
    expect(Object.keys(dump)).toContain("--tw-font-weight");
    expect(Object.keys(dump)).toContain("color");
    expect(dump).toMatchSnapshot("computed style");
  });
});
