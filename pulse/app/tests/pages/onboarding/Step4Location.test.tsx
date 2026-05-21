// @vitest-environment happy-dom
import { cleanup, fireEvent, render } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { PermOutcome } from "../../../src/lib/onboarding";
import { Step4Location } from "../../../src/pages/onboarding/Step4Location";

function setup(perm: PermOutcome) {
  const onPrimary = vi.fn();
  const onRequest = vi.fn();
  const onBack = vi.fn();
  const onSkip = vi.fn();
  const view = render(() => (
    <Step4Location
      totalSteps={6}
      perm={perm}
      onPrimary={onPrimary}
      onRequest={onRequest}
      onBack={onBack}
      onSkip={onSkip}
    />
  ));
  return { view, onPrimary, onRequest, onBack, onSkip };
}

describe("Step4Location", () => {
  afterEach(() => cleanup());

  it("prompt: primary button reads 'Allow location' and routes to onRequest", () => {
    const { view, onRequest, onPrimary } = setup("prompt");
    expect(view.getByText(/We'll show you what's happening near you/)).toBeTruthy();
    fireEvent.click(view.getByText("Allow location"));
    expect(onRequest).toHaveBeenCalled();
    expect(onPrimary).not.toHaveBeenCalled();
  });

  it("granted: banner shows enabled copy and primary becomes 'Continue' → onPrimary", () => {
    const { view, onPrimary, onRequest } = setup("granted");
    expect(view.getByText(/Location enabled/)).toBeTruthy();
    fireEvent.click(view.getByText("Continue"));
    expect(onPrimary).toHaveBeenCalled();
    expect(onRequest).not.toHaveBeenCalled();
  });

  it("denied: banner shows declined copy + 'Try again' affordance routes to onRequest", () => {
    const { view, onRequest } = setup("denied");
    expect(view.getByText(/Location declined/)).toBeTruthy();
    fireEvent.click(view.getByText("Try again"));
    expect(onRequest).toHaveBeenCalled();
  });

  it("unsupported: shows 'isn't available' copy and is_resolved (Continue, no retry)", () => {
    const { view, onPrimary } = setup("unsupported");
    expect(view.getByText(/Location isn't available/)).toBeTruthy();
    fireEvent.click(view.getByText("Continue"));
    expect(onPrimary).toHaveBeenCalled();
  });

  it("granted: 'Try again' affordance is hidden (no need to retry)", () => {
    const { view } = setup("granted");
    expect(view.queryByText("Try again")).toBeNull();
  });

  it("Back wires to onBack on every perm state", () => {
    for (const perm of ["prompt", "granted", "denied", "unsupported"] as const) {
      cleanup();
      const { view, onBack } = setup(perm);
      fireEvent.click(view.getByText("← Back"));
      expect(onBack).toHaveBeenCalled();
    }
  });

  it("Skip wires to onSkip", () => {
    const { view, onSkip } = setup("prompt");
    fireEvent.click(view.getByText("Skip"));
    expect(onSkip).toHaveBeenCalled();
  });

  it.each([
    ["prompt" as const, ""],
    ["granted" as const, "is-granted"],
    ["denied" as const, "is-denied"],
    ["unsupported" as const, "is-denied"],
  ])("banner className reflects the perm state (%s → %s)", (perm, cls) => {
    const { view } = setup(perm);
    const banner = view.container.querySelector(".onb-perm-banner")!;
    const expected = cls ? `onb-perm-banner ${cls}` : "onb-perm-banner";
    expect(banner.className.trim()).toBe(expected.trim());
  });
});
