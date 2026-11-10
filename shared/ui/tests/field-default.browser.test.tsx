/**
 * `Field` and `Fieldset` as cire draws them, held exactly: the class strings,
 * the order the parts sit in, and what they paint.
 *
 * Cire's host and vendor portals and `@cire/ui` draw `Field` in twenty-four
 * files, every one with the default small-caps label. This file is what lets a
 * change to `Field` that is meant for another app claim that cire's forms do
 * not move. It imports only what `field.tsx` and `input.tsx` exported before
 * `Field` gained a second label treatment, so it runs on the code before such
 * a change as well as after it.
 *
 * What `form.browser.test.tsx` and `lifted.test.tsx` already hold is not
 * repeated here: the label reaching its control, the hint describing rather
 * than naming, the error id before the hint id, the caret kept on a rejected
 * save, the error's danger colour and alert role, and a hidden label's box.
 */

import { cleanup, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it } from "vitest";

import { Field, Fieldset } from "../src/ui/field";
import { Input } from "../src/ui/input";

import "./test-support/tailwind.css";

afterEach(cleanup);

const LABEL =
  "base:font-ui-body base:text-ui-ink-secondary base:text-ui-xs base:tracking-ui-wider base:uppercase";

function renderBudget() {
  render(() => (
    <Field
      class="w-64"
      label="Total budget"
      hint="Whole dollars"
      errors={["Must be a number", "Must be above zero"]}
    >
      {(field) => <Input {...field} />}
    </Field>
  ));
  const input = screen.getByRole("textbox");
  const wrapper = input.parentElement!;
  return {
    input,
    wrapper,
    label: screen.getByText("Total budget"),
    hint: screen.getByText("Whole dollars"),
    alert: screen.getByRole("alert"),
  };
}

describe("the default Field", () => {
  it("renders exactly the classes it rendered before the plain label", () => {
    const { wrapper, label, hint, alert } = renderBudget();
    expect(wrapper.getAttribute("class")).toBe("base:flex base:flex-col base:gap-1.5 w-64");
    expect(label.getAttribute("class")).toBe(LABEL);
    expect(hint.getAttribute("class")).toBe(
      "base:font-ui-body base:text-ui-ink-secondary base:text-ui-xs base:leading-ui-snug",
    );
    expect(alert.getAttribute("class")).toBe("base:flex base:flex-col base:gap-0.5");
    for (const message of alert.children) {
      expect(message.getAttribute("class")).toBe(
        "base:font-ui-body base:text-ui-danger base:text-ui-sm",
      );
    }

    cleanup();
    render(() => (
      <Field label="Guest name" labelHidden>
        {(field) => <Input {...field} />}
      </Field>
    ));
    expect(screen.getByText("Guest name").getAttribute("class")).toBe("base:sr-only");
  });

  it("keeps the label, control, hint and errors as siblings, in that order", () => {
    const { wrapper, label, alert } = renderBudget();
    expect(Array.from(wrapper.children, (child) => child.tagName)).toEqual([
      "LABEL",
      "INPUT",
      "P",
      "DIV",
    ]);
    expect(label.parentElement).toBe(wrapper);
    expect(Array.from(alert.children, (child) => child.tagName)).toEqual(["P", "P"]);
  });

  it("paints what those classes paint", () => {
    const { wrapper, label, hint, alert } = renderBudget();

    const caps = getComputedStyle(label);
    expect(caps.textTransform).toBe("uppercase");
    // `--ui-text-xs` falls back to 0.7rem, and `--ui-tracking-wider` to 0.1em of that.
    expect(caps.fontSize).toBe("11.2px");
    expect(caps.letterSpacing).toBe("1.12px");
    // `--ui-ink-secondary` in the test palette.
    expect(caps.color).toBe("rgb(74, 74, 88)");
    expect(caps.fontWeight).toBe("400");

    expect(getComputedStyle(wrapper).rowGap).toBe("6px");
    expect(getComputedStyle(hint).fontSize).toBe("11.2px");
    expect(alert.children).toHaveLength(2);
    for (const message of alert.children) {
      expect(getComputedStyle(message).fontSize).toBe("12.8px");
    }
    expect(getComputedStyle(alert).rowGap).toBe("2px");
    // The flex gap, with no margin on either side, so no font moves it.
    expect(alert.getBoundingClientRect().top - hint.getBoundingClientRect().bottom).toBe(6);
  });
});

describe("the default Fieldset", () => {
  it("draws its legend as a Field's label, 6px above the first control", () => {
    render(() => (
      <Fieldset class="w-64" legend="Categories">
        <Input aria-label="Florals" />
      </Fieldset>
    ));
    const legend = screen.getByText("Categories");
    expect(legend.parentElement!.getAttribute("class")).toBe(
      "base:m-0 base:flex base:flex-col base:gap-1.5 base:border-0 base:p-0 w-64",
    );
    expect(legend.getAttribute("class")).toBe(`${LABEL} base:mb-1.5`);

    const style = getComputedStyle(legend);
    expect(style.textTransform).toBe("uppercase");
    expect(style.fontSize).toBe("11.2px");
    expect(style.letterSpacing).toBe("1.12px");
    expect(style.color).toBe("rgb(74, 74, 88)");
    expect(style.marginBottom).toBe("6px");
  });
});
