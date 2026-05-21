// @vitest-environment happy-dom
import { cleanup, fireEvent, render } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { InterestCategory } from "../../../src/lib/onboarding";
import { Step3Interests } from "../../../src/pages/onboarding/Step3Interests";

function setup(initial: ReadonlySet<InterestCategory> = new Set()) {
  const selected = new Set<InterestCategory>(initial);
  const onToggle = vi.fn((c: InterestCategory) => {
    if (selected.has(c)) selected.delete(c);
    else selected.add(c);
    rerender();
  });
  const onPrimary = vi.fn();
  const onBack = vi.fn();
  const onSkip = vi.fn();

  const view = render(() => (
    <Step3Interests
      totalSteps={6}
      selected={selected}
      onToggle={onToggle}
      onPrimary={onPrimary}
      onBack={onBack}
      onSkip={onSkip}
    />
  ));

  function rerender() {
    view.unmount();
    const fresh = render(() => (
      <Step3Interests
        totalSteps={6}
        selected={selected}
        onToggle={onToggle}
        onPrimary={onPrimary}
        onBack={onBack}
        onSkip={onSkip}
      />
    ));
    Object.assign(view, fresh);
  }

  return { view, onToggle, onPrimary, onBack, onSkip, selected: () => selected };
}

describe("Step3Interests", () => {
  afterEach(() => cleanup());

  it("renders all 11 category chips", () => {
    const { view } = setup();
    const chips = view.container.querySelectorAll(".onb-chip");
    expect(chips.length).toBe(11);
  });

  it("renders chip labels for the canonical categories", () => {
    const { view } = setup();
    expect(view.getByText("Music")).toBeTruthy();
    expect(view.getByText("Food")).toBeTruthy();
    expect(view.getByText("Nightlife")).toBeTruthy();
    expect(view.getByText("Outdoor")).toBeTruthy();
    expect(view.getByText("Family")).toBeTruthy();
  });

  it("clicking a chip calls onToggle with that category", () => {
    const { view, onToggle } = setup();
    fireEvent.click(view.getByText("Music"));
    expect(onToggle).toHaveBeenCalledWith("music");
  });

  it("a selected chip reports aria-pressed=true", () => {
    const { view } = setup(new Set<InterestCategory>(["music"]));
    const musicChip = view.getByText("Music").closest("button");
    expect(musicChip?.getAttribute("aria-pressed")).toBe("true");
  });

  it("an unselected chip reports aria-pressed=false", () => {
    const { view } = setup(new Set<InterestCategory>(["music"]));
    const foodChip = view.getByText("Food").closest("button");
    expect(foodChip?.getAttribute("aria-pressed")).toBe("false");
  });

  it("when 8 are selected, unselected chips are disabled (max-8 cap)", () => {
    const { view } = setup(
      new Set<InterestCategory>([
        "music",
        "food",
        "sports",
        "arts",
        "tech",
        "community",
        "education",
        "social",
      ]),
    );
    const family = view.getByText("Family").closest("button") as HTMLButtonElement;
    expect(family.disabled).toBe(true);
  });

  it("when 8 are selected, the selected chips remain interactive (can deselect)", () => {
    const { view } = setup(
      new Set<InterestCategory>([
        "music",
        "food",
        "sports",
        "arts",
        "tech",
        "community",
        "education",
        "social",
      ]),
    );
    const music = view.getByText("Music").closest("button") as HTMLButtonElement;
    expect(music.disabled).toBe(false);
  });

  it("Continue calls onPrimary", () => {
    const { view, onPrimary } = setup();
    fireEvent.click(view.getByText("Continue"));
    expect(onPrimary).toHaveBeenCalled();
  });

  it("Skip calls onSkip", () => {
    const { view, onSkip } = setup();
    fireEvent.click(view.getByText("Skip"));
    expect(onSkip).toHaveBeenCalled();
  });

  it("Back calls onBack", () => {
    const { view, onBack } = setup();
    fireEvent.click(view.getByText("← Back"));
    expect(onBack).toHaveBeenCalled();
  });
});
