/**
 * The one rule `Checkbox`, `RadioGroup` and `Switch` share, measured where it
 * is painted (`wiki/shared/component-library.md` §Choice controls):
 *
 * - the radio's dot sits in the centre of its circle, as painted at device
 *   pixel ratios 1 and 2, light and dark, beside a short label and a long one;
 *   and the circle stays a 16px circle beside a label that wraps;
 * - every control sits on its label's first line, whether the label runs to
 *   one line, two or three;
 * - every control is 8px from its words;
 * - the options of a column sit evenly apart whatever their length, and with
 *   `touch`, below `md`, each is a 44px target that abuts the next, and the
 *   group sits where it would without `touch`;
 * - keyboard focus is the house outline, 2px off, on every drawn control;
 * - an unchosen control's edge turns the secondary ink while its words are
 *   under the pointer, drawn or native, and not while chosen or disabled.
 */

import { cleanup, render, screen } from "@solidjs/testing-library";
import { createSignal, type JSX } from "solid-js";
import { afterEach, describe, expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";

import { Checkbox } from "../src/ui/checkbox";
import { RadioGroup, RadioGroupItem } from "../src/ui/radio-group";
import { Switch } from "../src/ui/switch";
import { movePointer } from "./test-support/motion";
import { dotOffset, picture } from "./test-support/painted";

import "./test-support/tailwind.css";

afterEach(async () => {
  cleanup();
  await page.viewport(414, 896);
});

/** Test-palette values (`test-support/tailwind.css`). */
const FOCUS = "rgb(47, 75, 216)";
const INK_SECONDARY = "rgb(74, 74, 88)";

/**
 * A dark ground under the same roles, set on a wrapper, so the dot is
 * measured where light ink sits on a dark ground as well as the other way.
 */
const DARK: JSX.CSSProperties = {
  "--ui-ground": "#18181c",
  "--ui-surface": "#202026",
  "--ui-accent": "#e8e8f0",
  "--ui-on-accent": "#18181c",
  "--ui-ink": "#f2f2f5",
  "--ui-ink-secondary": "#b4b4c0",
  "--ui-hairline-strong": "#8a8a96",
  "--ui-focus": "#a3a3ff",
  background: "#18181c",
  color: "#f2f2f5",
};

/** Words that run to `lines` lines whatever the font: each line ends in a break. */
function words(lines: number): JSX.Element {
  const all = ["Pass it on to a member", "who becomes its owner", "on the day it goes"];
  return <>{all.slice(0, lines).flatMap((line, i) => (i === 0 ? [line] : [<br />, line]))}</>;
}

/** The first text node inside `root`. */
function firstText(root: Element): Text {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, (node) =>
    node.textContent!.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP,
  );
  const node = walker.nextNode();
  if (!node) throw new Error("no words");
  return node as Text;
}

/** Every line of the words inside `root`, top to bottom: one box per line, from the text alone. */
function lineBoxes(root: Element): DOMRect[] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const lines = new Map<number, DOMRect>();
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.textContent!.trim()) continue;
    const range = document.createRange();
    range.selectNodeContents(node);
    for (const r of range.getClientRects()) {
      const key = Math.round(r.top);
      const seen = lines.get(key);
      lines.set(key, seen && seen.bottom > r.bottom ? seen : r);
    }
  }
  // Text runs in document order, so their lines arrive top to bottom.
  return [...lines.values()];
}

/**
 * The first line box of the words in `root`: from the top of the block that
 * holds them, one computed line-height tall. A line box, not the glyphs' own
 * box, whose middle a font's rounded ascent and descent can move by most of a
 * pixel either way.
 */
function firstLine(root: Element): { top: number; left: number; height: number } {
  const text = firstText(root);
  let block = text.parentElement!;
  while (getComputedStyle(block).display === "inline") block = block.parentElement!;
  const s = getComputedStyle(block);
  const range = document.createRange();
  range.selectNodeContents(text);
  return {
    top:
      block.getBoundingClientRect().top + parseFloat(s.paddingTop) + parseFloat(s.borderTopWidth),
    left: range.getClientRects()[0]!.left,
    height: parseFloat(s.lineHeight),
  };
}

const middle = (r: { top: number; height: number }) => r.top + r.height / 2;

/** The painted control beside an input: the drawn box, circle or track, or a native input itself. */
function controlOf(input: HTMLInputElement): HTMLElement {
  const next = input.nextElementSibling as HTMLElement | null;
  return next?.getAttribute("aria-hidden") === "true" ? next : input;
}

type Kind = "drawn radio" | "drawn checkbox" | "native radio" | "native checkbox";

function Control(props: { kind: Kind; label: JSX.Element; checked?: boolean }) {
  const box = props.kind.startsWith("native") ? "native" : "drawn";
  return props.kind.endsWith("radio") ? (
    <RadioGroup box={box} value={props.checked ? "a" : ""} aria-label="Group">
      <RadioGroupItem value="a" label={props.label} />
    </RadioGroup>
  ) : (
    <Checkbox box={box} checked={props.checked === true} label={props.label} />
  );
}

const KINDS: readonly Kind[] = ["drawn radio", "drawn checkbox", "native radio", "native checkbox"];

describe("the radio's dot", () => {
  for (const theme of ["light", "dark"] as const) {
    for (const lines of [1, 3]) {
      it(`sits in the centre of its circle, ${theme}, beside ${lines} line(s), at 1x and 2x`, async () => {
        const [value, setValue] = createSignal("");
        render(() => (
          <div
            style={{
              ...(theme === "dark" ? DARK : {}),
              // The resting edge in the chosen edge's colour, so the two
              // pictures differ by the dot alone.
              "--ui-choice-edge": "var(--ui-accent)",
              width: "160px",
              padding: "12px",
            }}
          >
            <RadioGroup value={value()} aria-label="Owner" orientation="vertical">
              <RadioGroupItem value="a" label={words(lines)} />
            </RadioGroup>
          </div>
        ));
        const circle = controlOf(screen.getByRole("radio") as HTMLInputElement);
        const size = circle.getBoundingClientRect();
        expect.soft([size.width, size.height], "the circle's size").toEqual([16, 16]);
        for (const scale of [1, 2] as const) {
          setValue("");
          const unchosen = await picture(circle, scale);
          setValue("a");
          const chosen = await picture(circle, scale);
          const { dx, dy } = dotOffset(unchosen, chosen);
          expect
            .soft(Math.abs(dx), `dot off centre across, ${scale}x: ${dx}`)
            .toBeLessThanOrEqual(0.5);
          expect
            .soft(Math.abs(dy), `dot off centre down, ${scale}x: ${dy}`)
            .toBeLessThanOrEqual(0.5);
        }
      });
    }
  }
});

describe("every control", () => {
  for (const kind of KINDS) {
    it(`${kind}: sits on its label's first line, beside one line, two or three`, () => {
      render(() => (
        <div style={{ width: "320px" }} class="flex flex-col gap-6">
          {[1, 2, 3].map((n) => (
            <div data-lines={n}>
              <Control kind={kind} label={words(n)} />
            </div>
          ))}
        </div>
      ));
      for (const n of [1, 2, 3]) {
        const at = document.querySelector(`[data-lines="${n}"]`)!;
        const input = at.querySelector("input")!;
        expect(lineBoxes(at.querySelector("label")!)).toHaveLength(n);
        const off = middle(controlOf(input).getBoundingClientRect()) - middle(firstLine(at));
        expect
          .soft(Math.abs(off), `${kind}, ${n} line(s): ${off}px off the first line`)
          .toBeLessThanOrEqual(0.5);
      }
    });
  }

  it("Switch: sits on its label's first line, beside one line or a wrapped one", () => {
    render(() => (
      <div class="flex flex-col gap-6">
        <div data-lines="1">
          <Switch checked={false} label="Plus-one" />
        </div>
        <div data-lines="many" style={{ width: "160px" }}>
          <Switch checked={false} label="May bring a plus-one to every event they are invited to" />
        </div>
      </div>
    ));
    for (const at of document.querySelectorAll("[data-lines]")) {
      const input = at.querySelector("input")!;
      const off = middle(controlOf(input).getBoundingClientRect()) - middle(firstLine(at));
      expect
        .soft(Math.abs(off), `switch, ${at.getAttribute("data-lines")}: ${off}px`)
        .toBeLessThanOrEqual(0.5);
    }
    expect(lineBoxes(document.querySelector('[data-lines="many"] label')!).length).toBeGreaterThan(
      1,
    );
  });

  it("sits 8px from its words, drawn or native, radio, box or switch", () => {
    render(() => (
      <div class="flex flex-col gap-4">
        {KINDS.map((kind) => (
          <div data-kind={kind}>
            <Control kind={kind} label="Email" />
          </div>
        ))}
        <div data-kind="switch">
          <Switch checked={false} label="Email" />
        </div>
      </div>
    ));
    const gaps = Object.fromEntries(
      [...document.querySelectorAll("[data-kind]")].map((at) => {
        const control = controlOf(at.querySelector("input")!).getBoundingClientRect();
        return [at.getAttribute("data-kind"), firstLine(at).left - control.right];
      }),
    );
    expect(gaps).toEqual({
      "drawn radio": 8,
      "drawn checkbox": 8,
      "native radio": 8,
      "native checkbox": 8,
      switch: 8,
    });
  });
});

/** A column of options one, three, one and two lines long. */
function Column(props: { box?: "drawn" | "native"; touch?: boolean }) {
  return (
    <div style={{ width: "320px", padding: "40px 0" }}>
      <p>Above</p>
      <RadioGroup
        box={props.box}
        size="sm"
        value="b"
        orientation="vertical"
        aria-label="Owner"
        {...(props.touch ? { touch: true } : {})}
      >
        <RadioGroupItem value="a" label={words(1)} />
        <RadioGroupItem value="b" label={words(3)} />
        <RadioGroupItem value="c" label={words(1)} />
        <RadioGroupItem value="d" label={words(2)} />
      </RadioGroup>
    </div>
  );
}

/** Space between the last line of each option and the first of the next. */
function textGaps(): number[] {
  const rows = [...document.querySelectorAll('[role="radiogroup"] label')];
  return rows.slice(1).map((row, i) => {
    const above = lineBoxes(rows[i]!);
    return lineBoxes(row)[0]!.top - above[above.length - 1]!.bottom;
  });
}

describe("a column of options", () => {
  for (const box of ["drawn", "native"] as const) {
    it(`${box}: sits evenly apart whatever each option's length`, async () => {
      await page.viewport(1280, 800);
      render(() => <Column box={box} />);
      const gaps = textGaps();
      expect(Math.max(...gaps) - Math.min(...gaps), `gaps ${gaps.join(", ")}`).toBeLessThanOrEqual(
        0.5,
      );
    });

    it(`${box}, touch, below md: 44px rows that abut, evenly apart, the group where it was`, async () => {
      await page.viewport(390, 800);
      const plain = render(() => <Column box={box} />);
      const before = lineBoxes(document.querySelector('[role="radiogroup"] label')!)[0]!.top;
      const after = (() => {
        plain.unmount();
        render(() => <Column box={box} touch />);
        return lineBoxes(document.querySelector('[role="radiogroup"] label')!)[0]!.top;
      })();
      expect(after, "the first option's words do not move").toBe(before);

      const rows = [...document.querySelectorAll('[role="radiogroup"] label')].map((row) =>
        row.getBoundingClientRect(),
      );
      // One-line rows are the 44px target; a longer one grows by its lines.
      expect.soft(rows[0]!.height, "a one-line row").toBeCloseTo(44, 1);
      expect.soft(rows[2]!.height, "a one-line row").toBeCloseTo(44, 1);
      for (const [i, row] of rows.slice(1).entries()) {
        expect.soft(row.top - rows[i]!.bottom, `rows ${i} and ${i + 1} abut`).toBeCloseTo(0, 1);
      }
      const gaps = textGaps();
      expect(Math.max(...gaps) - Math.min(...gaps), `gaps ${gaps.join(", ")}`).toBeLessThanOrEqual(
        0.5,
      );
    });
  }
});

describe("keyboard focus", () => {
  it("draws the house outline, 2px off, on the drawn circle, box and track, at once", async () => {
    render(() => (
      <div class="flex flex-col gap-4">
        <RadioGroup value="a" aria-label="Group">
          <RadioGroupItem value="a" label="Radio" />
        </RadioGroup>
        <Checkbox checked label="Box" />
        <Switch checked label="Switch" />
      </div>
    ));
    for (const role of ["radio", "checkbox", "switch"]) {
      await userEvent.tab();
      const input = document.activeElement as HTMLInputElement;
      expect(input.getAttribute("role") ?? input.type).toBe(role);
      const s = getComputedStyle(controlOf(input));
      expect({
        role,
        outline: [s.outlineStyle, s.outlineWidth, s.outlineOffset, s.outlineColor],
        ring: s.boxShadow,
        fades: /outline|all/.test(s.transitionProperty),
      }).toEqual({
        role,
        outline: ["solid", "2px", "2px", FOCUS],
        ring: "none",
        fades: false,
      });
    }
  });
});

describe("the pointer over a choice's words", () => {
  for (const kind of KINDS) {
    it(`${kind}: turns an unchosen edge the secondary ink, not a chosen or disabled one`, async () => {
      render(() => (
        <div class="flex flex-col gap-4 p-4">
          <div data-state="off">
            <Control kind={kind} label="Off" />
          </div>
          <div data-state="on">
            <Control kind={kind} label="On" checked />
          </div>
          <div data-state="shut">
            {kind.endsWith("radio") ? (
              <RadioGroup
                box={kind.startsWith("native") ? "native" : "drawn"}
                value=""
                disabled
                aria-label="Shut"
              >
                <RadioGroupItem value="a" label="Shut" />
              </RadioGroup>
            ) : (
              <Checkbox
                box={kind.startsWith("native") ? "native" : "drawn"}
                checked={false}
                disabled
                label="Shut"
              />
            )}
          </div>
        </div>
      ));
      const edge = (state: string) =>
        getComputedStyle(controlOf(document.querySelector(`[data-state="${state}"] input`)!))
          .borderTopColor;
      const resting = { off: edge("off"), on: edge("on"), shut: edge("shut") };
      for (const state of ["off", "on", "shut"] as const) {
        await movePointer({ selector: `[data-state="${state}"] label span:last-child` });
        await new Promise((resolve) => setTimeout(resolve, 400));
        expect({ state, edge: edge(state) }).toEqual({
          state,
          edge: state === "off" ? INK_SECONDARY : resting[state],
        });
      }
    });
  }
});
