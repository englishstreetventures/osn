/**
 * The form controls and the scaffolding around them.
 *
 * Almost every claim these make is a claim about what a browser does with them,
 * and the unit tier can see none of it: whether the size variants are actually
 * different sizes, whether `aria-invalid` turns a border that a person can see,
 * whether a label reaches its control, whether a rejected save destroys the box
 * somebody is typing in. A shim can confirm the class string and the attribute
 * and tell you nothing about any of that.
 */

import { render } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { describe, expect, it } from "vitest";

import { Field, Fieldset } from "../src/ui/field";
import { Input } from "../src/ui/input";
import { Select } from "../src/ui/select";
import { Textarea } from "../src/ui/textarea";

import "./test-support/tailwind.css";

const px = (el: Element, prop: "fontSize" | "paddingLeft") =>
  Number.parseFloat(getComputedStyle(el)[prop]);

describe("the control box", () => {
  it("makes `sm` genuinely smaller than `md`, rather than only differently named", () => {
    const md = render(() => <Input placeholder="md" />);
    const sm = render(() => <Input size="sm" placeholder="sm" />);

    const mdBox = md.getByPlaceholderText("md");
    const smBox = sm.getByPlaceholderText("sm");

    expect(px(smBox, "fontSize")).toBeLessThan(px(mdBox, "fontSize"));
    expect(px(smBox, "paddingLeft")).toBeLessThan(px(mdBox, "paddingLeft"));
  });

  it("gives an input, a textarea and a select the same box", () => {
    // The drift this replaces: four input shapes across the write surfaces, so
    // a date and a currency on one form did not line up. Padding and type size
    // are what made them differ, so those are what this pins together.
    const { getByRole, getByPlaceholderText } = render(() => (
      <>
        <Input placeholder="text" />
        <Textarea placeholder="note" />
        <Select>
          <option>one</option>
        </Select>
      </>
    ));

    const boxes = [
      getByPlaceholderText("text"),
      getByPlaceholderText("note"),
      getByRole("combobox"),
    ];
    const sizes = boxes.map((b) => `${px(b, "fontSize")}/${px(b, "paddingLeft")}`);
    expect(new Set(sizes).size).toBe(1);
  });

  it("paints a focus ring that is the focus token and not the accent", () => {
    // Its own token on purpose: a focus indicator has a 3:1 floor and plenty of
    // brand colours do not clear it. This asserts the utility resolves at all —
    // `focus-visible:ring-ui-focus` emitting nothing would be invisible to
    // every string assertion in the repo.
    const { getByRole } = render(() => <Input />);
    const input = getByRole("textbox") as HTMLInputElement;
    input.focus();
    expect(getComputedStyle(input).getPropertyValue("--tw-ring-color").trim()).not.toBe("");
  });

  it("turns the control's own border when it is marked invalid", () => {
    // Without this the error state lives only in the message underneath, which
    // is below the fold on a long form and gone entirely for anyone scanning.
    const ok = render(() => <Input />);
    const bad = render(() => <Input aria-invalid="true" />);

    const okBorder = getComputedStyle(ok.getByRole("textbox")).borderTopColor;
    const badBorder = getComputedStyle(bad.getByRole("textbox")).borderTopColor;

    expect(badBorder).not.toBe(okBorder);
    expect(badBorder).toBe(paintToken("--ui-danger"));
  });

  it("puts a pointer over a select and a caret over an input", () => {
    const { getByRole, getByPlaceholderText } = render(() => (
      <>
        <Input placeholder="text" />
        <Select>
          <option>one</option>
        </Select>
      </>
    ));
    expect(getComputedStyle(getByRole("combobox")).cursor).toBe("pointer");
    expect(getComputedStyle(getByPlaceholderText("text")).cursor).not.toBe("pointer");
  });

  it("lets a caller's class win, because every default is zero-specificity", () => {
    const { getByRole } = render(() => <Input class="bg-ui-accent" />);
    expect(getComputedStyle(getByRole("textbox")).backgroundColor).toBe(paintToken("--ui-accent"));
  });

  it("honours `resize` as a prop, which a passed class cannot do reliably", () => {
    // Both classes land on the element, and Tailwind resolves a conflict by
    // stylesheet order rather than attribute order — so `class="resize-none"`
    // is a coin flip and the prop is not.
    const y = render(() => <Textarea />);
    const none = render(() => <Textarea resize="none" />);
    expect(getComputedStyle(y.getByRole("textbox")).resize).toBe("vertical");
    expect(getComputedStyle(none.getByRole("textbox")).resize).toBe("none");
  });
});

describe("Field", () => {
  it("wires the label to the control it was given", () => {
    // `getByLabelText` resolves the association the way an assistive technology
    // would, so this fails if the minted id ever stops reaching the control.
    const { getByLabelText } = render(() => (
      <Field label="Wedding name">{(field) => <Input {...field} />}</Field>
    ));
    expect(getByLabelText("Wedding name").tagName).toBe("INPUT");
  });

  it("describes with the hint instead of naming with it", () => {
    // The defect this component exists for: a hint inside the `<label>` becomes
    // part of the accessible NAME, so the box is announced as "Wedding name,
    // shown to guests" and re-announced in full whenever the hint changes.
    const { getByLabelText, container } = render(() => (
      <Field label="Wedding name" hint="Shown to guests">
        {(field) => <Input {...field} />}
      </Field>
    ));

    const input = getByLabelText("Wedding name");
    const describedBy = input.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    expect(container.querySelector(`#${describedBy}`)?.textContent).toBe("Shown to guests");
    expect(input.getAttribute("aria-label")).toBeNull();
  });

  it("announces the error before the format note it just broke", () => {
    const { getByRole } = render(() => (
      <Field label="Budget" hint="Whole dollars" errors={["Must be a number"]}>
        {(field) => <Input {...field} />}
      </Field>
    ));
    const ids = getByRole("textbox").getAttribute("aria-describedby")?.split(" ") ?? [];
    expect(ids).toHaveLength(2);
    expect(ids[0]).toMatch(/-error$/);
    expect(ids[1]).toMatch(/-hint$/);
  });

  it("keeps the caret and the focus when a save comes back rejected", async () => {
    // The reason `children` is called under `untrack` and held. A call in child
    // position compiles to a render effect, and `errors` is reactive — so the
    // first rejected save would dispose the control and mount a new one,
    // throwing away focus and the caret at the exact moment somebody is fixing
    // what they typed. This is that, made falsifiable.
    const [errors, setErrors] = createSignal<readonly string[]>([]);
    const { getByRole } = render(() => (
      <Field label="Budget" errors={errors()}>
        {(field) => <Input {...field} value="12345" />}
      </Field>
    ));

    const before = getByRole("textbox") as HTMLInputElement;
    before.focus();
    before.setSelectionRange(3, 3);

    setErrors(["Must be a number"]);
    await Promise.resolve();

    const after = getByRole("textbox") as HTMLInputElement;
    expect(after).toBe(before);
    expect(document.activeElement).toBe(after);
    expect(after.selectionStart).toBe(3);

    // And the attribute still updated on the node that stayed put.
    expect(after.getAttribute("aria-invalid")).toBe("true");
  });

  it("paints the error message in the danger tone and speaks it", () => {
    const { getByRole } = render(() => (
      <Field label="Budget" errors={["Must be a number"]}>
        {(field) => <Input {...field} />}
      </Field>
    ));
    const alert = getByRole("alert");
    expect(alert.textContent).toBe("Must be a number");
    expect(getComputedStyle(alert.querySelector("p")!).color).toBe(paintToken("--ui-danger"));
  });

  it("hides a label from the eye without hiding it from a reader", () => {
    const { getByLabelText } = render(() => (
      <Field label="Guest name" labelHidden>
        {(field) => <Input {...field} />}
      </Field>
    ));
    const input = getByLabelText("Guest name");
    const label = document.querySelector(`label[for='${input.id}']`)!;

    // `sr-only` is a 1px clipped box, not `display: none` — the distinction is
    // the whole point, and it is only visible to a browser.
    expect(getComputedStyle(label).display).not.toBe("none");
    expect(label.getBoundingClientRect().width).toBeLessThan(2);
  });
});

describe("Fieldset", () => {
  it("groups its controls, so each option is announced under one question", () => {
    const { getByRole } = render(() => (
      <Fieldset legend="Guest code style">
        <label>
          <input type="radio" name="style" /> Words
        </label>
        <label>
          <input type="radio" name="style" /> Digits
        </label>
      </Fieldset>
    ));
    expect(getByRole("group", { name: "Guest code style" })).toBeTruthy();
  });

  it("drops the browser's default frame, which is what stops it looking like 1997", () => {
    const { getByRole } = render(() => (
      <Fieldset legend="Categories">
        <span>one</span>
      </Fieldset>
    ));
    // Width rather than style: the UA sheet gives a fieldset a 2px groove, and
    // `border-0` zeroes the width while leaving the style word in place. Width
    // is what is drawn.
    const style = getComputedStyle(getByRole("group"));
    expect(Number.parseFloat(style.borderTopWidth)).toBe(0);
    expect(Number.parseFloat(style.paddingInlineStart)).toBe(0);
  });
});

/** The colour a token resolves to, by letting the browser resolve it. */
function paintToken(name: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const probe = document.createElement("div");
  probe.style.color = value;
  document.body.append(probe);
  const computed = getComputedStyle(probe).color;
  probe.remove();
  return computed;
}
