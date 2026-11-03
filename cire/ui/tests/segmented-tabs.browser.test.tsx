/**
 * `SegmentedTabs` measured in Chromium against cire's two ramps: where the
 * glass lands, how tall the strip is whatever the font, what each label reads
 * against, the focus ring, and a strip that scrolls sideways.
 */

import { cleanup, render, screen } from "@solidjs/testing-library";
import { createSignal, type JSX } from "solid-js";
import { afterEach, describe, expect, it } from "vitest";
import { userEvent } from "vitest/browser";

import SegmentedTabs, { type SegmentedItem } from "../src/segmented-tabs";
import { backdropLayers, composite, inkRatio, ratio } from "./test-support/paint";

import "./test-support/tailwind.css";

const RAMPS = ["dark", "light"] as const;
type Ramp = (typeof RAMPS)[number];

afterEach(cleanup);

/** Long enough for a slide or a colour fade on the fallback 200ms to finish. */
const settle = (ms = 450) => new Promise((resolve) => setTimeout(resolve, ms));

function Ramp(props: { ramp: Ramp; children: JSX.Element; style?: JSX.CSSProperties }) {
  return (
    <div
      data-ramp={props.ramp === "light" ? "light" : undefined}
      class="bg-ui-ground p-4"
      style={props.style}
    >
      {props.children}
    </div>
  );
}

const FIVE: SegmentedItem<string>[] = [
  { value: "hero", label: "Hero" },
  { value: "story", label: "Our story" },
  { value: "welcome", label: "Welcome" },
  { value: "events", label: "Events" },
  { value: "closing", label: "Closing" },
];

function Strip(props: { ramp?: Ramp; initial?: string; scroll?: boolean; width?: string }) {
  const [value, setValue] = createSignal(props.initial ?? "hero");
  return (
    <Ramp ramp={props.ramp ?? "dark"} style={props.width ? { width: props.width } : undefined}>
      <SegmentedTabs
        items={FIVE}
        value={value()}
        onChange={setValue}
        label="Sections"
        semantics="tabs"
        scroll={props.scroll}
      />
    </Ramp>
  );
}

/** The glass: the one element inside the clip layer. */
function glass(): HTMLElement {
  return document.querySelector<HTMLElement>("[data-segmented-glass]")!;
}

describe("the glass", () => {
  it("lands on the chosen item after a change", async () => {
    render(() => <Strip />);
    await settle();
    await userEvent.click(screen.getByRole("tab", { name: "Events" }));
    await settle(700);
    const item = screen.getByRole("tab", { name: "Events" }).getBoundingClientRect();
    const box = glass().getBoundingClientRect();
    expect(Math.abs(box.left - item.left)).toBeLessThan(0.5);
    expect(Math.abs(box.top - item.top)).toBeLessThan(0.5);
    expect(Math.abs(box.width - item.width)).toBeLessThan(0.5);
    expect(Math.abs(box.height - item.height)).toBeLessThan(0.5);
  });

  it("shows nothing in a copy that is not displayed", async () => {
    render(() => (
      <div style={{ display: "none" }}>
        <Strip />
      </div>
    ));
    await settle();
    expect(getComputedStyle(glass()).opacity).toBe("0");
  });
});

describe("the strip's size", () => {
  it("is 28px with 22px items, whatever line height it sits in", () => {
    render(() => (
      <div style={{ "line-height": "2em" }}>
        <Strip />
      </div>
    ));
    const list = screen.getByRole("tablist", { name: "Sections" });
    expect(list.getBoundingClientRect().height).toBe(28);
    for (const tab of screen.getAllByRole("tab")) {
      expect(tab.getBoundingClientRect().height).toBe(22);
    }
  });
});

describe("what each label reads against", () => {
  for (const ramp of RAMPS) {
    it(`clears 4.5:1 chosen on the glass, at rest on the track and under the pointer, on the ${ramp} ramp`, async () => {
      render(() => <Strip ramp={ramp} />);
      await settle();
      const list = screen.getByRole("tablist", { name: "Sections" });
      const chosen = screen.getByRole("tab", { name: "Hero" });
      // The glass is a sibling of the label, not an ancestor, so its colour is
      // laid over the track's by hand. It must be there to be measured.
      const pane = getComputedStyle(glass());
      expect(pane.opacity).toBe("1");
      expect(pane.backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
      expect(pane.backgroundImage).toBe("none");
      const under = [...backdropLayers(list), pane.backgroundColor];
      const chosenRatio = ratio(
        composite([...under, getComputedStyle(chosen).color]),
        composite(under),
      );
      expect(chosenRatio).toBeGreaterThanOrEqual(4.5);

      const idle = screen.getByRole("tab", { name: "Welcome" });
      expect(inkRatio(idle)).toBeGreaterThanOrEqual(4.5);

      const hovered = screen.getByRole("tab", { name: "Events" });
      await userEvent.hover(hovered);
      await settle();
      expect(getComputedStyle(hovered).backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
      expect(inkRatio(hovered)).toBeGreaterThanOrEqual(4.5);
    });
  }
});

describe("the focus ring", () => {
  it("is the dashboard's 2px ring at 2px, and never fades in", async () => {
    render(() => (
      <>
        <button type="button">Before</button>
        <Strip />
      </>
    ));
    screen.getByRole("button", { name: "Before" }).focus();
    await userEvent.tab();
    const tab = screen.getByRole("tab", { name: "Hero" });
    expect(document.activeElement).toBe(tab);
    const style = getComputedStyle(tab);
    expect([style.outlineStyle, style.outlineWidth, style.outlineOffset]).toEqual([
      "solid",
      "2px",
      "2px",
    ]);
    const properties = style.transitionProperty.split(",").map((p) => p.trim());
    expect(properties).not.toContain("all");
    expect(properties.some((p) => p.startsWith("outline"))).toBe(false);
  });
});

describe("a strip that scrolls", () => {
  it("scrolls itself, not the page, to the chosen item", async () => {
    render(() => <Strip scroll width="150px" />);
    await settle();
    const before = window.scrollY;
    const list = screen.getByRole("tablist", { name: "Sections" });
    const scroller = list.parentElement!;
    expect(scroller.scrollWidth).toBeGreaterThan(scroller.clientWidth);
    expect(scroller.scrollLeft).toBe(0);
    screen.getByRole("tab", { name: "Hero" }).focus();
    await userEvent.keyboard("{End}");
    await userEvent.keyboard("{Enter}");
    await settle();
    expect(screen.getByRole("tab", { name: "Closing" }).getAttribute("aria-selected")).toBe("true");
    expect(scroller.scrollLeft).toBeGreaterThan(0);
    const item = screen.getByRole("tab", { name: "Closing" }).getBoundingClientRect();
    const view = scroller.getBoundingClientRect();
    expect(item.right).toBeLessThanOrEqual(view.right + 0.5);
    expect(window.scrollY).toBe(before);
  });

  it("shows a tab the arrows reach past its edge, without choosing it", async () => {
    render(() => <Strip scroll width="150px" />);
    await settle();
    const scroller = screen.getByRole("tablist", { name: "Sections" }).parentElement!;
    screen.getByRole("tab", { name: "Hero" }).focus();
    await userEvent.keyboard("{ArrowLeft}");
    const closing = screen.getByRole("tab", { name: "Closing" });
    expect(document.activeElement).toBe(closing);
    expect(closing.getAttribute("aria-selected")).toBe("false");
    expect(closing.getBoundingClientRect().right).toBeLessThanOrEqual(
      scroller.getBoundingClientRect().right + 0.5,
    );
  });

  it("opens on a chosen tab past its edge, already in view", async () => {
    render(() => <Strip scroll width="150px" initial="closing" />);
    await settle();
    const scroller = screen.getByRole("tablist", { name: "Sections" }).parentElement!;
    expect(scroller.scrollLeft).toBeGreaterThan(0);
    expect(
      screen.getByRole("tab", { name: "Closing" }).getBoundingClientRect().right,
    ).toBeLessThanOrEqual(scroller.getBoundingClientRect().right + 0.5);
  });
});
