// @vitest-environment happy-dom
import { cleanup, render } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Step1Welcome } from "../../../src/components/onboarding/Step1Welcome";

describe("Step1Welcome", () => {
  afterEach(() => cleanup());

  it("personalises the body when displayName is present", () => {
    const { getByText } = render(() => (
      <Step1Welcome displayName="Sarah" totalSteps={6} onPrimary={vi.fn()} onSkip={vi.fn()} />
    ));
    expect(getByText(/Glad you're here, Sarah/)).toBeTruthy();
  });

  it("falls back to a generic body when displayName is null (no literal 'Hi there')", () => {
    const { queryByText, getByText } = render(() => (
      <Step1Welcome displayName={null} totalSteps={6} onPrimary={vi.fn()} onSkip={vi.fn()} />
    ));
    expect(queryByText(/Glad you're here/)).toBeNull();
    expect(queryByText(/Hi there/)).toBeNull();
    expect(getByText(/Let's set up what you want to see/)).toBeTruthy();
  });
});
