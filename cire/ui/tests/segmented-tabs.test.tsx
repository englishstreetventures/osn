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

import { GLASS_FILL } from "../src/lib/glass";
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
    // A key the strip does not use leaves focus where it is.
    fireEvent.keyDown(first, { key: "a" });
    expect(document.activeElement).toBe(first);
    expect(onChange).not.toHaveBeenCalled();
    // Choosing what is already chosen changes nothing, so it asks for nothing.
    fireEvent.click(first);
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(second);
    expect(onChange).toHaveBeenCalledWith("edit");
    expect(second.getAttribute("aria-selected")).toBe("true");
    expect(second.getAttribute("tabindex")).toBe("0");
  });
});

describe("a value that names no item", () => {
  it("leaves the first tab as the strip's one tab stop", () => {
    render(() => (
      <SegmentedTabs
        items={VIEWS}
        value={"gone" as View}
        onChange={() => {}}
        label="Views"
        semantics="tabs"
      />
    ));
    expect(screen.getAllByRole("tab").map((t) => t.getAttribute("tabindex"))).toEqual([
      "0",
      "-1",
      "-1",
    ]);
  });
});

describe("as radios", () => {
  function Modes(props: { allow: () => boolean; asked: string[]; initial?: string }) {
    const [mode, setMode] = createSignal(props.initial ?? "editor");
    return (
      <SegmentedTabs
        items={[
          { value: "editor", label: "Web editor" },
          { value: "import", label: "Spreadsheet import" },
          { value: "paste", label: "Paste a list" },
        ]}
        value={mode()}
        onChange={(v) => {
          props.asked.push(v);
          if (props.allow()) setMode(v);
        }}
        label="How do you want to edit?"
        semantics="radio"
      />
    );
  }

  it("is a named radiogroup with one tab stop, the checked radio, and a refused click stays unmade", () => {
    let allow = false;
    const asked: string[] = [];
    render(() => <Modes allow={() => allow} asked={asked} />);
    expect(screen.getByRole("radiogroup", { name: "How do you want to edit?" })).toBeTruthy();
    const [editor, spreadsheet, paste] = screen.getAllByRole("radio") as [
      HTMLElement,
      HTMLElement,
      HTMLElement,
    ];
    expect(editor.getAttribute("aria-checked")).toBe("true");
    expect([editor, spreadsheet, paste].map((r) => r.getAttribute("tabindex"))).toEqual([
      "0",
      "-1",
      "-1",
    ]);
    for (const radio of [editor, spreadsheet, paste]) {
      for (const name of ["aria-selected", "aria-controls", "aria-current", "id"]) {
        expect(radio.hasAttribute(name)).toBe(false);
      }
    }
    // The chosen radio asks for nothing: a refusal prompt would fire for a
    // click that changes nothing.
    fireEvent.click(editor);
    expect(asked).toEqual([]);
    fireEvent.click(spreadsheet);
    expect(spreadsheet.getAttribute("aria-checked")).toBe("false");
    expect(editor.getAttribute("aria-checked")).toBe("true");
    expect(editor.getAttribute("tabindex")).toBe("0");
    allow = true;
    fireEvent.click(spreadsheet);
    expect(spreadsheet.getAttribute("aria-checked")).toBe("true");
    expect([editor, spreadsheet].map((r) => r.getAttribute("tabindex"))).toEqual(["-1", "0"]);
  });

  it("moves with the arrows and asks to choose where it lands, wrapping at both ends", () => {
    let allow = true;
    const asked: string[] = [];
    render(() => <Modes allow={() => allow} asked={asked} />);
    const [editor, spreadsheet, paste] = screen.getAllByRole("radio") as [
      HTMLElement,
      HTMLElement,
      HTMLElement,
    ];
    editor.focus();
    fireEvent.keyDown(editor, { key: "ArrowRight" });
    expect(document.activeElement).toBe(spreadsheet);
    expect(spreadsheet.getAttribute("aria-checked")).toBe("true");
    fireEvent.keyDown(spreadsheet, { key: "ArrowDown" });
    expect(document.activeElement).toBe(paste);
    fireEvent.keyDown(paste, { key: "ArrowRight" });
    expect(document.activeElement).toBe(editor);
    fireEvent.keyDown(editor, { key: "ArrowUp" });
    expect(document.activeElement).toBe(paste);
    fireEvent.keyDown(paste, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(spreadsheet);
    expect(asked).toEqual(["import", "paste", "editor", "paste", "import"]);
    expect(spreadsheet.getAttribute("aria-checked")).toBe("true");
    // Refused: focus moves, the choice and the tab stop stay where they were.
    allow = false;
    fireEvent.keyDown(spreadsheet, { key: "ArrowRight" });
    expect(document.activeElement).toBe(paste);
    expect(paste.getAttribute("aria-checked")).toBe("false");
    expect(spreadsheet.getAttribute("aria-checked")).toBe("true");
    expect(spreadsheet.getAttribute("tabindex")).toBe("0");
    // Back onto the checked radio: it asks for nothing.
    fireEvent.keyDown(paste, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(spreadsheet);
    expect(asked).toEqual(["import", "paste", "editor", "paste", "import", "paste"]);
    // Home and End are a tablist's keys, not a radio group's.
    for (const key of ["Home", "End", "a"]) {
      fireEvent.keyDown(spreadsheet, { key });
      expect([key, document.activeElement]).toEqual([key, spreadsheet]);
    }
  });

  it("leaves the first radio as the one tab stop when the value names none", () => {
    render(() => <Modes allow={() => true} asked={[]} initial="gone" />);
    const radios = screen.getAllByRole("radio");
    expect(radios.map((r) => r.getAttribute("tabindex"))).toEqual(["0", "-1", "-1"]);
    expect(radios.some((r) => r.getAttribute("aria-checked") === "true")).toBe(false);
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
    // Each button is its own tab stop, so the arrows are left to the page.
    const listings = screen.getByRole("button", { name: "Listings" });
    listings.focus();
    fireEvent.keyDown(listings, { key: "ArrowRight" });
    expect(document.activeElement).toBe(listings);
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

  it("hides one item's word behind its icon when that item asks, and keeps the others' words", () => {
    const Dot = (props: { class?: string; "aria-hidden"?: "true" }) => <svg data-icon {...props} />;
    const [marks, setMarks] = createSignal(true);
    render(() => (
      <SegmentedTabs
        items={[
          { value: "all", label: "All" },
          {
            value: "yes",
            label: "Attending",
            icon: Dot,
            get iconOnly() {
              return marks();
            },
          },
        ]}
        value="all"
        onChange={() => {}}
        label="Filter by reply"
        semantics="radio"
        tipAttribute="data-tip"
      />
    ));
    const yes = screen.getByRole("radio", { name: "Attending" });
    const all = screen.getByRole("radio", { name: "All" });
    expect(screen.getByText("Attending").getAttribute("class")).toContain("sr-only");
    expect(yes.getAttribute("data-tip")).toBe("Attending");
    expect(screen.getByText("All").getAttribute("class") ?? "").not.toContain("sr-only");
    expect(all.hasAttribute("data-tip")).toBe(false);
    setMarks(false);
    expect(screen.getByText("Attending").getAttribute("class") ?? "").not.toContain("sr-only");
    expect(yes.hasAttribute("data-tip")).toBe(false);
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

/**
 * The classes the browser tier measures, read as written: Stryker runs this
 * tier alone, which draws no CSS, so these are what let it see the motion
 * rule and the glass.
 */
describe("the classes behind the look", () => {
  it("names a hover's clock at rest and a choice's on the chosen choice", () => {
    render(() => <Tabs />);
    const classes = (name: string) => screen.getByRole("tab", { name }).className.split(/\s+/);
    for (const name of ["Households", "Edit"]) {
      expect(classes(name)).toEqual(
        expect.arrayContaining([
          "base:transition-[color,background-color]",
          "base:duration-[var(--dur-fast,var(--ui-dur-fast))]",
          "base:ease-[var(--ease-out,var(--ui-ease-out))]",
          "base:data-[chosen]:duration-[var(--dur-base,var(--ui-dur-base))]",
          "base:data-[chosen]:ease-[var(--ease-in-out,var(--ui-ease-in-out))]",
        ]),
      );
    }
  });

  it("dresses the highlight in the portals' glass", () => {
    const { container } = render(() => <Tabs />);
    const glass = container.querySelector("[data-segmented-glass]")!.className.split(/\s+/);
    expect(glass).toEqual(expect.arrayContaining(GLASS_FILL.split(/\s+/)));
    expect(GLASS_FILL.split(/\s+/)).toEqual([
      "base:[background-color:color-mix(in_srgb,color-mix(in_srgb,var(--ui-accent)_22.8%,var(--ui-surface-raised))_61.3%,transparent)]",
      "base:shadow-[var(--inner-lip,inset_0_1px_0_rgb(255_255_255/0.06)),inset_0_0_0_1px_var(--glass-edge,rgb(255_255_255/0.1)),0_0_0_0.5px_var(--ui-hairline),var(--elev-1,var(--ui-elev-1))]",
      "base:backdrop-blur-md",
      "base:backdrop-saturate-[1.6]",
    ]);
  });
});
