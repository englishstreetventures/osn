// @vitest-environment happy-dom
import { cleanup, render, screen } from "@solidjs/testing-library";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Card, CardHeader } from "../src/ui/card";
import { Checkbox } from "../src/ui/checkbox";
import { Field, Fieldset } from "../src/ui/field";
import { Input } from "../src/ui/input";
import { meterPct } from "../src/ui/meter";
import { Table, Td } from "../src/ui/table";

/**
 * The DOM contract of the primitives lifted out of cire's two portals that the
 * real-Chromium tier does not already check: the cell prop that must not leak
 * into a native attribute, the meter's guard against an unset maximum, the
 * label wiring a JSX label and a second field depend on, the checkbox's
 * reported state, and the card's padding default.
 *
 * The claims that need a layout engine or that a browser check already makes
 * stronger — tones, glyphs, live regions, table scroll and focus, the meter,
 * hint and error wiring, control sizing and resize — live in the
 * `*.browser.test.tsx` files beside this one.
 */

afterEach(cleanup);

describe("Table cells", () => {
  it("keeps the native `align` attribute out of the way of the prop", () => {
    // `<td align>` is a deprecated native attribute typed
    // `"left" | "center" | "right"`. Intersecting rather than omitting it
    // narrows the prop to the one value both unions share, so `align="end"`
    // becomes a type error with a baffling message. This is the runtime half:
    // the value reaches the class list, not the attribute.
    const { getByRole } = render(() => (
      <Table label="Budget">
        <tbody>
          <tr>
            <Td align="end">1,240</Td>
          </tr>
        </tbody>
      </Table>
    ));
    expect(getByRole("cell").getAttribute("align")).toBeNull();
  });
});

describe("meterPct", () => {
  it("reads a zero or missing maximum as empty, not as a division by zero", () => {
    // A checklist with no items, a budget nobody has set yet.
    expect(meterPct(5, 0)).toBe(0);
    expect(meterPct(5, Number.NaN)).toBe(0);
  });
});

describe("Field", () => {
  it("takes JSX for the label, for the labels that carry a lower-case qualifier", () => {
    const { getByRole } = render(() => (
      <Field
        label={
          <>
            events.csv <span>(optional)</span>
          </>
        }
      >
        {(field) => <Input {...field} />}
      </Field>
    ));
    expect(getByRole("textbox")).toHaveAccessibleName("events.csv (optional)");
  });

  it("gives two fields on the same screen two different ids", () => {
    const { getAllByRole } = render(() => (
      <>
        <Field label="First">{(field) => <Input {...field} />}</Field>
        <Field label="Second">{(field) => <Input {...field} />}</Field>
      </>
    ));
    const [a, b] = getAllByRole("textbox");
    expect(a?.id).not.toBe(b?.id);
  });
});

describe("Fieldset", () => {
  it("groups a set of checkboxes under one legend", () => {
    const { getByRole } = render(() => (
      <Fieldset legend="Categories">
        <Checkbox checked={false} onChange={() => {}} label="Florals" />
        <Checkbox checked onChange={() => {}} label="Catering" />
      </Fieldset>
    ));
    expect(getByRole("group", { name: /categories/i })).toBeInTheDocument();
    expect(getByRole("checkbox", { name: "Florals" })).not.toBeChecked();
    expect(getByRole("checkbox", { name: "Catering" })).toBeChecked();
  });
});

describe("Checkbox", () => {
  it("reports the new state, not the old one", () => {
    const onChange = vi.fn();
    render(() => <Checkbox checked={false} onChange={onChange} label="Florals" />);
    screen.getByRole("checkbox", { name: "Florals" }).click();
    expect(onChange).toHaveBeenCalledWith(true);
  });
});

describe("Card", () => {
  it("adds no padding by default, so a composed card is not double-padded", () => {
    // `CardHeader`, `CardContent` and `CardFooter` carry their own padding. A
    // default on the Card would add to theirs, which is why `none` is the
    // default rather than an oversight.
    const { container } = render(() => (
      <Card>
        <CardHeader>Head</CardHeader>
      </Card>
    ));
    const card = container.firstElementChild!;
    expect([...card.classList].some((c) => /^base:p-\d/.test(c))).toBe(false);
  });

  it("gives each padding step a different class, or the prop is decoration", () => {
    const classes = (["sm", "md", "lg"] as const).map((padding) => {
      const { container, unmount } = render(() => <Card padding={padding}>body</Card>);
      const c = container.firstElementChild!.className;
      unmount();
      return c;
    });
    expect(new Set(classes).size).toBe(3);
  });
});
