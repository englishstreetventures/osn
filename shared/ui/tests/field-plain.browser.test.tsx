/**
 * `Field` with `labelTreatment="plain"`: the label `Label` draws by default —
 * sentence case, full ink, weight 500, the control type step — in place of
 * cire's small caps, and nothing else about the field changed.
 *
 * Musubi and `@osn/auth-ui` write their forms as a `Label` above a control.
 * The plain treatment lets those forms take `Field`'s wiring without taking
 * cire's label, so the two claims worth a browser are that the plain label
 * paints what a `Label` paints, and that the hint, the errors and the gaps
 * are the default's own. `field-default.browser.test.tsx` holds the default.
 */

import { cleanup, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it } from "vitest";
import { page } from "vitest/browser";

import { Field, type FieldProps } from "../src/ui/field";
import { Input } from "../src/ui/input";
import { Label } from "../src/ui/label";

import "./test-support/tailwind.css";

afterEach(cleanup);

type Treatment = NonNullable<FieldProps["labelTreatment"]>;

const shot = (name: string) => `__screenshots__/field-plain.browser.test.tsx/${name}.png`;

const LOOK = [
  "fontSize",
  "fontWeight",
  "color",
  "lineHeight",
  "letterSpacing",
  "textTransform",
  "fontFamily",
] as const;

const look = (element: Element) => {
  const style = getComputedStyle(element);
  return Object.fromEntries(LOOK.map((name) => [name, style[name]]));
};

describe("the plain label", () => {
  it("paints what a Label paints, and not what the default paints", () => {
    render(() => (
      <div class="w-64">
        <Label for="probe">Probe</Label>
        <input id="probe" />
        <Field labelTreatment="plain" label="Email">
          {(field) => <Input {...field} />}
        </Field>
        <Field label="Phone">{(field) => <Input {...field} />}</Field>
      </div>
    ));
    const plain = screen.getByText("Email");
    const probe = screen.getByText("Probe");
    const caps = screen.getByText("Phone");

    expect(look(plain)).toEqual(look(probe));
    // Spelled out as well, since a `Label` that drifted would carry this with it.
    const style = getComputedStyle(plain);
    expect(style.textTransform).toBe("none");
    expect(style.fontWeight).toBe("500");
    // `--ui-ink` in the test palette, and `--ui-text-base`'s 0.9rem fallback.
    expect(style.color).toBe("rgb(26, 26, 34)");
    expect(style.fontSize).toBe("14.4px");

    // The stylesheet tells the two treatments apart, so the equality above
    // is not two unstyled labels agreeing.
    expect(getComputedStyle(caps).fontSize).not.toBe(style.fontSize);
    expect(getComputedStyle(caps).textTransform).toBe("uppercase");

    // Still the control's name.
    expect(screen.getByRole("textbox", { name: "Email" })).toBeTruthy();
  });
});

describe("everything but the label", () => {
  function budget(treatment: Treatment) {
    render(() => (
      <Field
        class="w-64"
        labelTreatment={treatment}
        label={`Budget ${treatment}`}
        hint="Whole dollars"
        errors={["Must be a number", "Must be above zero"]}
      >
        {(field) => <Input {...field} />}
      </Field>
    ));
    const input = screen.getByRole("textbox", { name: `Budget ${treatment}` });
    const wrapper = input.parentElement!;
    const alert = wrapper.querySelector("[role='alert']")!;
    const hint = wrapper.querySelector("p")!;
    return {
      classes: [wrapper, hint, alert, ...alert.children].map((el) => el.getAttribute("class")),
      describedBy: input
        .getAttribute("aria-describedby")
        ?.split(" ")
        .map((id) => id.replace(/^.*-/, "")),
      invalid: input.getAttribute("aria-invalid"),
    };
  }

  it("is the default's own: the same classes, the same wiring", () => {
    const plain = budget("plain");
    const caps = budget("caps");
    expect(plain.classes).toHaveLength(5);
    expect(plain.classes).toEqual(caps.classes);
    expect(plain.describedBy).toEqual(["error", "hint"]);
    expect(caps.describedBy).toEqual(["error", "hint"]);
    expect(plain.invalid).toBe("true");
    expect(caps.invalid).toBe("true");
  });

  it("puts each error 6px under the box, at the small step, announced", () => {
    render(() => (
      <Field class="w-64" labelTreatment="plain" label="Email" errors={["Enter a whole address"]}>
        {(field) => <Input {...field} value="ada@example" />}
      </Field>
    ));
    const input = screen.getByRole("textbox", { name: "Email" });
    const alert = screen.getByRole("alert");
    expect(alert.getBoundingClientRect().top - input.getBoundingClientRect().bottom).toBe(6);
    // `--ui-text-sm`'s 0.8rem fallback.
    expect(getComputedStyle(alert.querySelector("p")!).fontSize).toBe("12.8px");
    expect(input.getAttribute("aria-describedby")).toBe(alert.id);
  });
});

describe("the look, for a reviewer", () => {
  it("leaves a screenshot of a plain form beside the default", async () => {
    const column = (treatment: Treatment) => (
      <div class="flex w-64 flex-col gap-4">
        <Field labelTreatment={treatment} label="Email" errors={["Enter a whole address"]}>
          {(field) => <Input {...field} value="ada@example" />}
        </Field>
        <Field
          labelTreatment={treatment}
          label="Date of birth"
          errors={["You must be at least 13 to sign up"]}
        >
          {(field) => <Input {...field} type="date" value="2020-01-01" />}
        </Field>
        <Field
          labelTreatment={treatment}
          label={
            <>
              Display name <span class="text-ui-ink-secondary font-normal">(optional)</span>
            </>
          }
          hint="Shown on your profile"
        >
          {(field) => <Input {...field} />}
        </Field>
      </div>
    );
    render(() => (
      <div data-testid="frame" class="bg-ui-ground flex gap-8 p-6">
        {column("plain")}
        {column("caps")}
      </div>
    ));
    await page.screenshot({
      path: shot("plain-beside-default"),
      element: screen.getByTestId("frame"),
    });
    expect(screen.getAllByRole("alert")).toHaveLength(4);
  });
});
