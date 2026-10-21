/**
 * Where the switch stands its pill, and whether it eases there.
 *
 * The pill and the on-gold words over it are drawn from one custom property,
 * `--seg-progress`, and `data-dragging` takes their easing away. jsdom paints
 * neither; `EventSheet.browser.test.tsx` ("the switch follows a swipe")
 * measures the pill those values draw. This tier holds the values themselves.
 */
import { cleanup, render, within } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, describe, expect, it } from "vitest";

import { PanelSwitch, type SwitchPanel } from "../../src/components/PanelSwitch";

afterEach(cleanup);

function group(): HTMLElement {
  return within(document.body).getByRole("group", { name: "Event sheet" });
}

const progress = () => group().style.getPropertyValue("--seg-progress");

describe("PanelSwitch", () => {
  it.each([
    ["details", "0"],
    ["rsvp", "1"],
  ] as const)("stands the pill under %s before anything moves", (selected, at) => {
    // A sheet opened on the form shows its pill there from the first paint,
    // rather than sliding it across from Details as the sheet opens.
    render(() => <PanelSwitch selected={selected} rsvpLabel="Respond" onPress={() => {}} />);
    expect(progress()).toBe(at);
    expect(group().hasAttribute("data-dragging")).toBe(false);
  });

  it("eases the pill to the segment chosen, and back", () => {
    const [selected, setSelected] = createSignal<SwitchPanel>("details");
    render(() => <PanelSwitch selected={selected()} rsvpLabel="Respond" onPress={() => {}} />);

    setSelected("rsvp");
    expect({ at: progress(), dragging: group().hasAttribute("data-dragging") }).toEqual({
      at: "1",
      dragging: false,
    });

    setSelected("details");
    expect({ at: progress(), dragging: group().hasAttribute("data-dragging") }).toEqual({
      at: "0",
      dragging: false,
    });
  });
});
