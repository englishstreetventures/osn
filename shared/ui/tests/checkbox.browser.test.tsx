/**
 * The checkbox, measured where it is painted, in both of its boxes.
 *
 * `drawn` is pulse's: a visually hidden input beside a painted box, so the
 * claims about it are the ones Kobalte's part made — the ring reaches the box
 * from the input's focus, the box's size, corner and fills — held at today's
 * values, because pulse must not move. `native` is cire's: the browser's own
 * box ticked, a drawn edge unticked, and only a real engine can say whether
 * the ticked box is still the platform's and whether ticking moved anything.
 */

import { cleanup, render, screen } from "@solidjs/testing-library";
import { createSignal, Show } from "solid-js";
import { afterEach, describe, expect, it } from "vitest";
import { userEvent } from "vitest/browser";

import { Checkbox } from "../src/ui/checkbox";

import "./test-support/tailwind.css";

afterEach(cleanup);

/** Test-palette values (`test-support/tailwind.css`). */
const FOCUS = "rgb(47, 75, 216)";
const INK = "rgb(26, 26, 34)";
const HAIRLINE_STRONG = "rgb(125, 125, 140)";
const GROUND = "rgb(255, 255, 255)";
const ACCENT = "rgb(47, 75, 216)";
const INK_SECONDARY = "rgb(74, 74, 88)";

const box = (name: string) => screen.getByRole("checkbox", { name });

/** The painted box beside a drawn checkbox. */
const drawnBoxOf = (name: string) => box(name).nextElementSibling as HTMLElement;

/** The label element round an input. */
const rowOf = (input: HTMLElement) => input.closest("label") as HTMLLabelElement;

/** A controlled checkbox whose parent agrees to every change. */
function Agreeing(props: {
  box?: "drawn" | "native";
  label?: string;
  start?: boolean;
  size?: "sm" | "md";
}) {
  const [on, setOn] = createSignal(false);
  return (
    <Checkbox
      box={props.box}
      size={props.size}
      checked={on()}
      onChange={setOn}
      label={props.label ?? "Florals"}
      align={props.start ? "start" : undefined}
    />
  );
}

describe("Checkbox, either box", () => {
  for (const kind of ["drawn", "native"] as const) {
    describe(`${kind}`, () => {
      it("names the input by aria-label when it has no label", () => {
        render(() => <Checkbox box={kind} checked={false} aria-label="Ana attends the ceremony" />);
        expect(box("Ana attends the ceremony").tagName).toBe("INPUT");
      });

      it("puts name, value, id, required and the aria states on the input itself", () => {
        render(() => (
          <>
            <span id="heading">Paid</span>
            <Checkbox
              box={kind}
              checked={false}
              name="paid"
              value="deposit"
              id="deposit-paid"
              required
              aria-invalid="true"
              aria-labelledby="heading"
              label="Deposit"
            />
          </>
        ));
        const input = box("Paid") as HTMLInputElement;
        expect([input.name, input.value, input.id, input.required]).toEqual([
          "paid",
          "deposit",
          "deposit-paid",
          true,
        ]);
        expect(input.getAttribute("aria-invalid")).toBe("true");
      });

      it("disables the input itself", () => {
        render(() => <Checkbox box={kind} checked={false} disabled label="Catering" />);
        expect((box("Catering") as HTMLInputElement).disabled).toBe(true);
      });

      it("reports the new state when the label's words are clicked", async () => {
        let reported: boolean | undefined;
        render(() => (
          <Checkbox box={kind} checked={false} onChange={(v) => (reported = v)} label="Catering" />
        ));
        await userEvent.click(screen.getByText("Catering"));
        expect(reported).toBe(true);
      });

      it("shows a refused change as not made", async () => {
        render(() => <Checkbox box={kind} checked={false} onChange={() => {}} label="Catering" />);
        await userEvent.click(screen.getByText("Catering"));
        expect((box("Catering") as HTMLInputElement).checked).toBe(false);
      });

      it("keeps a link in the label a link: a click on it ticks nothing", async () => {
        let reported: boolean | undefined;
        render(() => (
          <Checkbox
            box={kind}
            checked={false}
            onChange={(v) => (reported = v)}
            label={
              <>
                I agree. See our <a href="#notice">privacy notice</a>.
              </>
            }
          />
        ));
        const link = screen.getByRole("link", { name: "privacy notice" });
        expect(rowOf(box("I agree. See our privacy notice."))).toContainElement(link);
        await userEvent.click(link);
        expect(reported).toBeUndefined();
      });

      it("names the box by its label alone when it has a description, and describes it by that", async () => {
        let reported: boolean | undefined;
        render(() => (
          <Checkbox
            box={kind}
            checked={false}
            onChange={(v) => (reported = v)}
            label="Pinterest moodboards"
            description="Loads from Pinterest's servers."
          />
        ));
        const input = box("Pinterest moodboards");
        expect(input).toHaveAccessibleDescription("Loads from Pinterest's servers.");
        await userEvent.click(screen.getByText("Loads from Pinterest's servers."));
        expect(reported).toBe(true);
      });

      it("puts the note outside the label, under the label's words, describing the box", async () => {
        let reported: boolean | undefined;
        render(() => (
          <Checkbox
            box={kind}
            checked={false}
            onChange={(v) => (reported = v)}
            aria-describedby="err"
            label="I confirm the plus-one agreed."
            note={<span>Share our privacy notice with them.</span>}
          />
        ));
        render(() => <span id="err">Required.</span>);
        const input = box("I confirm the plus-one agreed.");
        const note = screen.getByText("Share our privacy notice with them.");
        expect(rowOf(input)).not.toContainElement(note);
        expect(input).toHaveAccessibleDescription("Required. Share our privacy notice with them.");

        const words = screen.getByText("I confirm the plus-one agreed.");
        expect(note.getBoundingClientRect().left).toBeCloseTo(
          words.getBoundingClientRect().left,
          0,
        );

        await userEvent.click(note);
        expect(reported).toBeUndefined();
      });

      it("answers a click on the box and its words, not on the rest of the line", async () => {
        let reported: boolean | undefined;
        const { container } = render(() => (
          <div style={{ width: "400px" }}>
            <Checkbox box={kind} checked={false} onChange={(v) => (reported = v)} label="Venue" />
          </div>
        ));
        const outer = container.firstElementChild!.firstElementChild as HTMLElement;
        await userEvent.click(outer.parentElement!, { position: { x: 390, y: 5 } });
        expect(reported).toBeUndefined();
      });

      it("lets a caller's own name win over the label beside a description", () => {
        render(() => (
          <>
            <span id="heading">Pinterest</span>
            <Checkbox
              box={kind}
              checked={false}
              aria-labelledby="heading"
              label="Moodboards"
              description="Loads from Pinterest."
            />
            <Checkbox
              box={kind}
              checked={false}
              aria-label="Maps"
              label="Google Maps"
              description="Loads from Google."
            />
          </>
        ));
        expect(box("Pinterest")).toHaveAccessibleDescription("Loads from Pinterest.");
        expect(box("Maps")).toHaveAccessibleDescription("Loads from Google.");
      });

      it("keeps focus and leaves no gap or description when a note comes and goes", async () => {
        const [shown, setShown] = createSignal(true);
        render(() => (
          <Checkbox
            box={kind}
            checked={false}
            onChange={() => {}}
            label="Plus-one agreed"
            note={
              <Show when={shown()}>
                <span>Share the notice.</span>
              </Show>
            }
          />
        ));
        const input = box("Plus-one agreed");
        const outer = rowOf(input).parentElement as HTMLElement;
        await userEvent.tab();
        expect(document.activeElement).toBe(input);
        expect(input.getAttribute("aria-describedby")).not.toBeNull();

        setShown(false);
        expect(document.activeElement).toBe(input);
        expect(input.getAttribute("aria-describedby")).toBeNull();
        expect(outer.children.length).toBe(1);
        expect(outer.getBoundingClientRect().height).toBe(
          rowOf(input).getBoundingClientRect().height,
        );
      });

      it("centres the box on the first line of a label that wraps, with align start", () => {
        // The page's own line height is not the label's, so a first-line box
        // measured against the page would miss.
        render(() => (
          <div style={{ width: "160px", "line-height": "1" }}>
            <Agreeing
              box={kind}
              start
              size="sm"
              label="Also remove these three tasks from the checklist"
            />
          </div>
        ));
        const input = box("Also remove these three tasks from the checklist");
        const painted = kind === "drawn" ? (input.nextElementSibling as HTMLElement) : input;
        const words = screen.getByText("Also remove these three tasks from the checklist");
        const line = parseFloat(getComputedStyle(words).lineHeight);
        expect(words.getBoundingClientRect().height).toBeGreaterThan(line * 1.5);
        const r = painted.getBoundingClientRect();
        const firstLineMiddle = words.getBoundingClientRect().top + line / 2;
        expect(Math.abs(r.top + r.height / 2 - firstLineMiddle)).toBeLessThan(1);
      });
    });
  }
});

describe("Checkbox, drawn (pulse's box, which must not move)", () => {
  it("rings the box in the focus colour when the input takes keyboard focus", async () => {
    render(() => <Checkbox checked={false} onChange={() => {}} label="Florals" />);
    const painted = drawnBoxOf("Florals");
    expect(getComputedStyle(painted).boxShadow).toBe("none");

    await userEvent.tab();

    expect(document.activeElement).toBe(box("Florals"));
    expect(getComputedStyle(painted).boxShadow).toContain(FOCUS);
  });

  it("paints no ring after a pointer click, which focuses the input too", async () => {
    render(() => <Agreeing />);
    await userEvent.click(screen.getByText("Florals"));
    expect((box("Florals") as HTMLInputElement).checked).toBe(true);
    expect(document.activeElement).toBe(box("Florals"));
    expect(getComputedStyle(drawnBoxOf("Florals")).boxShadow).toBe("none");
  });

  it("keeps its input clipped out of sight, so focus paints the box's ring and nothing else", async () => {
    render(() => <Checkbox checked={false} onChange={() => {}} label="Florals" />);
    await userEvent.tab();
    const r = box("Florals").getBoundingClientRect();
    expect(r.width).toBeLessThanOrEqual(1);
    expect(r.height).toBeLessThanOrEqual(1);
  });

  it("draws today's box: 16px, the small corner, the strong hairline, the ground; the accent when ticked", () => {
    render(() => (
      <>
        <Checkbox checked={false} label="Off" />
        <Checkbox checked label="On" />
      </>
    ));
    const off = getComputedStyle(drawnBoxOf("Off"));
    expect([off.width, off.height]).toEqual(["16px", "16px"]);
    expect(off.borderTopWidth).toBe("1px");
    expect(off.borderTopColor).toBe(HAIRLINE_STRONG);
    expect(off.backgroundColor).toBe(GROUND);
    // `rounded-ui-sm` at the contract's fallback.
    expect(off.borderTopLeftRadius).toBe("4px");
    const { unmount } = render(() => <Checkbox checked={false} disabled label="Shut" />);
    expect(getComputedStyle(drawnBoxOf("Shut")).opacity).toBe("0.5");
    unmount();
    const on = getComputedStyle(drawnBoxOf("On"));
    expect(on.backgroundColor).toBe(ACCENT);
    expect(drawnBoxOf("On").querySelector("svg")).not.toBeNull();
    expect(drawnBoxOf("Off").querySelector("svg")).toBeNull();
  });

  it("sets the label at md, leading none, 8px from the box", () => {
    render(() => <Checkbox checked={false} label="Florals" />);
    const words = screen.getByText("Florals");
    const s = getComputedStyle(words);
    // `text-ui-base` and `leading-none` at the contract's fallbacks.
    expect([s.fontSize, s.lineHeight]).toEqual(["14.4px", "14.4px"]);
    expect(
      words.getBoundingClientRect().left - drawnBoxOf("Florals").getBoundingClientRect().right,
    ).toBe(8);
  });

  it("sets a label that wraps, with align start, at prose leading, on a first line the box fits", () => {
    // `leading-none` beside a centred box is pulse's one-line look; a label set
    // to wrap reads its second line at prose leading, and the slot that centres
    // the 16px box on the first line is that line's height.
    render(() => (
      <div style={{ width: "160px", "line-height": "1" }}>
        {(["sm", "md"] as const).map((size) => (
          <Checkbox
            checked={false}
            size={size}
            align="start"
            label={`Also remove these three tasks from the checklist, ${size}`}
          />
        ))}
      </div>
    ));
    for (const size of ["sm", "md"]) {
      const name = `Also remove these three tasks from the checklist, ${size}`;
      const words = screen.getByText(name);
      const s = getComputedStyle(words);
      expect({ size, ratio: parseFloat(s.lineHeight) / parseFloat(s.fontSize) > 1 }).toEqual({
        size,
        ratio: true,
      });
      const slot = drawnBoxOf(name).parentElement as HTMLElement;
      expect({ size, fits: slot.getBoundingClientRect().height >= 16 }).toEqual({
        size,
        fits: true,
      });
    }
  });
});

describe("Checkbox, native (cire's box)", () => {
  it("draws the unticked box: 13px, no fill, the strong hairline, a 2px corner", () => {
    render(() => <Checkbox box="native" checked={false} label="Off" />);
    const s = getComputedStyle(box("Off"));
    expect(s.appearance).toBe("none");
    expect([s.width, s.height]).toEqual(["13px", "13px"]);
    expect(s.borderTopWidth).toBe("1px");
    expect(s.borderTopColor).toBe(HAIRLINE_STRONG);
    expect(s.borderTopLeftRadius).toBe("2px");
    expect(s.backgroundColor).toBe("rgba(0, 0, 0, 0)");
  });

  it("leaves the ticked box to the browser, at the same size, so ticking moves nothing", async () => {
    render(() => <Agreeing box="native" />);
    const input = box("Florals");
    const before = input.getBoundingClientRect();
    await userEvent.click(screen.getByText("Florals"));
    expect((input as HTMLInputElement).checked).toBe(true);
    expect(getComputedStyle(input).appearance).toBe("auto");
    const after = input.getBoundingClientRect();
    expect([after.width, after.height, after.left, after.top]).toEqual([
      before.width,
      before.height,
      before.left,
      before.top,
    ]);
  });

  it("draws the house focus ring on keyboard focus, and fades only the edge", async () => {
    render(() => <Checkbox box="native" checked={false} onChange={() => {}} label="Florals" />);
    const input = box("Florals");
    expect(getComputedStyle(input).transitionProperty).toBe("border-color");
    await userEvent.tab();
    expect(document.activeElement).toBe(input);
    const s = getComputedStyle(input);
    expect(s.outlineStyle).toBe("solid");
    expect(s.outlineWidth).toBe("2px");
    expect(s.outlineOffset).toBe("2px");
    expect(s.outlineColor).toBe(FOCUS);
  });

  it("turns an unticked edge to the secondary ink under the pointer, unless disabled", async () => {
    render(() => (
      <>
        <Checkbox box="native" checked={false} label="Open" />
        <Checkbox box="native" checked={false} disabled label="Shut" />
      </>
    ));
    // The edge fades over `--ui-dur-fast` (120ms); read it once settled.
    const settled = () => new Promise((resolve) => setTimeout(resolve, 250));
    await userEvent.hover(box("Open"));
    await settled();
    expect(getComputedStyle(box("Open")).borderTopColor).toBe(INK_SECONDARY);
    await userEvent.hover(box("Shut"));
    await settled();
    expect(getComputedStyle(box("Shut")).borderTopColor).toBe(HAIRLINE_STRONG);
  });

  it("fades a disabled unticked box to 40%, and leaves its label at full ink", () => {
    render(() => <Checkbox box="native" checked={false} disabled label="Locked" />);
    expect(getComputedStyle(box("Locked")).opacity).toBe("0.4");
    expect(getComputedStyle(screen.getByText("Locked")).color).toBe(INK);
  });

  it("sets the label in body ink at either step, 8px from the box", () => {
    render(() => (
      <>
        <Checkbox box="native" size="sm" checked={false} label="Small" />
        <Checkbox box="native" checked={false} label="Medium" />
      </>
    ));
    const small = screen.getByText("Small");
    const medium = screen.getByText("Medium");
    expect(getComputedStyle(small).color).toBe(INK);
    expect(getComputedStyle(medium).color).toBe(INK);
    expect(parseFloat(getComputedStyle(small).fontSize)).toBeLessThan(
      parseFloat(getComputedStyle(medium).fontSize),
    );
    expect(small.getBoundingClientRect().left - box("Small").getBoundingClientRect().right).toBe(8);
  });
});
