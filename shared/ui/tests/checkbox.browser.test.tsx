/**
 * The checkbox's focus ring, measured where it is painted.
 *
 * Kobalte's checkbox keeps a real `<input>` for focus and semantics and clips
 * it to a 1px box; what a person sees is a sibling `<div>`. Keyboard focus
 * lands on the input, so a ring keyed to the box's own `:focus-visible` never
 * draws — the box is never focused. Only a real engine can say whether the
 * ring the input's focus asks for reaches the box, and whether a pointer click
 * leaves it off.
 */

import { cleanup, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it } from "vitest";
import { userEvent } from "vitest/browser";

import { Checkbox } from "../src/ui/checkbox";

import "./test-support/tailwind.css";

afterEach(cleanup);

/** `--ui-focus` in the test palette (`test-support/tailwind.css`). */
const FOCUS = "rgb(47, 75, 216)";

/** The painted box beside the checkbox named `label`. */
function boxOf(label: string): HTMLElement {
  const input = screen.getByRole("checkbox", { name: label });
  return input.nextElementSibling as HTMLElement;
}

describe("Checkbox", () => {
  it("rings the box in the focus colour when the input takes keyboard focus", async () => {
    render(() => <Checkbox checked={false} onChange={() => {}} label="Florals" />);
    const box = boxOf("Florals");
    expect(getComputedStyle(box).boxShadow).toBe("none");

    await userEvent.tab();

    expect(document.activeElement).toBe(screen.getByRole("checkbox", { name: "Florals" }));
    expect(getComputedStyle(box).boxShadow).toContain(FOCUS);
  });

  it("paints no ring after a pointer click, which focuses the input too", async () => {
    // A guard on the selector rather than the defect: a ring keyed to `:focus`
    // instead of `:focus-visible` would pass the test above and draw a ring on
    // every mouse click.
    let checked = false;
    render(() => (
      <Checkbox
        checked={false}
        onChange={(next) => {
          checked = next;
        }}
        label="Catering"
      />
    ));
    await userEvent.click(screen.getByText("Catering"));

    expect(checked).toBe(true);
    expect(getComputedStyle(boxOf("Catering")).boxShadow).toBe("none");
  });
});
