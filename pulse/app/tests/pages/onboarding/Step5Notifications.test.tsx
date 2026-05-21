// @vitest-environment happy-dom
import { cleanup, fireEvent, render } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { PermOutcome } from "../../../src/lib/onboarding";
import { Step5Notifications } from "../../../src/pages/onboarding/Step5Notifications";

function setup(perm: PermOutcome, remindersOptIn = false) {
  const onPrimary = vi.fn();
  const onRequest = vi.fn();
  const onToggleReminders = vi.fn();
  const onBack = vi.fn();
  const onSkip = vi.fn();
  const view = render(() => (
    <Step5Notifications
      totalSteps={6}
      perm={perm}
      remindersOptIn={remindersOptIn}
      onToggleReminders={onToggleReminders}
      onPrimary={onPrimary}
      onRequest={onRequest}
      onBack={onBack}
      onSkip={onSkip}
    />
  ));
  return { view, onPrimary, onRequest, onToggleReminders, onBack, onSkip };
}

describe("Step5Notifications", () => {
  afterEach(() => cleanup());

  it("prompt: primary reads 'Allow notifications' and the reminders toggle is hidden", () => {
    const { view, onRequest } = setup("prompt");
    expect(view.getByText(/We'll only send you what matters/)).toBeTruthy();
    expect(view.queryByText(/Remind me before events/)).toBeNull();
    fireEvent.click(view.getByText("Allow notifications"));
    expect(onRequest).toHaveBeenCalled();
  });

  it("granted: reminders toggle appears and routes to onToggleReminders", () => {
    const { view, onToggleReminders } = setup("granted", true);
    expect(view.getByText(/Notifications enabled\./)).toBeTruthy();
    const checkbox = view.container.querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(checkbox).toBeTruthy();
    expect(checkbox.checked).toBe(true);
    fireEvent.click(checkbox);
    expect(onToggleReminders).toHaveBeenCalledWith(false);
  });

  it("denied: reminders toggle is hidden + banner shows declined copy", () => {
    const { view } = setup("denied");
    expect(view.getByText(/Notifications declined/)).toBeTruthy();
    expect(view.queryByText(/Remind me before events/)).toBeNull();
  });

  it("unsupported: reminders toggle is hidden + banner shows unsupported copy", () => {
    const { view } = setup("unsupported");
    expect(view.getByText(/Notifications aren't supported/)).toBeTruthy();
    expect(view.queryByText(/Remind me before events/)).toBeNull();
  });

  it("granted: primary is 'Continue' and routes to onPrimary (not onRequest)", () => {
    const { view, onPrimary, onRequest } = setup("granted");
    fireEvent.click(view.getByText("Continue"));
    expect(onPrimary).toHaveBeenCalled();
    expect(onRequest).not.toHaveBeenCalled();
  });
});
