// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PerHeadPanel, PerHeadSummary } from "../../src/components/BudgetPerHead";
import type { BudgetItemRow } from "../../src/lib/budget-store";
import { __resetMoneyFormatters } from "../../src/lib/money";

const EVENTS = [
  { id: "evt_ceremony", name: "Ceremony" },
  { id: "evt_reception", name: "Reception" },
];

const line = (over: Partial<BudgetItemRow> = {}): BudgetItemRow => ({
  id: "bit_1",
  weddingId: "wed_1",
  category: "catering",
  name: "Dinner",
  estimateMinor: null,
  quotedMinor: null,
  actualMinor: null,
  notes: null,
  sortOrder: 0,
  createdAt: 1,
  updatedAt: 1,
  unitPriceMinor: 5_000,
  eventIds: null,
  headcount: { expected: 120, confirmed: 80 },
  ...over,
});

afterEach(() => cleanup());
beforeEach(() => __resetMoneyFormatters());

describe("PerHeadSummary", () => {
  it("shows the expected and the confirmed figure while RSVPs are open", () => {
    render(() => (
      <PerHeadSummary item={line()} events={EVENTS} currency="AUD" rsvpsClosed={false} />
    ));
    const summary = screen.getByTestId("per-head-summary");
    expect(summary).toHaveTextContent(/50\.00 per head at every event/);
    expect(summary).toHaveTextContent(/120 expected = \S*6,000\.00/);
    expect(summary).toHaveTextContent(/80 confirmed = \S*4,000\.00/);
  });

  it("shows only the confirmed figure once RSVPs close", () => {
    render(() => (
      <PerHeadSummary
        item={line({ eventIds: ["evt_reception"] })}
        events={EVENTS}
        currency="AUD"
        rsvpsClosed={true}
      />
    ));
    const summary = screen.getByTestId("per-head-summary");
    expect(summary).toHaveTextContent(/per head at Reception/);
    expect(summary).toHaveTextContent(/RSVPs closed: 80 confirmed = \S*4,000\.00/);
    expect(summary).not.toHaveTextContent(/expected/);
  });

  it("says so when every event it counted has been deleted", () => {
    render(() => (
      <PerHeadSummary
        item={line({ eventIds: [], headcount: { expected: 0, confirmed: 0 } })}
        events={EVENTS}
        currency="AUD"
        rsvpsClosed={false}
      />
    ));
    expect(screen.getByTestId("per-head-summary")).toHaveTextContent(
      /events it counted were deleted, so it counts nobody/,
    );
  });

  it("uses the currency's own minor unit", () => {
    render(() => (
      <PerHeadSummary
        item={line({ unitPriceMinor: 5_000 })}
        events={EVENTS}
        currency="JPY"
        rsvpsClosed={true}
      />
    ));
    // JPY has no minor unit: 5000 minor units are ¥5,000, not ¥50.
    expect(screen.getByTestId("per-head-summary")).toHaveTextContent(/5,000 per head/);
  });
});

describe("PerHeadPanel", () => {
  const panel = (item: BudgetItemRow) => {
    const onSave = vi.fn();
    const onUseFixed = vi.fn();
    render(() => (
      <PerHeadPanel
        item={item}
        events={EVENTS}
        currency="AUD"
        onSave={onSave}
        onUseFixed={onUseFixed}
        onCancel={() => {}}
      />
    ));
    return { onSave, onUseFixed };
  };

  it("sends only the price when the events were not touched", () => {
    const { onSave } = panel(line({ eventIds: ["evt_reception"] }));
    const price = screen.getByLabelText(/Price per head/);
    expect(price).toHaveValue(50);
    fireEvent.input(price, { target: { value: "62.5" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave).toHaveBeenCalledWith({ unitPriceMinor: 6_250 });
  });

  it("sends the ticked events in the wedding's order", () => {
    const { onSave } = panel(line());
    fireEvent.click(screen.getByLabelText("Only these events"));
    fireEvent.click(screen.getByLabelText("Reception"));
    fireEvent.click(screen.getByLabelText("Ceremony"));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave).toHaveBeenCalledWith({
      unitPriceMinor: 5_000,
      eventIds: ["evt_ceremony", "evt_reception"],
    });
  });

  it("sends null to count every event again", () => {
    const { onSave } = panel(line({ eventIds: ["evt_ceremony"] }));
    fireEvent.click(screen.getByLabelText("Every event"));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave).toHaveBeenCalledWith({ unitPriceMinor: 5_000, eventIds: null });
  });

  it("refuses 'only these events' with none ticked, and a missing price", () => {
    const { onSave } = panel(line({ unitPriceMinor: null, headcount: null }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Enter a price per head");

    fireEvent.input(screen.getByLabelText(/Price per head/), { target: { value: "10" } });
    fireEvent.click(screen.getByLabelText("Only these events"));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Tick at least one event");
    expect(onSave).not.toHaveBeenCalled();
  });

  it("refuses a price that rounds to zero cents, and keeps a price of 0", () => {
    const { onSave } = panel(line());
    const price = screen.getByLabelText(/Price per head/);
    fireEvent.input(price, { target: { value: "0.004" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByRole("alert")).toHaveTextContent(
      /Amounts between 0 and \S*0\.01 are not allowed\./,
    );
    expect(onSave).not.toHaveBeenCalled();

    fireEvent.input(price, { target: { value: "0" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave).toHaveBeenCalledWith({ unitPriceMinor: 0 });
  });

  it("offers a fixed amount only on a line that is already per head", () => {
    const { onUseFixed } = panel(line());
    fireEvent.click(screen.getByRole("button", { name: "Use a fixed amount" }));
    expect(onUseFixed).toHaveBeenCalled();
    cleanup();
    panel(line({ unitPriceMinor: null, headcount: null }));
    expect(screen.queryByRole("button", { name: "Use a fixed amount" })).not.toBeInTheDocument();
  });

  it("opens on the line's own events and keeps them when another is ticked", () => {
    const { onSave } = panel(line({ eventIds: ["evt_reception"] }));
    expect(screen.getByLabelText("Only these events")).toBeChecked();
    expect(screen.getByLabelText("Reception")).toBeChecked();
    expect(screen.getByLabelText("Ceremony")).not.toBeChecked();
    fireEvent.click(screen.getByLabelText("Ceremony"));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave).toHaveBeenCalledWith({
      unitPriceMinor: 5_000,
      eventIds: ["evt_ceremony", "evt_reception"],
    });
  });

  it("cannot limit a line to events the wedding does not have", () => {
    render(() => (
      <PerHeadPanel
        item={line()}
        events={[]}
        currency="AUD"
        onSave={() => {}}
        onUseFixed={() => {}}
        onCancel={() => {}}
      />
    ));
    expect(screen.getByLabelText("Only these events")).toBeDisabled();
  });

  it("reads and writes the price in the currency's own minor unit", () => {
    const onSave = vi.fn();
    render(() => (
      <PerHeadPanel
        item={line({ unitPriceMinor: 5_000 })}
        events={EVENTS}
        currency="JPY"
        onSave={onSave}
        onUseFixed={() => {}}
        onCancel={() => {}}
      />
    ));
    // JPY has no minor unit: 5000 minor units are ¥5,000, and ¥6,000 is 6000.
    const price = screen.getByLabelText(/Price per head/);
    expect(price).toHaveValue(5_000);
    fireEvent.input(price, { target: { value: "6000" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave).toHaveBeenCalledWith({ unitPriceMinor: 6_000 });
  });
});
