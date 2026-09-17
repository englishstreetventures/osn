// @vitest-environment happy-dom
import { cleanup, render, screen } from "@solidjs/testing-library";
import "@testing-library/jest-dom/vitest";
import { createSignal } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Card, CardHeader } from "../src/ui/card";
import { Checkbox } from "../src/ui/checkbox";
import { Chip } from "../src/ui/chip";
import { EmptyState } from "../src/ui/empty-state";
import { Field, Fieldset } from "../src/ui/field";
import { Input } from "../src/ui/input";
import { Meter, meterPct } from "../src/ui/meter";
import { Notice } from "../src/ui/notice";
import { Select } from "../src/ui/select";
import { Stat } from "../src/ui/stat";
import { Table, Td, Th } from "../src/ui/table";
import { Textarea } from "../src/ui/textarea";

/**
 * The DOM contract of the primitives lifted out of cire's two portals.
 *
 * These came with the components. They are deliberately class-agnostic — a test
 * that asserts the class list pins the current answer rather than the contract,
 * and has to be edited every time the design moves. What they check is what a
 * call site can rely on: the accessibility wiring, that props reach the DOM,
 * that variants differ from one another, and the one piece of arithmetic in the
 * set.
 *
 * They sit at the unit tier because none of it needs a layout engine. The
 * claims that DO — that a tone is actually painted, that `sm` is really smaller
 * than `md`, that a table scrolls — are in the `*.browser.test.tsx` files
 * beside this one, and neither tier can stand in for the other.
 */

afterEach(cleanup);

describe("Notice", () => {
  it("says nothing to assistive tech by default", () => {
    // A standing note that was on screen before the host arrived has nothing to
    // interrupt anyone about.
    const { queryByRole } = render(() => <Notice tone="info">Two hosts can edit.</Notice>);
    expect(queryByRole("alert")).toBeNull();
  });

  it("announces itself when it appeared in answer to something", () => {
    const { getByRole } = render(() => (
      <Notice tone="danger" alert>
        Could not save.
      </Notice>
    ));
    expect(getByRole("alert")).toHaveTextContent("Could not save.");
  });

  it("gives each tone a different look", () => {
    const { getAllByTestId } = render(() => (
      <>
        <Notice tone="danger" data-testid="n">
          E
        </Notice>
        <Notice tone="warn" data-testid="n">
          W
        </Notice>
        <Notice tone="success" data-testid="n">
          S
        </Notice>
        <Notice tone="info" data-testid="n">
          I
        </Notice>
      </>
    ));
    const classes = getAllByTestId("n").map((el) => el.className);
    expect(new Set(classes).size).toBe(4);
  });

  it("marks the three that report an outcome, and each with a different shape", () => {
    // Hue alone would put "saved" and "failed to save" in the same rectangle,
    // and error and warn are the closest pair in the palette.
    const { getAllByTestId } = render(() => (
      <>
        <Notice tone="danger" data-testid="n">
          E
        </Notice>
        <Notice tone="warn" data-testid="n">
          W
        </Notice>
        <Notice tone="success" data-testid="n">
          S
        </Notice>
      </>
    ));
    const glyphs = getAllByTestId("n").map(
      (el) => el.querySelector("[aria-hidden='true']")?.textContent,
    );
    expect(glyphs.every(Boolean)).toBe(true);
    expect(new Set(glyphs).size).toBe(3);
  });

  it("says the word a glyph cannot be heard as", () => {
    const { getByRole } = render(() => (
      <Notice tone="danger" alert>
        Could not save.
      </Notice>
    ));
    expect(getByRole("alert")).toHaveTextContent("Error: Could not save.");
  });

  it("leaves the standing note unmarked", () => {
    // Nothing has happened, so there is no outcome to signal.
    const { getByTestId } = render(() => (
      <Notice tone="info" data-testid="n">
        Two hosts can edit.
      </Notice>
    ));
    expect(getByTestId("n").querySelector("[aria-hidden='true']")).toBeNull();
  });
});

describe("EmptyState", () => {
  it("leads with the title", () => {
    const { getByText } = render(() => <EmptyState title="No guests yet" />);
    expect(getByText("No guests yet")).toBeInTheDocument();
  });

  it("holds the one thing to do about it", () => {
    const { getByRole } = render(() => (
      <EmptyState
        title="No guests yet"
        description="Add them one at a time, or import a spreadsheet."
        action={<button type="button">Add a guest</button>}
      />
    ));
    expect(getByRole("button")).toHaveTextContent("Add a guest");
  });

  it("leaves the description out when there is none", () => {
    const { container } = render(() => <EmptyState title="Nothing here" />);
    expect(container.querySelectorAll("p")).toHaveLength(1);
  });
});

describe("Chip", () => {
  it("always carries a word, so the hue is never the only carrier", () => {
    render(() => <Chip tone="success">live</Chip>);
    expect(screen.getByText("live")).toBeInTheDocument();
  });
});

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
  it("reports the share of the maximum", () => {
    expect(meterPct(25, 100)).toBe(25);
  });

  it("stops at full for a value past the maximum", () => {
    // Over budget is still a full bar — the tone is what says it went over.
    expect(meterPct(150, 100)).toBe(100);
  });

  it("stops at empty for a negative value", () => {
    expect(meterPct(-10, 100)).toBe(0);
  });

  it("reads a zero or missing maximum as empty, not as a division by zero", () => {
    // A checklist with no items, a budget nobody has set yet.
    expect(meterPct(5, 0)).toBe(0);
    expect(meterPct(5, Number.NaN)).toBe(0);
  });
});

describe("Meter", () => {
  it("reports where it is to assistive tech", () => {
    const { getByRole } = render(() => <Meter value={30} max={120} label="Budget spent" />);
    const bar = getByRole("progressbar");
    expect(bar).toHaveAttribute("aria-valuenow", "25");
    expect(bar).toHaveAttribute("aria-label", "Budget spent");
  });
});

describe("Table", () => {
  it("tells a screen reader which cells a header governs", () => {
    const { getAllByRole } = render(() => (
      <Table label="Guests">
        <thead>
          <tr>
            <Th>Guest</Th>
            <Th>Replies</Th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <Td>Ada</Td>
            <Td numeric>2</Td>
          </tr>
        </tbody>
      </Table>
    ));
    for (const th of getAllByRole("columnheader")) expect(th).toHaveAttribute("scope", "col");
  });

  it("lines the figures up down their column", () => {
    const { getByText } = render(() => (
      <Table label="Replies">
        <tbody>
          <tr>
            <Td numeric>2</Td>
          </tr>
        </tbody>
      </Table>
    ));
    expect(getByText("2").className).toContain("tabular-nums");
  });

  it("reaches its own overflow, so the page never scrolls sideways", () => {
    const { container } = render(() => (
      <Table label="Guests">
        <tbody>
          <tr>
            <Td>Ada</Td>
          </tr>
        </tbody>
      </Table>
    ));
    expect(container.firstElementChild?.className).toContain("overflow-x-auto");
  });

  it("centres a header when the column under it is centred", () => {
    // The tick column: a left-aligned heading over centred marks reads as a
    // mistake, and `Th`'s own `text-left` would win over a passed class.
    const { getByRole } = render(() => (
      <Table label="Attendance">
        <thead>
          <tr>
            <Th align="center">Ceremony</Th>
          </tr>
        </thead>
      </Table>
    ));
    expect(getByRole("columnheader").className).toContain("text-center");
  });

  it("lets a keyboard reach the columns that are off the edge, and says what it is", () => {
    // WebKit does not make an overflow container focusable on its own, so
    // without this the email column is simply unreachable without a mouse. The
    // name is what stops the new tab stop being an unexplained one.
    const { getByRole } = render(() => (
      <Table label="Guests">
        <tbody>
          <tr>
            <Td>Ada</Td>
          </tr>
        </tbody>
      </Table>
    ));
    expect(getByRole("region", { name: "Guests" })).toHaveAttribute("tabindex", "0");
  });
});

describe("Stat", () => {
  it("says the figure, then what it is", () => {
    const { getByText } = render(() => <Stat value="84" label="Guests" hint="of 120" />);
    expect(getByText("84")).toBeInTheDocument();
    expect(getByText("Guests")).toBeInTheDocument();
    expect(getByText("of 120")).toBeInTheDocument();
  });

  it("leaves the hint out when there is none", () => {
    const { queryByText } = render(() => <Stat value="12" label="Days" />);
    expect(queryByText("of 120")).toBeNull();
  });
});

describe("Field", () => {
  it("names the control without swallowing the hint", () => {
    // The bug this exists to stop: a hint inside the label becomes part of the
    // input's accessible *name*, so the box announces as "RSVP by, the day
    // replies are due" instead of being described by it.
    const { getByRole } = render(() => (
      <Field label="RSVP by" hint="The day replies are due">
        {(field) => <Input {...field} />}
      </Field>
    ));
    const input = getByRole("textbox");
    expect(input).toHaveAccessibleName("RSVP by");
    expect(input).toHaveAccessibleDescription("The day replies are due");
  });

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

  it("announces what is wrong, and marks the box wrong with it", () => {
    const { getByRole } = render(() => (
      <Field label="Guest count" errors={["Must be a whole number."]}>
        {(field) => <Input {...field} />}
      </Field>
    ));
    expect(getByRole("alert")).toHaveTextContent("Must be a whole number.");
    expect(getByRole("textbox")).toHaveAttribute("aria-invalid", "true");
  });

  it("puts the error before the hint, because the error is the thing to hear", () => {
    const { getByRole } = render(() => (
      <Field label="Guest count" hint="Adults and children" errors={["Too many."]}>
        {(field) => <Input {...field} />}
      </Field>
    ));
    expect(getByRole("textbox")).toHaveAccessibleDescription("Too many. Adults and children");
  });

  it("keeps a hidden label a label", () => {
    const { getByRole } = render(() => (
      <Field label="Amount" labelHidden>
        {(field) => <Input {...field} />}
      </Field>
    ));
    expect(getByRole("textbox")).toHaveAccessibleName("Amount");
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

  it("keeps the same control when a save comes back rejected", () => {
    // The one thing that must not happen: a rejected save replaces the box the
    // host is typing in, so the caret and the focus go with it just as they
    // start correcting. The wiring updates; the node does not move.
    const [errors, setErrors] = createSignal<readonly string[]>([]);
    const { getByRole } = render(() => (
      <Field label="Handle" errors={errors()}>
        {(field) => <Input {...field} />}
      </Field>
    ));
    const before = getByRole("textbox");
    expect(before).not.toHaveAttribute("aria-invalid");

    setErrors(["No account with that handle."]);

    expect(getByRole("textbox")).toBe(before);
    expect(before).toHaveAttribute("aria-invalid", "true");
    expect(before).toHaveAccessibleDescription("No account with that handle.");
  });
});

describe("controls", () => {
  it("defaults an Input to text, and lets the caller say otherwise", () => {
    const { getByRole, getByLabelText } = render(() => (
      <>
        <Input aria-label="Name" />
        <Input aria-label="Quote" type="number" />
      </>
    ));
    expect(getByRole("textbox")).toHaveProperty("type", "text");
    expect(getByLabelText("Quote")).toHaveProperty("type", "number");
  });

  it("sizes a table cell's control differently from a form's", () => {
    const { getByLabelText } = render(() => (
      <>
        <Input aria-label="Row" size="sm" />
        <Input aria-label="Form" size="md" />
      </>
    ));
    expect(getByLabelText("Row").className).not.toBe(getByLabelText("Form").className);
  });

  it("lets a long note grow downwards but not sideways", () => {
    // Sideways resize breaks the column the textarea sits in; no resize at all
    // takes away the one control a host has over a long note.
    const { getByRole } = render(() => <Textarea aria-label="Notes" />);
    expect(getByRole("textbox").className).toContain("resize-y");
  });

  it("turns off resize for a textarea sitting inside an auto-sized frame", () => {
    // `createAutoSize()`'s reflow guard watches width only, so a
    // `resize-y` textarea inside an auto-sized frame reads a height-only
    // drag as a content change and relayouts continuously. Any textarea
    // inside an auto-sized frame must stay `resize="none"` — and that has
    // to win over the default class, not just add to it.
    const { getByRole } = render(() => <Textarea aria-label="Description" resize="none" />);
    const className = getByRole("textbox").className;
    expect(className).toContain("resize-none");
    expect(className).not.toContain("resize-y");
  });

  it("passes a Select its options and its value", () => {
    const { getByRole } = render(() => (
      <Select aria-label="Status" value="booked">
        <option value="quoted">Quoted</option>
        <option value="booked">Booked</option>
      </Select>
    ));
    expect(getByRole("combobox")).toHaveValue("booked");
  });
});

describe("Fieldset", () => {
  it("groups the controls that answer one question, and names the group", () => {
    const { getByRole } = render(() => (
      <Fieldset legend="Guest code style">
        <label>
          <input type="radio" name="style" value="words" /> Words
        </label>
      </Fieldset>
    ));
    expect(getByRole("group", { name: "Guest code style" })).toBeInTheDocument();
  });

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
