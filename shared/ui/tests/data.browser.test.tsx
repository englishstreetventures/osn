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
import { For } from "solid-js";
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

/**
 * Pinned cells: a head row held at the top of the table's box, and a first
 * column held at its start edge, for a table whose box scrolls both ways.
 */
describe("Table — pinned cells", () => {
  function renderPinned() {
    const columns = ["Guest", "Household", "Status", "Dietary", "Notes"];
    return render(() => (
      // The box scrolls down as well as sideways, as a call site makes it.
      <div style={{ width: "320px" }}>
        <Table label="Pinned" class="relative isolate max-h-50 overflow-y-auto [&>table]:w-[900px]">
          <thead>
            <tr>
              <For each={columns}>
                {(name, i) => <Th pin={i() === 0 ? "top-start" : "top"}>{name}</Th>}
              </For>
            </tr>
          </thead>
          <tbody>
            <For each={Array.from({ length: 40 }, (_, row) => row)}>
              {(row) => (
                <tr>
                  <Td pin="start">Guest {row}</Td>
                  <Td>Household {row}</Td>
                  <Td>Status {row}</Td>
                  <Td>Dietary {row}</Td>
                  <Td>Notes {row}</Td>
                </tr>
              )}
            </For>
          </tbody>
        </Table>
      </div>
    ));
  }

  /** Paint `layers` bottom-up on a 1px canvas and read back plain `rgb`. */
  const composite = (layers: readonly string[]) => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const ctx = canvas.getContext("2d")!;
    for (const layer of layers) {
      ctx.fillStyle = layer;
      ctx.fillRect(0, 0, 1, 1);
    }
    const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
    return `rgb(${r}, ${g}, ${b})`;
  };

  /** The element painted at a box's centre is that box or inside it. */
  const paintsOver = (el: Element) => {
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return hit !== null && el.contains(hit);
  };

  it("holds the head row at the top and the first column at the start", () => {
    const { getByRole, getAllByRole } = renderPinned();
    const box = getByRole("region", { name: "Pinned" }) as HTMLElement;
    box.scrollTop = 300;
    box.scrollLeft = 200;
    const top = box.getBoundingClientRect().top + box.clientTop;
    const start = box.getBoundingClientRect().left + box.clientLeft;
    const heads = getAllByRole("columnheader");
    for (const th of heads) expect(th.getBoundingClientRect().top).toBeCloseTo(top, 0);
    const firstCells = [...box.querySelectorAll("tbody td:first-child")];
    const shown = firstCells.find((td) => {
      const r = td.getBoundingClientRect();
      return (
        r.top > heads[0]!.getBoundingClientRect().bottom + 1 &&
        r.bottom < box.getBoundingClientRect().bottom
      );
    })!;
    expect(shown.getBoundingClientRect().left).toBeCloseTo(start, 0);
    expect(heads[0]!.getBoundingClientRect().left).toBeCloseTo(start, 0);
  });

  it("paints the pinned cells over the ones passing beneath them", () => {
    const { getByRole, getAllByRole } = renderPinned();
    const box = getByRole("region", { name: "Pinned" }) as HTMLElement;
    box.scrollTop = 300;
    box.scrollLeft = 200;
    // Status is the head now in view beside the corner; Household has slid
    // beneath the corner.
    const [corner, , status] = getAllByRole("columnheader");
    expect(paintsOver(corner!)).toBe(true);
    expect(paintsOver(status!)).toBe(true);
    const row = [...box.querySelectorAll("tbody tr")].find((tr) => {
      const r = tr.getBoundingClientRect();
      return (
        r.top > corner!.getBoundingClientRect().bottom + 1 &&
        r.bottom < box.getBoundingClientRect().bottom
      );
    })!;
    const [guest, household] = row.querySelectorAll("td");
    // Household has slid under Guest, which is the one painted.
    expect(household!.getBoundingClientRect().left).toBeLessThan(
      guest!.getBoundingClientRect().right,
    );
    expect(paintsOver(guest!)).toBe(true);
  });

  it("is opaque, on the ground, with a full hairline at its end edge", () => {
    const { getAllByRole } = renderPinned();
    const [corner, household] = getAllByRole("columnheader");
    const pinned = getAllByRole("cell")[0]!;
    const plain = getAllByRole("cell")[1]!;
    // Opaque: the same paint over white and over black. A translucent ground
    // would let the rows passing beneath show through.
    for (const cell of [corner!, household!, pinned]) {
      const ground = getComputedStyle(cell).backgroundColor;
      expect(composite(["white", ground])).toBe(composite(["black", ground]));
    }
    // A plain cell keeps its own transparent ground, and stays in flow.
    expect(getComputedStyle(plain).backgroundColor).toBe("rgba(0, 0, 0, 0)");
    expect(getComputedStyle(plain).position).toBe("static");
    // The start column's edge is the full hairline, not the row rule's 40%.
    expect(getComputedStyle(pinned).borderRightWidth).toBe("1px");
    expect(getComputedStyle(pinned).borderRightColor).not.toBe(
      getComputedStyle(pinned).borderBottomColor,
    );
    expect(getComputedStyle(corner!).borderRightWidth).toBe("1px");
  });
});

/**
 * Page mode: a table that scrolls with the page rather than in a box of its
 * own, so its head row sticks to the page under whatever chrome the call site
 * names. `overflow-x: auto` would make the box a scroll container on both axes
 * and the head would stick to the box instead; page mode clips.
 */
describe("Table — page mode", () => {
  function renderPage() {
    return render(() => (
      <div>
        <Table scroll="page" aria-labelledby="page-mode-name">
          <caption id="page-mode-name">Replies</caption>
          <thead>
            <tr>
              <Th pin="top" class="top-10">
                Guest
              </Th>
            </tr>
          </thead>
          <tbody>
            <For each={Array.from({ length: 120 }, (_, i) => i)}>
              {(row) => (
                <tr>
                  <Td>Guest {row}</Td>
                </tr>
              )}
            </For>
          </tbody>
        </Table>
        <div style={{ height: "1200px" }} />
      </div>
    ));
  }

  it("holds its head row to the page at the call site's offset, not at 0", () => {
    const { getByRole } = renderPage();
    const head = getByRole("columnheader", { name: "Guest" });
    const box = head.closest("table")!.parentElement!;
    expect(getComputedStyle(box).overflowX).toBe("clip");
    window.scrollTo(0, 1500);
    expect(window.scrollY).toBe(1500);
    // The table's own top is far above the window by now; its head is not.
    expect(box.getBoundingClientRect().top).toBeLessThan(-1000);
    expect(head.getBoundingClientRect().top).toBeCloseTo(40, 0);
    window.scrollTo(0, 0);
  });

  it("is no tab stop and no region: the page is what scrolls", () => {
    const { container } = renderPage();
    const box = container.querySelector("table")!.parentElement!;
    expect(box.hasAttribute("tabindex")).toBe(false);
    expect(box.hasAttribute("aria-label")).toBe(false);
    expect(container.querySelector("[role=region], section")).toBeNull();
    // The table itself carries the name the call site gave it.
    expect(container.querySelector("table")!.getAttribute("aria-labelledby")).toBe(
      "page-mode-name",
    );
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
