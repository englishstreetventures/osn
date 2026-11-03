// @vitest-environment happy-dom
/**
 * What `SegmentedTabs` says to assistive technology and the keyboard, in each
 * of its three meanings. Each strip it replaces keeps its ARIA: the module's
 * views are a tablist chosen with Enter, the edit modes a radiogroup whose
 * choice can be refused, the vendor's two views buttons marked `aria-current`.
 * Where the glass lands, and what it paints, is the browser tier's
 * (`segmented-tabs.browser.test.tsx`).
 */

import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";

import SegmentedTabs, { type SegmentedItem } from "../src/segmented-tabs";

/** happy-dom has no ResizeObserver; the pill only needs one to exist. */
class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver ??= NoopResizeObserver as unknown as typeof ResizeObserver;

afterEach(cleanup);

type View = "households" | "edit" | "rsvps";

const VIEWS: SegmentedItem<View>[] = [
  { value: "households", label: "Households" },
  { value: "edit", label: "Edit" },
  { value: "rsvps", label: "RSVPs" },
];

function Tabs(props: { onChange?: (v: View) => void }) {
  const [view, setView] = createSignal<View>("households");
  return (
    <SegmentedTabs
      items={VIEWS}
      value={view()}
      onChange={(v) => {
        props.onChange?.(v);
        setView(v);
      }}
      label="Views"
      semantics="tabs"
      tabId={(v) => `tab-${v}`}
      panelId={() => "panel"}
    />
  );
}

describe("as tabs", () => {
  it("is a named tablist whose chosen tab alone is a tab stop", () => {
    render(() => <Tabs />);
    expect(screen.getByRole("tablist", { name: "Views" })).toBeTruthy();
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((t) => t.id)).toEqual(["tab-households", "tab-edit", "tab-rsvps"]);
    expect(tabs.map((t) => t.getAttribute("aria-selected"))).toEqual(["true", "false", "false"]);
    expect(tabs.every((t) => t.getAttribute("aria-controls") === "panel")).toBe(true);
    expect(tabs.map((t) => t.getAttribute("tabindex"))).toEqual(["0", "-1", "-1"]);
    expect(tabs.some((t) => t.hasAttribute("aria-checked") || t.hasAttribute("aria-current"))).toBe(
      false,
    );
  });

  it("moves focus with the arrows, Home and End without choosing, and chooses on Enter", () => {
    const onChange = vi.fn();
    render(() => <Tabs onChange={onChange} />);
    const [first, second, third] = screen.getAllByRole("tab") as [
      HTMLElement,
      HTMLElement,
      HTMLElement,
    ];
    first.focus();
    fireEvent.keyDown(first, { key: "ArrowRight" });
    expect(document.activeElement).toBe(second);
    fireEvent.keyDown(second, { key: "End" });
    expect(document.activeElement).toBe(third);
    fireEvent.keyDown(third, { key: "ArrowRight" });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(third);
    fireEvent.keyDown(third, { key: "Home" });
    expect(document.activeElement).toBe(first);
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(second);
    expect(onChange).toHaveBeenCalledWith("edit");
    expect(second.getAttribute("aria-selected")).toBe("true");
    expect(second.getAttribute("tabindex")).toBe("0");
  });
});

describe("as radios", () => {
  it("is a named radiogroup, each radio its own tab stop, and a refused choice stays unmade", () => {
    const [mode, setMode] = createSignal<"editor" | "import">("editor");
    let allow = false;
    render(() => (
      <SegmentedTabs
        items={[
          { value: "editor", label: "Web editor" },
          { value: "import", label: "Spreadsheet import" },
        ]}
        value={mode()}
        onChange={(v) => {
          if (allow) setMode(v);
        }}
        label="How do you want to edit?"
        semantics="radio"
      />
    ));
    expect(screen.getByRole("radiogroup", { name: "How do you want to edit?" })).toBeTruthy();
    const [editor, spreadsheet] = screen.getAllByRole("radio") as [HTMLElement, HTMLElement];
    expect(editor.getAttribute("aria-checked")).toBe("true");
    expect(editor.getAttribute("tabindex")).not.toBe("-1");
    expect(spreadsheet.getAttribute("tabindex")).not.toBe("-1");
    for (const radio of [editor, spreadsheet]) {
      for (const name of ["aria-selected", "aria-controls", "aria-current", "id"]) {
        expect(radio.hasAttribute(name)).toBe(false);
      }
    }
    // Each radio is its own tab stop, so the arrows are left to the page.
    editor.focus();
    fireEvent.keyDown(editor, { key: "ArrowRight" });
    expect(document.activeElement).toBe(editor);
    fireEvent.click(spreadsheet);
    expect(spreadsheet.getAttribute("aria-checked")).toBe("false");
    expect(editor.getAttribute("aria-checked")).toBe("true");
    allow = true;
    fireEvent.click(spreadsheet);
    expect(spreadsheet.getAttribute("aria-checked")).toBe("true");
  });
});

describe("as the page you are on", () => {
  it("marks the chosen button aria-current and claims no tab roles", () => {
    const { container } = render(() => (
      <SegmentedTabs
        items={[
          { value: "listings", label: "Listings" },
          { value: "enquiries", label: "Enquiries" },
        ]}
        value="enquiries"
        onChange={() => {}}
        label="Views"
        semantics="current"
      />
    ));
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.queryByRole("tab")).toBeNull();
    expect(screen.getByRole("button", { name: "Enquiries" }).getAttribute("aria-current")).toBe(
      "page",
    );
    expect(screen.getByRole("button", { name: "Listings" }).hasAttribute("aria-current")).toBe(
      false,
    );
    expect(screen.getByRole("group", { name: "Views" })).toBeTruthy();
    for (const button of screen.getAllByRole("button")) {
      for (const name of ["role", "aria-selected", "aria-checked", "tabindex", "id"]) {
        expect(button.hasAttribute(name)).toBe(false);
      }
    }
    // The vendor's top bar test reads the first hidden element as the glass's
    // layer and expects it to let clicks through.
    const firstHidden = container.querySelector('[aria-hidden="true"]');
    expect(firstHidden?.getAttribute("class")).toContain("pointer-events-none");
  });
});

describe("an item's content", () => {
  it("hides the label behind its icon when told to, and hands the label to the tip", () => {
    // As a lucide icon does, it spreads what it is given onto its `<svg>`.
    const Icon = (props: { class?: string; "aria-hidden"?: "true" }) => (
      <svg data-icon {...props} />
    );
    const [iconOnly, setIconOnly] = createSignal(true);
    render(() => (
      <SegmentedTabs
        items={[{ value: "a", label: "Households", icon: Icon }]}
        value="a"
        onChange={() => {}}
        label="Views"
        semantics="tabs"
        iconOnly={iconOnly()}
        tipAttribute="data-tip"
      />
    ));
    const tab = screen.getByRole("tab", { name: "Households" });
    expect(tab.querySelector("[data-icon]")?.getAttribute("aria-hidden")).toBe("true");
    expect(screen.getByText("Households").getAttribute("class")).toContain("sr-only");
    expect(tab.getAttribute("data-tip")).toBe("Households");
    setIconOnly(false);
    expect(tab.hasAttribute("data-tip")).toBe(false);
    expect(screen.getByText("Households").getAttribute("class") ?? "").not.toContain("sr-only");
  });

  it("takes a fuller name, a description and what follows the label", () => {
    render(() => (
      <SegmentedTabs
        items={[
          {
            value: "ceremony",
            label: "Ceremony",
            name: "Ceremony, 40 guests",
            describedBy: "hint",
            after: (chosen) => <span data-count={chosen ? "chosen" : "idle"}>40</span>,
          },
          {
            value: "reception",
            label: "Reception",
            after: (chosen) => <span data-count={chosen ? "chosen" : "idle"}>9</span>,
          },
        ]}
        value="ceremony"
        onChange={() => {}}
        label="Events"
        semantics="tabs"
      />
    ));
    const tab = screen.getByRole("tab", { name: "Ceremony, 40 guests" });
    expect(tab.getAttribute("aria-describedby")).toBe("hint");
    expect(tab.querySelector("[data-count]")?.getAttribute("data-count")).toBe("chosen");
    expect(
      screen
        .getByRole("tab", { name: /Reception/ })
        .querySelector("[data-count]")
        ?.getAttribute("data-count"),
    ).toBe("idle");
  });

  it("tells the caller which item a pointer or focus is heading for", () => {
    const onIntent = vi.fn();
    render(() => (
      <SegmentedTabs
        items={VIEWS}
        value="households"
        onChange={() => {}}
        label="Views"
        semantics="tabs"
        onIntent={onIntent}
      />
    ));
    const edit = screen.getByRole("tab", { name: "Edit" });
    fireEvent.pointerEnter(edit);
    expect(onIntent).toHaveBeenLastCalledWith("edit");
    fireEvent.focus(screen.getByRole("tab", { name: "RSVPs" }));
    expect(onIntent).toHaveBeenLastCalledWith("rsvps");
  });
});

describe("an item list that changes", () => {
  it("keeps each tab's element when the list is rebuilt with new words", () => {
    const [shown, setShown] = createSignal(40);
    render(() => (
      <SegmentedTabs
        items={[
          { value: "ceremony", label: "Ceremony", name: `Ceremony, ${shown()} guests` },
          { value: "reception", label: "Reception" },
        ]}
        value="ceremony"
        onChange={() => {}}
        label="Events"
        semantics="tabs"
      />
    ));
    const tab = screen.getByRole("tab", { name: "Ceremony, 40 guests" });
    tab.focus();
    setShown(3);
    expect(screen.getByRole("tab", { name: "Ceremony, 3 guests" })).toBe(tab);
    expect(document.activeElement).toBe(tab);
  });

  it("moves the tab stop and the arrows onto a new set of tabs", () => {
    const [module, setModule] = createSignal<"guests" | "invite">("guests");
    const items = () =>
      module() === "guests"
        ? [
            { value: "households", label: "Households" },
            { value: "rsvps", label: "RSVPs" },
          ]
        : [
            { value: "template", label: "Template" },
            { value: "style", label: "Style" },
            { value: "content", label: "Content" },
          ];
    render(() => (
      <SegmentedTabs
        items={items()}
        value={module() === "guests" ? "households" : "style"}
        onChange={() => {}}
        label="Views"
        semantics="tabs"
      />
    ));
    setModule("invite");
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((t) => t.textContent)).toEqual(["Template", "Style", "Content"]);
    expect(tabs.map((t) => t.getAttribute("tabindex"))).toEqual(["-1", "0", "-1"]);
    tabs[1]!.focus();
    fireEvent.keyDown(tabs[1]!, { key: "ArrowRight" });
    expect(document.activeElement).toBe(tabs[2]);
    fireEvent.keyDown(tabs[2]!, { key: "ArrowRight" });
    expect(document.activeElement).toBe(tabs[0]);
  });
});
