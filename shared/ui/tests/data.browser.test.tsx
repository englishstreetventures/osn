/**
 * `Table` and `Meter` — both of which are almost entirely claims about layout.
 *
 * `Table` exists because a table wider than a phone needs a scroll somebody can
 * reach from a keyboard, and "is it actually scrollable, and is the box actually
 * focusable" is not a question a DOM shim can answer. `Meter` exists because a
 * dozen bars animating `width` together relayout the page every frame, and
 * "the fill is transformed, not resized" is likewise only visible here.
 */

import { render } from "@solidjs/testing-library";
import { describe, expect, it } from "vitest";

import { Meter, meterPct } from "../src/ui/meter";
import { Table, Td, Th } from "../src/ui/table";

import "./test-support/tailwind.css";

describe("Table", () => {
  it("scrolls sideways itself rather than taking the page with it", () => {
    const { getByRole } = render(() => (
      <Table label="Guests">
        <tbody>
          <tr>
            <Td>row</Td>
          </tr>
        </tbody>
      </Table>
    ));
    expect(getComputedStyle(getByRole("region", { name: "Guests" })).overflowX).toBe("auto");
  });

  it("is reachable from the keyboard, and says what it is when you land on it", () => {
    // WebKit does not make an overflow container focusable on its own, so
    // without the tabindex the columns past the edge are unreachable without a
    // mouse. The name is what stops the new tab stop being an unexplained one.
    const { getByRole } = render(() => (
      <Table label="Replies">
        <tbody>
          <tr>
            <Td>row</Td>
          </tr>
        </tbody>
      </Table>
    ));
    const region = getByRole("region", { name: "Replies" }) as HTMLElement;
    region.focus();
    expect(document.activeElement).toBe(region);
  });

  it("separates its borders, so the wrapper's radius is not punched through", () => {
    // `border-collapse` hands the border to the cells, and a square cell corner
    // then pokes out past the rounded frame. Only a layout engine knows.
    const { container } = render(() => (
      <Table label="Changes">
        <tbody>
          <tr>
            <Td>row</Td>
          </tr>
        </tbody>
      </Table>
    ));
    const table = container.querySelector("table")!;
    expect(getComputedStyle(table).borderCollapse).toBe("separate");
    expect(getComputedStyle(table).borderSpacing).toBe("0px");
  });

  it("gives a column head a scope, so a wide table does not have to be guessed", () => {
    const { getByRole } = render(() => (
      <Table label="Guests">
        <thead>
          <tr>
            <Th>Name</Th>
          </tr>
        </thead>
      </Table>
    ));
    expect(getByRole("columnheader").getAttribute("scope")).toBe("col");
  });

  it("centres a head by prop, which a passed class could not reliably do", () => {
    // `text-center` from a call site would fight the component's own `text-left`
    // on the same property, and two Tailwind utilities on one property resolve
    // by stylesheet order rather than by the order they appear in `class`.
    const start = render(() => (
      <Table label="A">
        <thead>
          <tr>
            <Th>Name</Th>
          </tr>
        </thead>
      </Table>
    ));
    const centred = render(() => (
      <Table label="B">
        <thead>
          <tr>
            <Th align="center">Sent</Th>
          </tr>
        </thead>
      </Table>
    ));

    expect(getComputedStyle(start.getByRole("columnheader")).textAlign).toBe("left");
    expect(getComputedStyle(centred.getByRole("columnheader")).textAlign).toBe("center");
  });

  it("lines figures up down a numeric column", () => {
    const { getByRole } = render(() => (
      <Table label="Budget">
        <tbody>
          <tr>
            <Td numeric>1,240</Td>
          </tr>
        </tbody>
      </Table>
    ));
    const cell = getByRole("cell");
    expect(getComputedStyle(cell).textAlign).toBe("right");
    expect(getComputedStyle(cell).fontVariantNumeric).toContain("tabular-nums");
  });
});

describe("meterPct", () => {
  it("clamps, and survives a maximum of zero", () => {
    // A budget with no total set is the ordinary case on a new wedding, and
    // `value / 0` is `Infinity` — which reaches the transform as
    // `scaleX(Infinity)` and takes the layout with it.
    expect(meterPct(50, 100)).toBe(50);
    expect(meterPct(150, 100)).toBe(100);
    expect(meterPct(-5, 100)).toBe(0);
    expect(meterPct(10, 0)).toBe(0);
    expect(meterPct(Number.NaN, 100)).toBe(0);
  });
});

describe("Meter", () => {
  it("scales the fill instead of resizing it", () => {
    // Animating `width` puts layout, paint and composite on the main thread for
    // every frame, and a budget screen draws one of these per category. The
    // fill is therefore full width and squashed — which shows up as a matrix on
    // the computed transform and a width equal to the track's.
    const { getByRole } = render(() => <Meter value={25} max={100} label="Spent" />);
    const track = getByRole("progressbar");
    const fill = track.firstElementChild as HTMLElement;

    expect(getComputedStyle(fill).transform).toBe("matrix(0.25, 0, 0, 1, 0, 0)");

    // The two widths are the point. `offsetWidth` is the layout width, and it
    // is the track's — the fill was never resized, so nothing relaid out. The
    // painted rect is a quarter of that, because `getBoundingClientRect` is
    // after the transform. A component that animated `width` would have these
    // two agree, and would cost a layout pass per frame to do it.
    expect(fill.offsetWidth).toBe(track.clientWidth);
    expect(fill.getBoundingClientRect().width).toBeCloseTo(
      track.getBoundingClientRect().width / 4,
      0,
    );
  });

  it("rounds the track and clips the fill, so the bar keeps its shape as it moves", () => {
    // A radius on the fill would be squashed along with everything else and
    // draw an ellipse that changes shape with the value.
    const { getByRole } = render(() => <Meter value={40} max={100} label="Spent" />);
    const track = getByRole("progressbar");
    expect(getComputedStyle(track).overflowX).toBe("hidden");
    expect(Number.parseFloat(getComputedStyle(track).borderTopLeftRadius)).toBeGreaterThan(0);
    expect(Number.parseFloat(getComputedStyle(track.firstElementChild!).borderTopLeftRadius)).toBe(
      0,
    );
  });

  it("draws `over` full, and in a different colour from `accent`", () => {
    // "Spent everything" and "spent more than everything" must not be the same
    // picture — the bar is full in both, so the tone is the only thing left to
    // carry the difference.
    const accent = render(() => <Meter value={100} max={100} label="Spent" />);
    const over = render(() => <Meter value={140} max={100} label="Spent" tone="over" />);

    const fill = (r: { getByRole: (role: string) => HTMLElement }) =>
      r.getByRole("progressbar").firstElementChild!;

    expect(getComputedStyle(fill(accent)).transform).toBe("matrix(1, 0, 0, 1, 0, 0)");
    expect(getComputedStyle(fill(over)).transform).toBe("matrix(1, 0, 0, 1, 0, 0)");
    expect(getComputedStyle(fill(over)).backgroundColor).not.toBe(
      getComputedStyle(fill(accent)).backgroundColor,
    );
  });

  it("reports a number and a name, not a bar", () => {
    const { getByRole } = render(() => <Meter value={33} max={100} label="Budget spent" />);
    const bar = getByRole("progressbar", { name: "Budget spent" });
    expect(bar.getAttribute("aria-valuenow")).toBe("33");
    expect(bar.getAttribute("aria-valuemin")).toBe("0");
    expect(bar.getAttribute("aria-valuemax")).toBe("100");
  });
});
