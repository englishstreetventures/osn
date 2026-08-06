// @vitest-environment happy-dom
import { cleanup, render } from "@solidjs/testing-library";
import { afterEach, describe, expect, it } from "vitest";

import Button from "./Button";
import Card, { cardClass, CardEyebrow } from "./Card";
import EmptyState from "./EmptyState";
import Meter, { meterPct } from "./Meter";
import Notice from "./Notice";
import Stat from "./Stat";
import { Table, Td, Th } from "./Table";

/**
 * These are class-mapping components, and a test that asserts the classes is a
 * test that has to be edited every time the design moves — it pins the current
 * answer, not the contract. So what is checked here is what a call site can rely
 * on: that the variants differ from each other, that props reach the DOM, that
 * the accessibility wiring is there, and that the one piece of arithmetic in the
 * set is right.
 *
 * They live in one file because they are seven small parts of one thing. A
 * component that grows real behaviour should take its own file with it.
 */

afterEach(cleanup);

describe("Button", () => {
  it("does not submit the form it is standing in, unless told to", () => {
    // A toolbar control inside a settings form is the common case, and a button
    // with no type is a submit button.
    const { getByRole } = render(() => <Button>Export</Button>);
    expect(getByRole("button")).toHaveProperty("type", "button");
  });

  it("still takes a type when the caller means it", () => {
    const { getByRole } = render(() => <Button type="submit">Save</Button>);
    expect(getByRole("button")).toHaveProperty("type", "submit");
  });

  it("gives each variant a different look", () => {
    const { getByText } = render(() => (
      <>
        <Button variant="primary">Commit</Button>
        <Button variant="outline">Second</Button>
        <Button variant="quiet">Quiet</Button>
        <Button variant="danger">Delete</Button>
      </>
    ));
    const classes = ["Commit", "Second", "Quiet", "Delete"].map(
      (label) => getByText(label).className,
    );
    expect(new Set(classes).size).toBe(4);
  });

  it("gives each size a different look", () => {
    const { getByText } = render(() => (
      <>
        <Button size="sm">Small</Button>
        <Button size="md">Medium</Button>
        <Button size="icon">✕</Button>
      </>
    ));
    const classes = ["Small", "Medium", "✕"].map((label) => getByText(label).className);
    expect(new Set(classes).size).toBe(3);
  });

  it("keeps the caller's own classes", () => {
    const { getByRole } = render(() => <Button class="self-start">Add</Button>);
    expect(getByRole("button").className).toContain("self-start");
  });

  it("passes everything else through", () => {
    const { getByRole } = render(() => (
      <Button disabled aria-label="Remove guest">
        ✕
      </Button>
    ));
    expect(getByRole("button")).toBeDisabled();
    expect(getByRole("button")).toHaveAttribute("aria-label", "Remove guest");
  });
});

describe("Card", () => {
  it("renders its children in a plain box", () => {
    const { getByText } = render(() => (
      <Card>
        <CardEyebrow>Guests</CardEyebrow>
      </Card>
    ));
    expect(getByText("Guests")).toBeInTheDocument();
  });

  it("marks the accented card out from the ordinary one", () => {
    expect(cardClass({ tone: "accent" })).not.toBe(cardClass());
  });

  it("adds nothing for a card that is not a control", () => {
    // The hover treatment is a promise that the whole rectangle is clickable.
    expect(cardClass()).not.toContain("hover:");
    expect(cardClass({ interactive: true })).toContain("hover:");
  });
});

describe("Notice", () => {
  it("says nothing to assistive tech by default", () => {
    // A standing note that was on screen before the host arrived has nothing to
    // interrupt anyone about.
    const { queryByRole } = render(() => <Notice tone="info">Two hosts can edit.</Notice>);
    expect(queryByRole("alert")).toBeNull();
  });

  it("announces itself when it appeared in answer to something", () => {
    const { getByRole } = render(() => (
      <Notice tone="error" alert>
        Could not save.
      </Notice>
    ));
    expect(getByRole("alert")).toHaveTextContent("Could not save.");
  });

  it("gives each tone a different look", () => {
    const { getAllByTestId } = render(() => (
      <>
        <Notice tone="error" data-testid="n">
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
        <Notice tone="error" data-testid="n">
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
      <Notice tone="error" alert>
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
        action={<Button variant="primary">Add a guest</Button>}
      />
    ));
    expect(getByRole("button")).toHaveTextContent("Add a guest");
  });

  it("leaves the description out when there is none", () => {
    const { container } = render(() => <EmptyState title="Nothing here" />);
    expect(container.querySelectorAll("p")).toHaveLength(1);
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
