// @vitest-environment happy-dom
import { cleanup, fireEvent, render } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Step2Value } from "../../../src/pages/onboarding/Step2Value";

describe("Step2Value", () => {
  afterEach(() => cleanup());

  it("Continue / Back / Skip wire up to the right handlers", () => {
    const onPrimary = vi.fn();
    const onBack = vi.fn();
    const onSkip = vi.fn();
    const { getByText } = render(() => (
      <Step2Value totalSteps={6} onPrimary={onPrimary} onBack={onBack} onSkip={onSkip} />
    ));
    fireEvent.click(getByText("Continue"));
    expect(onPrimary).toHaveBeenCalled();
    fireEvent.click(getByText("← Back"));
    expect(onBack).toHaveBeenCalled();
    fireEvent.click(getByText("Skip for now"));
    expect(onSkip).toHaveBeenCalled();
  });
});
