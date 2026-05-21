// @vitest-environment happy-dom
import { cleanup, fireEvent, render } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Step6Finish } from "../../../src/pages/onboarding/Step6Finish";

describe("Step6Finish", () => {
  afterEach(() => cleanup());

  it("personalises the headline when displayName is present", () => {
    const { getByText } = render(() => (
      <Step6Finish
        displayName="Sarah"
        totalSteps={6}
        busy={false}
        onPrimary={vi.fn()}
        onBack={vi.fn()}
      />
    ));
    expect(getByText(/Sarah/)).toBeTruthy();
  });

  it("falls back to the generic headline when displayName is null", () => {
    const { container } = render(() => (
      <Step6Finish
        displayName={null}
        totalSteps={6}
        busy={false}
        onPrimary={vi.fn()}
        onBack={vi.fn()}
      />
    ));
    // No personalised name + the headline still renders. We assert the
    // headline element exists by class rather than fragmented text.
    const headline = container.querySelector(".onb-headline");
    expect(headline).toBeTruthy();
    expect(headline?.textContent).not.toMatch(/, \./); // no "You're in, ."
  });

  it("primary button reads 'Start exploring' when not busy", () => {
    const { getByText } = render(() => (
      <Step6Finish
        displayName={null}
        totalSteps={6}
        busy={false}
        onPrimary={vi.fn()}
        onBack={vi.fn()}
      />
    ));
    expect(getByText("Start exploring")).toBeTruthy();
  });

  it("primary button reads 'Saving…' and is disabled when busy", () => {
    const { getByText } = render(() => (
      <Step6Finish
        displayName={null}
        totalSteps={6}
        busy={true}
        onPrimary={vi.fn()}
        onBack={vi.fn()}
      />
    ));
    const btn = getByText(/Saving/) as HTMLButtonElement;
    expect(btn).toBeTruthy();
    expect(btn.disabled).toBe(true);
  });

  it("primary fires onPrimary when not busy", () => {
    const onPrimary = vi.fn();
    const { getByText } = render(() => (
      <Step6Finish
        displayName={null}
        totalSteps={6}
        busy={false}
        onPrimary={onPrimary}
        onBack={vi.fn()}
      />
    ));
    fireEvent.click(getByText("Start exploring"));
    expect(onPrimary).toHaveBeenCalled();
  });

  it("Back fires onBack", () => {
    const onBack = vi.fn();
    const { getByText } = render(() => (
      <Step6Finish
        displayName={null}
        totalSteps={6}
        busy={false}
        onPrimary={vi.fn()}
        onBack={onBack}
      />
    ));
    fireEvent.click(getByText("← Back"));
    expect(onBack).toHaveBeenCalled();
  });

  it("renders a date stamp containing today's day-of-month", () => {
    const today = new Date();
    const { container } = render(() => (
      <Step6Finish
        displayName={null}
        totalSteps={6}
        busy={false}
        onPrimary={vi.fn()}
        onBack={vi.fn()}
      />
    ));
    const svg = container.querySelector("svg");
    expect(svg?.textContent).toContain(String(today.getDate()));
  });
});
