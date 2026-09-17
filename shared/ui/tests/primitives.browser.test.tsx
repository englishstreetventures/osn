/**
 * The lifted primitives, checked where their claims actually live.
 *
 * Every one of these is mostly a class list, and a class list is the thing a
 * DOM shim cannot evaluate: it can confirm `base:bg-ui-danger/5` is present as
 * text and tell you nothing about whether Tailwind generated a rule for it. A
 * contract utility that the scanner cannot resolve emits **nothing** — no
 * error, no warning — so a component can render completely unstyled with every
 * string assertion green.
 *
 * For `Notice` and `Chip` that gap is the whole point of the component: they
 * exist to stop tone being carried by hue alone, and "the tint is actually
 * painted" is not a claim available anywhere else.
 */

import { render } from "@solidjs/testing-library";
import { describe, expect, it } from "vitest";

import { Chip } from "../src/ui/chip";
import { EmptyState } from "../src/ui/empty-state";
import { Notice } from "../src/ui/notice";
import { Stat } from "../src/ui/stat";
import { Table, Td } from "../src/ui/table";

import "./test-support/tailwind.css";

/** A colour the browser actually resolved, rather than the token behind it. */
function painted(el: Element, prop: "color" | "backgroundColor" | "borderTopColor"): string {
  return getComputedStyle(el)[prop];
}

const TRANSPARENT = "rgba(0, 0, 0, 0)";

describe("Notice", () => {
  it("paints a tint and a border for every tone, not just the class names", () => {
    for (const tone of ["danger", "warn", "success", "info"] as const) {
      const { container, unmount } = render(() => <Notice tone={tone}>body</Notice>);
      const box = container.firstElementChild as HTMLElement;

      expect(painted(box, "backgroundColor")).not.toBe(TRANSPARENT);
      expect(painted(box, "borderTopColor")).not.toBe(TRANSPARENT);
      expect(painted(box, "color")).not.toBe("");
      unmount();
    }
  });

  it("gives each tone a different colour, or the tones are decoration", () => {
    const colours = (["danger", "warn", "success", "info"] as const).map((tone) => {
      const { container, unmount } = render(() => <Notice tone={tone}>body</Notice>);
      const c = painted(container.firstElementChild!, "color");
      unmount();
      return c;
    });
    expect(new Set(colours).size).toBe(colours.length);
  });

  it("carries tone as a glyph shape as well as a hue", () => {
    // The accessibility claim in the docblock, made falsifiable. `danger` and
    // `warn` are the closest pair in most palettes and the pair red-green
    // colour blindness collapses; if the glyphs ever became the same character
    // in two colours, this is what notices.
    const glyphs = (["danger", "warn", "success"] as const).map((tone) => {
      const { container, unmount } = render(() => <Notice tone={tone}>body</Notice>);
      const glyph = container.querySelector("[aria-hidden='true']")?.textContent ?? "";
      unmount();
      return glyph;
    });
    expect(new Set(glyphs).size).toBe(3);
  });

  it("reads a word in place of the glyph, because '✕' is not a thing to hear", () => {
    const { container } = render(() => <Notice tone="danger">Could not save</Notice>);
    expect(container.textContent).toContain("Error:");
  });

  it("gives `info` no mark at all — nothing has happened", () => {
    const { container } = render(() => <Notice tone="info">standing note</Notice>);
    expect(container.querySelector("[aria-hidden='true']")).toBeNull();
  });

  it("is a live region only when asked", () => {
    // A standing note that was on screen before the reader arrived must not
    // interrupt them; a save that just failed must.
    const quiet = render(() => <Notice>standing</Notice>);
    expect(quiet.container.firstElementChild?.getAttribute("role")).toBeNull();
    quiet.unmount();

    const loud = render(() => <Notice alert>just failed</Notice>);
    expect(loud.container.firstElementChild?.getAttribute("role")).toBe("alert");
  });
});

describe("Chip", () => {
  it("paints a distinct ground for every tone", () => {
    const grounds = (["neutral", "success", "pending", "accent"] as const).map((tone) => {
      const { container, unmount } = render(() => <Chip tone={tone}>state</Chip>);
      const bg = painted(container.firstElementChild!, "backgroundColor");
      expect(bg).not.toBe(TRANSPARENT);
      unmount();
      return bg;
    });
    expect(new Set(grounds).size).toBe(grounds.length);
  });

  it("always carries its state as text, so the hue is never the only carrier", () => {
    const { container } = render(() => <Chip tone="success">live</Chip>);
    expect(container.textContent?.trim()).toBe("live");
  });
});

describe("EmptyState", () => {
  it("draws a dashed border, so an empty list does not read as a failed one", () => {
    // The defect in the copy this replaces: a version with no border at all,
    // which looks like a list that failed to load rather than one with nothing
    // in it yet.
    const { container } = render(() => <EmptyState title="No guests yet" />);
    const box = container.firstElementChild as HTMLElement;
    expect(getComputedStyle(box).borderTopStyle).toBe("dashed");
    expect(painted(box, "borderTopColor")).not.toBe(TRANSPARENT);
  });

  it("centres its content, rather than fighting itself", () => {
    // The other defect: seven hand-written copies set `items-start` AND
    // `text-center`, so a one-line title read centred in its own box and
    // left-aligned against the box's edges.
    const { container } = render(() => <EmptyState title="No guests yet" />);
    const style = getComputedStyle(container.firstElementChild!);
    expect(style.textAlign).toBe("center");
    expect(style.alignItems).toBe("center");
  });

  it("renders description and action only when given them", () => {
    const bare = render(() => <EmptyState title="Empty" />);
    expect(bare.container.querySelectorAll("p")).toHaveLength(1);
    bare.unmount();

    const full = render(() => (
      <EmptyState title="Empty" description="Add one to begin." action={<button>Add</button>} />
    ));
    expect(full.container.querySelectorAll("p")).toHaveLength(2);
    expect(full.getByRole("button")).toBeTruthy();
  });
});

describe("Stat", () => {
  it("uses tabular figures, so a counting number does not reflow as it ticks", () => {
    const { container } = render(() => <Stat value="84" label="Guests" />);
    const figure = container.querySelector("p") as HTMLElement;
    expect(getComputedStyle(figure).fontVariantNumeric).toContain("tabular-nums");
  });

  it("puts the label after the figure, not before it", () => {
    const { container } = render(() => <Stat value="84" label="Guests" hint="of 120" />);
    const text = [...container.querySelectorAll("p")].map((p) => p.textContent);
    expect(text).toEqual(["84", "Guests", "of 120"]);
  });

  it("sets the figure larger than its label, and draws it from the accent token", () => {
    const { container } = render(() => <Stat value="84" label="Guests" />);
    const [figure, label] = [...container.querySelectorAll("p")];

    expect(Number.parseFloat(getComputedStyle(figure).fontSize)).toBeGreaterThan(
      Number.parseFloat(getComputedStyle(label).fontSize),
    );

    // Against `--ui-accent-ink` rather than against the label's colour. Under
    // the contract's neutral fallbacks — which is what a library test renders
    // with, having no app to supply a brand — accent-ink and ink resolve to the
    // same value, so "they differ" is only true once an app maps a real accent.
    // What holds in both cases is that the figure reads the accent token.
    const probe = document.createElement("div");
    probe.style.color = getComputedStyle(document.documentElement)
      .getPropertyValue("--ui-accent-ink")
      .trim();
    document.body.append(probe);
    const accentInk = getComputedStyle(probe).color;
    probe.remove();

    expect(painted(figure, "color")).toBe(accentInk);
  });
});

describe("Table cells", () => {
  it("aligns by prop, because a passed class would not reliably win", () => {
    // Two Tailwind utilities on one property resolve by stylesheet order, not
    // by the order they appear in `class` — so `<Td class="text-right">`
    // against the component's own `text-left` is a coin flip. Only a real
    // engine can say which won.
    const { getAllByRole } = render(() => (
      <Table label="Budget">
        <tbody>
          <tr>
            <Td>start</Td>
            <Td align="center">centre</Td>
            <Td align="end">end</Td>
          </tr>
        </tbody>
      </Table>
    ));
    const aligns = getAllByRole("cell").map((c) => getComputedStyle(c).textAlign);
    expect(aligns).toEqual(["left", "center", "right"]);
  });

  it("mutes a cell that is context rather than content", () => {
    const plain = render(() => (
      <Table label="A">
        <tbody>
          <tr>
            <Td>content</Td>
          </tr>
        </tbody>
      </Table>
    ));
    const muted = render(() => (
      <Table label="B">
        <tbody>
          <tr>
            <Td tone="muted">context</Td>
          </tr>
        </tbody>
      </Table>
    ));
    expect(painted(muted.getByRole("cell"), "color")).not.toBe(
      painted(plain.getByRole("cell"), "color"),
    );
  });
});
