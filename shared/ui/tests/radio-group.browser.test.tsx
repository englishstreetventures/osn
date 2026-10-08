/**
 * The radio's focus ring, measured where it is painted.
 *
 * Kobalte's radio group has the checkbox's shape: a clipped real `<input>`
 * takes focus, and a sibling `<div>` is what shows. A ring keyed to the
 * `<div>`'s own `:focus-visible` never draws, so the claim is checked on
 * computed style in a real engine.
 */

import { cleanup, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it } from "vitest";
import { userEvent } from "vitest/browser";

import { RadioGroup, RadioGroupItem } from "../src/ui/radio-group";

import "./test-support/tailwind.css";

afterEach(cleanup);

/** `--ui-focus` in the test palette (`test-support/tailwind.css`). */
const FOCUS = "rgb(47, 75, 216)";

/** The painted circle beside the radio named `label`. */
function circleOf(label: string): HTMLElement {
  const input = screen.getByRole("radio", { name: label });
  return input.nextElementSibling as HTMLElement;
}

function Choice(props: { onChange?: (value: string) => void }) {
  return (
    <RadioGroup value="email" onChange={props.onChange} aria-label="Contact by">
      <RadioGroupItem value="email" label="Email" />
      <RadioGroupItem value="sms" label="SMS" />
    </RadioGroup>
  );
}

describe("RadioGroupItem", () => {
  it("rings the circle in the focus colour when its input takes keyboard focus", async () => {
    render(() => <Choice />);
    const circle = circleOf("Email");
    expect(getComputedStyle(circle).boxShadow).toBe("none");

    // Tab enters the group on the selected radio.
    await userEvent.tab();

    expect(document.activeElement).toBe(screen.getByRole("radio", { name: "Email" }));
    expect(getComputedStyle(circle).boxShadow).toContain(FOCUS);
    expect(getComputedStyle(circleOf("SMS")).boxShadow).toBe("none");
  });

  it("paints no ring after a pointer click, which focuses the input too", async () => {
    // A guard on the selector: a ring keyed to `:focus` would pass the test
    // above and draw on every mouse click.
    let picked: string | undefined;
    render(() => (
      <Choice
        onChange={(value) => {
          picked = value;
        }}
      />
    ));
    await userEvent.click(screen.getByText("SMS"));

    expect(picked).toBe("sms");
    expect(getComputedStyle(circleOf("SMS")).boxShadow).toBe("none");
  });
});
