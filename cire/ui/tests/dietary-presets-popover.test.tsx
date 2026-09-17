import { type DietaryPreset } from "@cire/dietary";
import "@testing-library/jest-dom/vitest";
// @vitest-environment happy-dom
import { cleanup, render, screen } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import DietaryPresetsPopover from "../src/dietary-presets-popover";

/*
 * The popover shell: the same fields, collapsed behind a trigger.
 *
 * happy-dom answers `matchMedia` from a 1024px window, so the default here is
 * already the wide shell — but which shell renders is a real fork, so
 * {@link mockViewport} states it either way rather than relying on that.
 *
 * The popover's own behaviour — placement, dismiss, focus return — is Kobalte's
 * and is tested in `@shared/ui`. What matters here is that the trigger names the
 * selection, and that a narrow viewport falls back to the fields inline.
 */

/**
 * Pin the viewport the shell asks about.
 *
 * A whole `MediaQueryList` rather than `{ matches }` alone: the shell subscribes
 * with `addEventListener`, and a stub without one throws at mount.
 */
function mockViewport(wide: boolean) {
  const original = window.matchMedia;
  window.matchMedia = ((query: string) => ({
    matches: wide,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
    addListener: () => {},
    removeListener: () => {},
  })) as typeof window.matchMedia;
  return () => {
    window.matchMedia = original;
  };
}

function Harness(props: { initial?: readonly DietaryPreset[] }) {
  const [value, setValue] = createSignal<readonly DietaryPreset[]>(props.initial ?? []);
  return <DietaryPresetsPopover value={value()} onChange={setValue} label="Dietary requirements" />;
}

let restoreViewport = () => {};
afterEach(() => {
  restoreViewport();
  restoreViewport = () => {};
  cleanup();
});

describe("DietaryPresetsPopover", () => {
  beforeEach(() => {
    restoreViewport = mockViewport(true);
  });

  it("collapses to a trigger rather than sixteen pills across the form", () => {
    render(() => <Harness />);
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
    expect(screen.getByRole("button", { name: /add dietary requirements/i })).toBeTruthy();
  });

  it("names the current selection on the closed trigger", () => {
    // A closed control that says only "Dietary requirements" makes a guest open
    // it to find out what they already picked, every single time.
    render(() => <Harness initial={["vegetarian", "nuts"]} />);
    expect(screen.getByRole("button", { name: /vegetarian, nuts/i })).toBeTruthy();
  });

  it("truncates a long selection so the trigger cannot outgrow its row", () => {
    render(() => <Harness initial={["vegetarian", "nuts", "gluten", "egg"]} />);
    expect(screen.getByRole("button", { name: /vegetarian, nuts \+2/i })).toBeTruthy();
  });

  it("disables the trigger when the form is locked", () => {
    render(() => <DietaryPresetsPopover value={[]} onChange={() => {}} disabled />);
    expect((screen.getByRole("button") as HTMLButtonElement).disabled).toBe(true);
  });

  it("falls back to the fields inline on a narrow viewport", () => {
    // Below the breakpoint there is no trigger to press: answering is a tap, and
    // a control you must open first is a tap spent before you can start.
    restoreViewport();
    restoreViewport = mockViewport(false);
    render(() => <Harness />);
    expect(screen.getAllByRole("checkbox").length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: /add dietary requirements/i })).toBeNull();
  });
});
