// @vitest-environment happy-dom
import { cleanup, fireEvent, render } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SectionTabs } from "../../src/components/SectionTabs";

const TABS = [
  { value: "all", label: "All" },
  { value: "pending", label: "Pending" },
] as const;

describe("SectionTabs", () => {
  afterEach(cleanup);

  it("names the bar, so a new landmark is not an unexplained one", () => {
    const { getByRole } = render(() => (
      <SectionTabs label="Connection filters" tabs={TABS} current="all" onSelect={() => {}} />
    ));
    expect(getByRole("navigation", { name: "Connection filters" })).toBeTruthy();
  });

  it("marks exactly the current tab, and marks it with `aria-current`", () => {
    // Not `aria-selected`: that belongs to `role="tab"`, which belongs to a
    // `tablist` with a panel per tab and arrow keys moving between them. This
    // bar keeps none of that contract, and claiming the role without it
    // promises a screen-reader user navigation that is not there.
    const { getByText } = render(() => (
      <SectionTabs label="Settings sections" tabs={TABS} current="pending" onSelect={() => {}} />
    ));
    expect(getByText("Pending").getAttribute("aria-current")).toBe("page");
    expect(getByText("All").getAttribute("aria-current")).toBeNull();
  });

  it("reports the selected value rather than an index", () => {
    const onSelect = vi.fn();
    const { getByText } = render(() => (
      <SectionTabs label="Settings sections" tabs={TABS} current="all" onSelect={onSelect} />
    ));
    fireEvent.click(getByText("Pending"));
    expect(onSelect).toHaveBeenCalledWith("pending");
  });

  it("keeps a 44px touch target below the breakpoint the bar is tapped at", () => {
    // The class contract, not the rendered height — this tier computes no CSS.
    // It is worth pinning anyway: the tab labels are short, so the box collapses
    // to the line height and the target shrinks with no visible change.
    const { getByText } = render(() => (
      <SectionTabs label="Settings sections" tabs={TABS} current="all" onSelect={() => {}} />
    ));
    expect(getByText("All").className).toContain("max-md:min-h-11");
  });
});
