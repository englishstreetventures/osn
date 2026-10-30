/**
 * The radio group, measured where it is painted, in both of its boxes.
 *
 * `drawn` is pulse's: a visually hidden input beside a painted circle, held at
 * the values Kobalte's part drew, because pulse must not move. `native` is
 * cire's: the browser's own radio when chosen, a drawn ring when not. Both are
 * native inputs sharing one name, so the keyboard is the platform's.
 */

import { cleanup, render, screen } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, describe, expect, it } from "vitest";
import { userEvent } from "vitest/browser";

import { RadioGroup, RadioGroupItem, type RadioOrientation } from "../src/ui/radio-group";

import "./test-support/tailwind.css";

afterEach(cleanup);

/** Test-palette values (`test-support/tailwind.css`). */
const FOCUS = "rgb(47, 75, 216)";
const HAIRLINE_STRONG = "rgb(125, 125, 140)";
const GROUND = "rgb(255, 255, 255)";
const ACCENT = "rgb(47, 75, 216)";

const radio = (name: string) => screen.getByRole("radio", { name }) as HTMLInputElement;
const circleOf = (name: string) => radio(name).nextElementSibling as HTMLElement;

/** A group whose parent agrees to every choice, or refuses every one. */
function Choice(props: {
  box?: "drawn" | "native";
  refuse?: boolean;
  orientation?: RadioOrientation;
  disabled?: boolean;
  smsDisabled?: boolean;
  onChange?: (value: string) => void;
}) {
  const [value, setValue] = createSignal("email");
  return (
    <RadioGroup
      box={props.box}
      value={value()}
      orientation={props.orientation}
      disabled={props.disabled}
      onChange={(next) => {
        props.onChange?.(next);
        if (!props.refuse) setValue(next);
      }}
      aria-label="Contact by"
    >
      <RadioGroupItem value="email" label="Email" />
      <RadioGroupItem value="sms" label="SMS" disabled={props.smsDisabled} />
      <RadioGroupItem value="post" label="Post" />
    </RadioGroup>
  );
}

describe("RadioGroup, either box", () => {
  for (const kind of ["drawn", "native"] as const) {
    describe(`${kind}`, () => {
      it("names the group by aria-label", () => {
        render(() => <Choice box={kind} />);
        expect(screen.getByRole("radiogroup", { name: "Contact by" })).toBeTruthy();
      });

      it("disables one radio, or every radio from the group", () => {
        const { unmount } = render(() => <Choice box={kind} smsDisabled />);
        expect([radio("Email").disabled, radio("SMS").disabled]).toEqual([false, true]);
        unmount();
        render(() => <Choice box={kind} disabled />);
        expect(["Email", "SMS", "Post"].map((n) => radio(n).disabled)).toEqual([true, true, true]);
      });

      it("reports the value whose label is clicked", async () => {
        let picked: string | undefined;
        render(() => <Choice box={kind} onChange={(v) => (picked = v)} />);
        await userEvent.click(screen.getByText("SMS"));
        expect(picked).toBe("sms");
        expect([radio("Email").checked, radio("SMS").checked]).toEqual([false, true]);
      });

      it("shows a refused choice as not made", async () => {
        render(() => <Choice box={kind} refuse />);
        await userEvent.click(screen.getByText("SMS"));
        expect([radio("Email").checked, radio("SMS").checked]).toEqual([true, false]);
      });

      it("moves to and reports the next radio on the arrow key", async () => {
        let picked: string | undefined;
        render(() => <Choice box={kind} onChange={(v) => (picked = v)} />);
        await userEvent.tab();
        expect(document.activeElement).toBe(radio("Email"));
        await userEvent.keyboard("{ArrowDown}");
        expect(picked).toBe("sms");
        expect(document.activeElement).toBe(radio("SMS"));
      });
    });
  }
});

describe("RadioGroup, drawn (pulse's circle, which must not move)", () => {
  it("rings the circle in the focus colour when its input takes keyboard focus", async () => {
    render(() => <Choice />);
    const circle = circleOf("Email");
    expect(getComputedStyle(circle).boxShadow).toBe("none");
    await userEvent.tab();
    expect(document.activeElement).toBe(radio("Email"));
    expect(getComputedStyle(circle).boxShadow).toContain(FOCUS);
    expect(getComputedStyle(circleOf("SMS")).boxShadow).toBe("none");
  });

  it("paints no ring after a pointer click, which focuses the input too", async () => {
    render(() => <Choice />);
    await userEvent.click(screen.getByText("SMS"));
    expect(getComputedStyle(circleOf("SMS")).boxShadow).toBe("none");
  });

  it("draws today's circle, dot and gaps", () => {
    render(() => <Choice />);
    const off = getComputedStyle(circleOf("SMS"));
    expect([off.width, off.height]).toEqual(["16px", "16px"]);
    expect(off.borderTopColor).toBe(HAIRLINE_STRONG);
    expect(off.backgroundColor).toBe(GROUND);
    expect(getComputedStyle(circleOf("Email")).borderTopColor).toBe(ACCENT);
    const dot = circleOf("Email").firstElementChild as HTMLElement;
    const after = getComputedStyle(dot, "::after");
    expect([after.width, after.height, after.backgroundColor]).toEqual(["10px", "10px", ACCENT]);
    expect(circleOf("SMS").firstElementChild).toBeNull();
    // 4px from circle to word; 8px between items.
    const word = screen.getByText("SMS");
    expect(word.getBoundingClientRect().left - circleOf("SMS").getBoundingClientRect().right).toBe(
      4,
    );
    expect(getComputedStyle(screen.getByRole("radiogroup")).columnGap).toBe("8px");
  });
});

describe("RadioGroup, native (cire's radio)", () => {
  it("draws the unchosen radio round at 13px, and leaves the chosen one to the browser at the same size", async () => {
    render(() => <Choice box="native" />);
    const off = getComputedStyle(radio("SMS"));
    expect(off.appearance).toBe("none");
    expect([off.width, off.height]).toEqual(["13px", "13px"]);
    expect(off.borderTopColor).toBe(HAIRLINE_STRONG);
    expect(off.borderTopLeftRadius).toBe("50%");
    const before = radio("SMS").getBoundingClientRect();
    await userEvent.click(screen.getByText("SMS"));
    expect(getComputedStyle(radio("SMS")).appearance).toBe("auto");
    const after = radio("SMS").getBoundingClientRect();
    expect([after.width, after.height]).toEqual([before.width, before.height]);
  });

  it("draws the house focus ring on keyboard focus", async () => {
    render(() => <Choice box="native" />);
    await userEvent.tab();
    const s = getComputedStyle(radio("Email"));
    expect([s.outlineStyle, s.outlineWidth, s.outlineOffset, s.outlineColor]).toEqual([
      "solid",
      "2px",
      "2px",
      FOCUS,
    ]);
  });

  it("puts 16px between radios in a row, 8px in a column, and 8px from radio to word", () => {
    const { unmount } = render(() => <Choice box="native" />);
    const row = (n: string) => radio(n).closest("label")!.getBoundingClientRect();
    expect(row("SMS").left - row("Email").right).toBe(16);
    expect(
      screen.getByText("SMS").getBoundingClientRect().left -
        radio("SMS").getBoundingClientRect().right,
    ).toBe(8);
    unmount();
    render(() => <Choice box="native" orientation="vertical" />);
    expect(row("SMS").top - row("Email").bottom).toBe(8);
  });
});
