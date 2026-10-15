import { render, cleanup, fireEvent } from "@solidjs/testing-library";
// @vitest-environment happy-dom
import { describe, it, expect, afterEach, vi } from "vitest";

import { FilterRail } from "../../src/explore/FilterRail";

describe("FilterRail", () => {
  afterEach(cleanup);

  it("highlights the active chip with foreground styling", () => {
    const { getByText } = render(() => <FilterRail active="music" onSelect={() => {}} />);
    const musicBtn = getByText("Music").closest("button")!;
    expect(musicBtn.className).toContain("bg-foreground");
    expect(musicBtn.className).toContain("text-background");
  });

  it("non-active chips use card background styling", () => {
    const { getByText } = render(() => <FilterRail active="music" onSelect={() => {}} />);
    const freeBtn = getByText("Free").closest("button")!;
    expect(freeBtn.className).toContain("bg-card");
    expect(freeBtn.className).not.toContain("bg-foreground");
  });

  it("calls onSelect with the chip id when clicked", () => {
    const onSelect = vi.fn();
    const { getByText } = render(() => <FilterRail active="all" onSelect={onSelect} />);
    fireEvent.click(getByText("Music").closest("button")!);
    expect(onSelect).toHaveBeenCalledWith("music");
  });

  it("calls onSelect with 'all' when 'For you' clicked", () => {
    const onSelect = vi.fn();
    const { getByText } = render(() => <FilterRail active="music" onSelect={onSelect} />);
    fireEvent.click(getByText("For you").closest("button")!);
    expect(onSelect).toHaveBeenCalledWith("all");
  });
});
