import DietaryPresetsPopover from "@cire/ui/dietary-presets-popover";
import { Input } from "@shared/ui/ui/input";
import { cleanup, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";

import DatePicker from "../../src/components/DatePicker";

import "../../src/styles/global.css";

/**
 * The two field-shaped triggers that are not an `Input` or a `Select` — the
 * date picker's and the dietary picker's — stand beside form fields, so each is
 * the form field's 34px (`DESIGN.md` §4, "One form-field height"). The form-field
 * guard reads only `Input` and `Select` tags, so this measures the two in a real
 * engine, beside a `size="form"` field.
 */

afterEach(cleanup);

describe("field-shaped triggers", () => {
  it("sit level with a form field: the date picker's trigger and its read-only box", async () => {
    await page.viewport(1280, 800);
    render(() => (
      <div class="bg-bg text-text flex items-end gap-3 p-4">
        <DatePicker label="Date" value="2099-06-20" onChange={() => {}} />
        <DatePicker label="Fixed date" value="2099-06-20" onChange={() => {}} readOnly />
        <Input size="form" aria-label="Time" type="time" />
      </div>
    ));
    const field = screen.getByLabelText("Time").getBoundingClientRect().height;
    const trigger = screen.getByRole("button", { name: /^Date/ }).getBoundingClientRect().height;
    const fixed = screen
      .getByRole("textbox", { name: "Fixed date" })
      .getBoundingClientRect().height;
    expect([field, trigger, fixed]).toEqual([34, 34, 34]);
  });

  it("draw the form field's own box: the date picker's trigger and its read-only box", async () => {
    // The trigger and the read-only box are the shared control at `form`, so
    // their edge, fill, ink, corner and focus are a form field's: the strong
    // hairline rather than the 1.27:1 hairline, the value in full ink, and the
    // house focus colour, never a faded gold ring.
    await page.viewport(1280, 800);
    render(() => (
      <div class="bg-bg text-text flex items-end gap-3 p-4">
        <DatePicker label="Date" value="2099-06-20" onChange={() => {}} />
        <DatePicker label="Fixed date" value="2099-06-20" onChange={() => {}} readOnly />
        <Input size="form" aria-label="Time" type="time" />
      </div>
    ));
    const field = screen.getByLabelText("Time");
    const trigger = screen.getByRole("button", { name: /^Date/ });
    const fixed = screen.getByRole("textbox", { name: "Fixed date" });
    expect([(fixed as HTMLInputElement).readOnly, (fixed as HTMLInputElement).value]).toEqual([
      true,
      "Saturday 20 June 2099",
    ]);
    const box = (el: HTMLElement) => {
      const s = getComputedStyle(el);
      return [s.borderTopColor, s.backgroundColor, s.color, s.opacity, s.borderTopLeftRadius];
    };
    expect({ trigger: box(trigger), fixed: box(fixed) }).toEqual({
      trigger: box(field),
      fixed: box(field),
    });
    const focus = (el: HTMLElement) => {
      const s = getComputedStyle(el);
      return [s.boxShadow, s.outlineStyle, s.borderTopColor];
    };
    await userEvent.tab();
    expect(document.activeElement).toBe(trigger);
    const triggerFocus = focus(trigger);
    await userEvent.tab();
    await userEvent.tab();
    expect(document.activeElement).toBe(field);
    expect(triggerFocus).toEqual(focus(field));
  });

  it("shows an unset read-only date as a placeholder in the secondary ink", () => {
    render(() => (
      <div class="bg-bg text-text p-4">
        <DatePicker label="Fixed date" value={null} onChange={() => {}} readOnly />
      </div>
    ));
    const fixed = screen.getByRole("textbox", { name: "Fixed date" });
    expect([fixed.getAttribute("placeholder"), (fixed as HTMLInputElement).value]).toEqual([
      "No date set",
      "",
    ]);
  });

  it("sit level with a form field: the dietary picker's trigger", async () => {
    // The popover form is drawn from 48rem; narrower, the pills sit inline.
    await page.viewport(1280, 800);
    render(() => (
      <div class="bg-bg text-text flex items-end gap-3 p-4">
        <div class="w-64">
          <DietaryPresetsPopover value={[]} onChange={() => {}} label="Bo" />
        </div>
        <Input size="form" aria-label="Note" />
      </div>
    ));
    const field = screen.getByLabelText("Note").getBoundingClientRect().height;
    const trigger = screen
      .getByRole("button", { name: /Add dietary requirements/ })
      .getBoundingClientRect().height;
    expect([field, trigger]).toEqual([34, 34]);
  });
});
