// @vitest-environment happy-dom
import { cleanup, fireEvent, render } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Step1Welcome } from "../../../src/pages/onboarding/Step1Welcome";

describe("Step1Welcome", () => {
  afterEach(() => cleanup());

  it("renders the institutional welcome headline", () => {
    const { getByText } = render(() => (
      <Step1Welcome displayName="Sarah" totalSteps={6} onPrimary={vi.fn()} onSkip={vi.fn()} />
    ));
    expect(getByText("Pulse")).toBeTruthy();
  });

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

  it("Get started fires onPrimary", () => {
    const onPrimary = vi.fn();
    const { getByText } = render(() => (
      <Step1Welcome displayName={null} totalSteps={6} onPrimary={onPrimary} onSkip={vi.fn()} />
    ));
    fireEvent.click(getByText("Get started"));
    expect(onPrimary).toHaveBeenCalled();
  });

  it("Skip for now fires onSkip", () => {
    const onSkip = vi.fn();
    const { getByText } = render(() => (
      <Step1Welcome displayName={null} totalSteps={6} onPrimary={vi.fn()} onSkip={onSkip} />
    ));
    fireEvent.click(getByText("Skip for now"));
    expect(onSkip).toHaveBeenCalled();
  });

  it("does not render a Back button (first step)", () => {
    const { queryByText } = render(() => (
      <Step1Welcome displayName={null} totalSteps={6} onPrimary={vi.fn()} onSkip={vi.fn()} />
    ));
    expect(queryByText("← Back")).toBeNull();
  });
});
