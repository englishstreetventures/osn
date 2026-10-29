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
import { Notice, type NoticeSize, type NoticeTone } from "../src/ui/notice";
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

  it("carries tone as a mark's shape as well as a hue", () => {
    // The accessibility claim in the docblock, made falsifiable. `danger` and
    // `warn` are the closest pair in most palettes and the pair red-green
    // colour blindness collapses; if the icons ever became the same shape in
    // two colours, this is what notices. The shared circle is the frame; the
    // mark inside it is what differs.
    const shapes = (["danger", "warn", "success"] as const).map((tone) => {
      const { container, unmount } = render(() => <Notice tone={tone}>body</Notice>);
      const shape = container.querySelector("[aria-hidden='true'] svg")?.innerHTML ?? "";
      unmount();
      return shape;
    });
    expect(shapes).not.toContain("");
    for (const shape of shapes) expect(shape).toContain("<circle");
    expect(new Set(shapes).size).toBe(3);
  });

  it.each([
    ["danger", "Error:"],
    ["warn", "Warning:"],
    ["success", "Success:"],
  ] as const)(
    "reads %s's word in place of its icon, because a drawn mark is not a thing to hear",
    (tone, word) => {
      const { container } = render(() => <Notice tone={tone}>body</Notice>);
      expect(container.querySelector(".base\\:sr-only")?.textContent).toBe(`${word} `);
    },
  );

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

/** Every computed property a box's look is made of. */
const LOOK = [
  "paddingTop",
  "paddingLeft",
  "borderTopWidth",
  "borderTopColor",
  "borderTopLeftRadius",
  "backgroundColor",
  "color",
  "fontSize",
  "lineHeight",
  "columnGap",
] as const;

type Look = Record<(typeof LOOK)[number], string>;

function look(el: Element): Look {
  const style = getComputedStyle(el);
  return Object.fromEntries(LOOK.map((p) => [p, style[p]])) as Look;
}

/** What `var(--<token>)` resolves to as a colour here, measured on a probe. */
function tokenColour(token: string): string {
  const probe = document.createElement("span");
  probe.style.color = `var(${token})`;
  document.body.append(probe);
  const c = getComputedStyle(probe).color;
  probe.remove();
  return c;
}

const EVERY_TONE = ["danger", "warn", "success", "info", "accent"] as const;

describe("Notice sizes and the accent tone", () => {
  it("draws the same box with no size and tone as it always has", () => {
    // `@shared/ui` must not move under musubi or pulse: the default is today's
    // box, property for property. The numbers are the contract's fallbacks,
    // since the test stylesheet maps no type or radius step: 16px padding, a
    // 1px border, `--ui-text-base` at 0.9rem, `--ui-radius-sm` at 4px, a 10px
    // gap between the mark and the words.
    const plain = render(() => <Notice>standing note</Notice>);
    const before = look(plain.container.firstElementChild!);
    plain.unmount();

    const explicit = render(() => (
      <Notice size="md" tone="info">
        standing note
      </Notice>
    ));
    expect(look(explicit.container.firstElementChild!)).toEqual(before);
    explicit.unmount();

    expect(before.paddingTop).toBe("16px");
    expect(before.paddingLeft).toBe("16px");
    expect(before.borderTopWidth).toBe("1px");
    expect(before.fontSize).toBe("14.4px");
    expect(before.borderTopLeftRadius).toBe("4px");
    expect(before.columnGap).toBe("10px");
  });

  it.each(EVERY_TONE)(
    "draws the %s inline line with no border, no fill and no padding, in its ink",
    (tone) => {
      const { container } = render(() => (
        <Notice size="inline" tone={tone}>
          Enter a valid email address.
        </Notice>
      ));
      const line = look(container.firstElementChild!);
      const boxed = render(() => <Notice tone={tone}>body</Notice>);
      expect(line.color).toBe(look(boxed.container.firstElementChild!).color);
      boxed.unmount();
      expect(line.borderTopWidth).toBe("0px");
      expect(line.backgroundColor).toBe(TRANSPARENT);
      expect(line.paddingTop).toBe("0px");
      expect(line.paddingLeft).toBe("0px");
    },
  );

  it.each(EVERY_TONE)("draws the %s box at sm and md, and sm is the smaller", (tone) => {
    const sm = render(() => (
      <Notice size="sm" tone={tone}>
        body
      </Notice>
    ));
    const small = look(sm.container.firstElementChild!);
    sm.unmount();
    const md = render(() => (
      <Notice size="md" tone={tone}>
        body
      </Notice>
    ));
    const medium = look(md.container.firstElementChild!);
    md.unmount();

    for (const box of [small, medium]) {
      expect(box.borderTopWidth).toBe("1px");
      expect(box.backgroundColor).not.toBe(TRANSPARENT);
    }
    expect(parseFloat(small.paddingTop)).toBeLessThan(parseFloat(medium.paddingTop));
    expect(parseFloat(small.fontSize)).toBeLessThan(parseFloat(medium.fontSize));
  });

  it("paints accent in the readable accent ink, never falling back to info", () => {
    const accent = render(() => <Notice tone="accent">Preview: nothing is saved.</Notice>);
    const gold = look(accent.container.firstElementChild!);
    accent.unmount();
    const info = render(() => <Notice tone="info">Preview: nothing is saved.</Notice>);
    const grey = look(info.container.firstElementChild!);
    info.unmount();

    expect(gold.color).toBe(tokenColour("--ui-accent-ink"));
    expect(gold.color).not.toBe(tokenColour("--ui-accent"));
    expect(gold.color).not.toBe(grey.color);
    expect(gold.backgroundColor).not.toBe(grey.backgroundColor);
    expect(gold.borderTopColor).not.toBe(grey.borderTopColor);
  });

  it("gives every one of the five tones its own ink", () => {
    const inks = EVERY_TONE.map((tone) => {
      const { container, unmount } = render(() => <Notice tone={tone}>body</Notice>);
      const c = painted(container.firstElementChild!, "color");
      unmount();
      return c;
    });
    expect(new Set(inks).size).toBe(inks.length);
  });

  it("gives `accent` no mark of its own — a standing note, like `info`", () => {
    const { container } = render(() => <Notice tone="accent">Preview: nothing is saved.</Notice>);
    expect(container.querySelector("[aria-hidden='true']")).toBeNull();
  });

  it.each(["inline", "sm", "md"] as const)("strokes the %s icon in the tone's ink", (size) => {
    const { container } = render(() => (
      <Notice size={size} tone="danger">
        Could not save
      </Notice>
    ));
    const box = container.firstElementChild!;
    expect(getComputedStyle(box.querySelector("svg")!).stroke).toBe(getComputedStyle(box).color);
  });

  it("sizes the icon from the text step, the same share of it at every size", () => {
    const ratios = (["inline", "sm", "md"] as const).map((size) => {
      const { container, unmount } = render(() => (
        <Notice size={size} tone="danger">
          Could not save
        </Notice>
      ));
      const box = container.firstElementChild!;
      const width = box.querySelector("svg")!.getBoundingClientRect().width;
      const ratio = width / parseFloat(getComputedStyle(box).fontSize);
      unmount();
      return ratio;
    });
    expect(ratios[0]).toBeGreaterThan(1);
    for (const r of ratios) expect(r).toBeCloseTo(ratios[0]!, 2);
  });

  it("sets the icon on the first line of a wrapped message, not beside its middle", () => {
    const { container } = render(() => (
      <div style={{ width: "160px" }}>
        <Notice size="sm" tone="warn">
          Three guests have no email address, so they will not be invited to anything.
        </Notice>
      </div>
    ));
    const box = container.firstElementChild!.firstElementChild!;
    const icon = box.querySelector("svg")!.getBoundingClientRect();
    const words = box.lastElementChild!.getBoundingClientRect();
    const line = parseFloat(getComputedStyle(box).lineHeight);
    expect(words.height).toBeGreaterThan(line * 1.5);
    // Centred on the first line, not hung from its top.
    expect(Math.abs((icon.top + icon.bottom) / 2 - (words.top + line / 2))).toBeLessThan(1);
  });

  it("reads the word in place of the icon at the inline size too", () => {
    const { container } = render(() => (
      <Notice size="inline" tone="danger">
        Enter a valid email address.
      </Notice>
    ));
    expect(container.querySelector("[aria-hidden='true'] svg")).not.toBeNull();
    expect(container.textContent).toContain("Error:");
  });

  it("draws an app's own mark in the icon slot and reads its word", () => {
    const { container } = render(() => (
      <Notice
        tone="accent"
        mark={{
          icon: (
            <svg viewBox="0 0 24 24" data-testid="own-mark">
              <path d="M12 2 14 10 22 12 14 14 12 22 10 14 2 12 10 10Z" />
            </svg>
          ),
          word: "Note",
        }}
      >
        Preview: nothing is saved.
      </Notice>
    ));
    const slot = container.querySelector("[aria-hidden='true']");
    expect(slot?.querySelector("[data-testid='own-mark']")).not.toBeNull();
    expect(container.textContent).toContain("Note:");
  });

  it("keeps a tone's own mark when an app passes one", () => {
    const { container } = render(() => (
      <Notice
        tone="danger"
        mark={{ icon: <svg viewBox="0 0 24 24" data-testid="own-mark" />, word: "Note" }}
      >
        Could not save
      </Notice>
    ));
    expect(container.querySelector("[data-testid='own-mark']")).toBeNull();
    expect(container.querySelector("[aria-hidden='true'] svg circle")).not.toBeNull();
    expect(container.textContent).toContain("Error:");
    expect(container.textContent).not.toContain("Note:");
  });

  it("draws info at md for a tone or size outside the named sets, rather than failing", () => {
    // A value cast from data can be any string, `__proto__` included, which a
    // plain lookup would answer with a function to call.
    for (const bad of ["__proto__", "constructor", "loud"]) {
      const odd = render(() => (
        <Notice tone={bad as NoticeTone} size={bad as NoticeSize}>
          body
        </Notice>
      ));
      const got = look(odd.container.firstElementChild!);
      expect(odd.container.textContent).toBe("body");
      odd.unmount();
      const info = render(() => <Notice>body</Notice>);
      expect(got).toEqual(look(info.container.firstElementChild!));
      info.unmount();
    }
  });

  it("lets nothing past its allow-list reach the element, however it is spread", () => {
    // A spread skips the type check, so the allow-list is held at run time:
    // markup, a handler, and anything that would hide, rename or repeat the
    // words, or turn an alert into a status, stay off the element.
    const spread: Record<string, unknown> = {
      role: "status",
      "aria-hidden": "true",
      "aria-live": "off",
      "aria-label": "Fine",
      "aria-busy": "true",
      hidden: "",
      inert: true,
      popover: "auto",
      title: "Could not save",
      tabIndex: 0,
      onClick: () => undefined,
      innerHTML: "<img src=x>",
      "prop:innerHTML": "<img src=x>",
      "attr:aria-hidden": "true",
      "bool:hidden": true,
      id: "save-error",
      "aria-describedby": "save-hint",
      "data-testid": "save-error",
    };
    const { container } = render(() => (
      <Notice tone="danger" alert {...spread}>
        Could not save
      </Notice>
    ));
    const box = container.firstElementChild!;
    expect(box.getAttribute("role")).toBe("alert");
    for (const name of [
      "aria-hidden",
      "aria-live",
      "aria-label",
      "aria-busy",
      "hidden",
      "inert",
      "popover",
      "title",
      "tabindex",
      "onclick",
    ]) {
      expect(box.hasAttribute(name)).toBe(false);
    }
    expect(box.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("Error:");
    expect(box.id).toBe("save-error");
    expect(box.getAttribute("aria-describedby")).toBe("save-hint");
    expect(box.getAttribute("data-testid")).toBe("save-error");
  });

  it("makes the icon slot inert, and draws no mark whose word is empty", () => {
    const marked = render(() => <Notice tone="warn">Check this</Notice>);
    expect(marked.container.querySelector("[aria-hidden='true']")?.hasAttribute("inert")).toBe(
      true,
    );
    marked.unmount();

    const wordless = render(() => (
      <Notice tone="info" mark={{ icon: <svg viewBox="0 0 24 24" />, word: " " }}>
        Preview: nothing is saved.
      </Notice>
    ));
    expect(wordless.container.querySelector("[aria-hidden='true']")).toBeNull();
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
