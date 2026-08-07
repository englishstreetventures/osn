// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";

import DatePicker from "./DatePicker";

/**
 * DatePicker is the custom-on-Kobalte-Popover month-grid calendar that replaced
 * the bare native `<input type="date">` in Settings. It must keep the
 * `YYYY-MM-DD | null` round-trip contract SettingsPanel + the settings API speak:
 * emit a `YYYY-MM-DD` string on a pick, `null` on clear, handle an unset value,
 * be keyboard-navigable, and render read-only (no popover) for co-hosts.
 */
describe("DatePicker", () => {
  afterEach(cleanup);

  it("shows a placeholder trigger when unset and opens the grid on click", async () => {
    render(() => <DatePicker label="Wedding date" value={null} onChange={() => {}} />);
    const trigger = screen.getByLabelText(/Wedding date, no date set/);
    expect(trigger.textContent).toContain("Pick a date");

    fireEvent.click(trigger);
    // The month grid appears once open.
    await waitFor(() => expect(screen.getByRole("grid")).toBeTruthy());
  });

  it("surfaces the current date on the trigger when set", () => {
    render(() => <DatePicker label="Wedding date" value="2027-03-20" onChange={() => {}} />);
    // Long form, in the organiser's local calendar (no UTC day-shift).
    expect(screen.getByText(/20 March 2027/)).toBeTruthy();
  });

  it("emits YYYY-MM-DD when a day cell is clicked", async () => {
    const onChange = vi.fn();
    render(() => <DatePicker label="Wedding date" value="2027-03-20" onChange={onChange} />);

    fireEvent.click(screen.getByText(/20 March 2027/));
    await waitFor(() => expect(screen.getByRole("grid")).toBeTruthy());

    // Pick the 25th of the shown month (March 2027 — seeded from the value).
    fireEvent.click(screen.getByRole("gridcell", { name: /25 March 2027/ }));
    expect(onChange).toHaveBeenCalledWith("2027-03-25");
  });

  it("navigates days with the arrow keys and selects with Enter", async () => {
    const onChange = vi.fn();
    render(() => <DatePicker label="Wedding date" value="2027-03-20" onChange={onChange} />);

    fireEvent.click(screen.getByText(/20 March 2027/));
    const grid = await waitFor(() => screen.getByRole("grid"));

    // From the 20th, ArrowRight → 21st, ArrowDown → +7 → 28th, then Enter selects.
    fireEvent.keyDown(grid, { key: "ArrowRight" });
    fireEvent.keyDown(grid, { key: "ArrowDown" });
    fireEvent.keyDown(grid, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith("2027-03-28");
  });

  it("moves across a month boundary with the arrow keys", async () => {
    const onChange = vi.fn();
    // 31 March 2027 → ArrowRight lands on 1 April 2027 (next month).
    render(() => <DatePicker label="Wedding date" value="2027-03-31" onChange={onChange} />);

    fireEvent.click(screen.getByText(/31 March 2027/));
    const grid = await waitFor(() => screen.getByRole("grid"));
    fireEvent.keyDown(grid, { key: "ArrowRight" });
    fireEvent.keyDown(grid, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith("2027-04-01");
  });

  it("pages to the next month with the header button", async () => {
    const onChange = vi.fn();
    render(() => <DatePicker label="Wedding date" value="2027-03-20" onChange={onChange} />);

    fireEvent.click(screen.getByText(/20 March 2027/));
    await waitFor(() => expect(screen.getByRole("grid")).toBeTruthy());
    fireEvent.click(screen.getByLabelText("Next month"));

    // April now shown — pick its 5th.
    await waitFor(() =>
      expect(screen.getByRole("gridcell", { name: /\b5 April 2027/ })).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole("gridcell", { name: /\b5 April 2027/ }));
    expect(onChange).toHaveBeenCalledWith("2027-04-05");
  });

  it("emits null when 'Clear date' is clicked", async () => {
    const onChange = vi.fn();
    render(() => <DatePicker label="Wedding date" value="2027-03-20" onChange={onChange} />);

    fireEvent.click(screen.getByText(/20 March 2027/));
    const clear = await waitFor(() => screen.getByText("Clear date"));
    fireEvent.click(clear);
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it("has no 'Clear date' control when unset", async () => {
    render(() => <DatePicker label="Wedding date" value={null} onChange={() => {}} />);
    fireEvent.click(screen.getByLabelText(/Wedding date, no date set/));
    await waitFor(() => expect(screen.getByRole("grid")).toBeTruthy());
    expect(screen.queryByText("Clear date")).toBeNull();
  });

  it("renders read-only (no popover) for a co-host", () => {
    render(() => (
      <DatePicker label="Wedding date" value="2027-03-20" onChange={() => {}} readOnly />
    ));
    expect(screen.getByText(/20 March 2027/)).toBeTruthy();
    // No interactive trigger — a co-host can't open a picker.
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("read-only shows a placeholder when the date is unset", () => {
    render(() => <DatePicker label="Wedding date" value={null} onChange={() => {}} readOnly />);
    expect(screen.getByText(/No date set/)).toBeTruthy();
  });

  it("reflects an external value change on the trigger", async () => {
    const [value, setValue] = createSignal<string | null>("2027-03-20");
    render(() => <DatePicker label="Wedding date" value={value()} onChange={() => {}} />);
    expect(screen.getByText(/20 March 2027/)).toBeTruthy();

    setValue("2027-06-14");
    await waitFor(() => expect(screen.getByText(/14 June 2027/)).toBeTruthy());
  });
});
