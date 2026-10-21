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
