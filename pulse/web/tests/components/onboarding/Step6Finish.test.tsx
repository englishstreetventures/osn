// @vitest-environment happy-dom
import { cleanup, render } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Step6Finish } from "../../../src/components/onboarding/Step6Finish";

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
