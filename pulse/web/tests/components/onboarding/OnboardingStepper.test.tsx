// @vitest-environment happy-dom
import { cleanup, fireEvent, render as _baseRender, waitFor } from "@solidjs/testing-library";
import type { JSX } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { wrapRouter } from "../../helpers/router";

vi.mock("@shared/toast", async () => {
  const { toastMock } = await import("../../helpers/toast");
  return toastMock();
});
import { mockToastError } from "../../helpers/toast";

// Mock the navigate so the step-6 finish handler and the skip-all handler
// can be observed without a real router push. Falls through to MemoryRouter
// for everything else.
const mockNavigate = vi.fn();
vi.mock("@solidjs/router", async () => {
  const actual = await vi.importActual<typeof import("@solidjs/router")>("@solidjs/router");
  return { ...actual, useNavigate: () => mockNavigate };
});

// Stub the lib so the stepper can drive it without making real network /
// permission calls. Each test re-arms the implementations it needs.
const mockComplete = vi.fn();
const mockMarkSkipped = vi.fn();
const mockReqLocation = vi.fn();
const mockReqNotifications = vi.fn();
vi.mock("../../../src/lib/onboarding", async () => {
  const actual = await vi.importActual<typeof import("../../../src/lib/onboarding")>(
    "../../../src/lib/onboarding",
  );
  return {
    ...actual,
    completeOnboarding: (...a: unknown[]) => mockComplete(...a),
    markOnboardingResolvedThisSession: (...a: unknown[]) => mockMarkSkipped(...a),
    requestLocationPermission: (...a: unknown[]) => mockReqLocation(...a),
    requestNotificationPermission: (...a: unknown[]) => mockReqNotifications(...a),
  };
});

import { OnboardingStepper } from "../../../src/components/onboarding/OnboardingStepper";

const render: typeof _baseRender = ((factory: () => JSX.Element) =>
  _baseRender(wrapRouter(factory))) as unknown as typeof _baseRender;

describe("OnboardingStepper", () => {
  beforeEach(() => {
    mockNavigate.mockReset();
    mockComplete.mockReset();
    mockMarkSkipped.mockReset();
    mockReqLocation.mockReset();
    mockReqNotifications.mockReset();
    mockToastError.mockReset();
    mockComplete.mockResolvedValue({
      completedAt: new Date().toISOString(),
      interests: [],
      notificationsOptIn: false,
      eventRemindersOptIn: false,
      notificationsPerm: "prompt",
      locationPerm: "prompt",
    });
    mockReqLocation.mockResolvedValue("granted");
    mockReqNotifications.mockResolvedValue("granted");
  });

  afterEach(() => cleanup());

  function mount(displayName: string | null = "Sarah") {
    const onCompleted = vi.fn();
    const view = render(() => (
      <OnboardingStepper displayName={displayName} onCompleted={onCompleted} />
    ));
    return { view, onCompleted };
  }

  // -------------------------------------------------------------------------
  // Step 1 → 6 navigation
  // -------------------------------------------------------------------------

  it("Back from step 2 returns to step 1", () => {
    const { view } = mount();
    fireEvent.click(view.getByText("Get started"));
    fireEvent.click(view.getByText("← Back"));
    expect(view.getByText("Get started")).toBeTruthy();
  });

  // -------------------------------------------------------------------------
  // Skip-all
  // -------------------------------------------------------------------------

  it("Skip for now (step 1) navigates home and marks the session", () => {
    const { view } = mount();
    fireEvent.click(view.getByText("Skip for now"));
    expect(mockMarkSkipped).toHaveBeenCalled();
    expect(mockNavigate).toHaveBeenCalledWith("/", { replace: true });
  });

  it("Skip for now (step 2) also navigates home and marks the session", () => {
    const { view } = mount();
    fireEvent.click(view.getByText("Get started"));
    fireEvent.click(view.getByText("Skip for now"));
    expect(mockMarkSkipped).toHaveBeenCalled();
    expect(mockNavigate).toHaveBeenCalledWith("/", { replace: true });
  });

  // -------------------------------------------------------------------------
  // Permission requests
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // Finish — captured state is sent to completeOnboarding
  // -------------------------------------------------------------------------

  it("finish with denied permissions writes the resolved outcomes (not granted/optIn)", async () => {
    mockReqLocation.mockResolvedValueOnce("denied");
    mockReqNotifications.mockResolvedValueOnce("denied");
    const { view, onCompleted } = mount();

    fireEvent.click(view.getByText("Get started"));
    fireEvent.click(view.getByText("Continue"));
    fireEvent.click(view.getByText("Continue")); // skip interests
    fireEvent.click(view.getByText("Allow location"));
    await waitFor(() => view.getByText(/Location declined/));
    fireEvent.click(view.getByText("Continue"));
    fireEvent.click(view.getByText("Allow notifications"));
    await waitFor(() => view.getByText(/Notifications declined/));
    fireEvent.click(view.getByText("Continue"));
    fireEvent.click(view.getByText("Start exploring"));

    await waitFor(() => expect(mockComplete).toHaveBeenCalled());
    const [payload] = mockComplete.mock.calls[0]!;
    expect(payload).toMatchObject({
      interests: [],
      notificationsOptIn: false,
      eventRemindersOptIn: false,
      notificationsPerm: "denied",
      locationPerm: "denied",
    });
    await waitFor(() => expect(onCompleted).toHaveBeenCalled());
  });

  it("finish surfaces a toast error and does NOT navigate when completeOnboarding rejects", async () => {
    mockComplete.mockRejectedValueOnce(new Error("boom"));
    const { view, onCompleted } = mount();
    // Walk straight through using Skips where available.
    fireEvent.click(view.getByText("Get started"));
    fireEvent.click(view.getByText("Continue"));
    fireEvent.click(view.getByText("Skip"));
    fireEvent.click(view.getByText("Skip"));
    fireEvent.click(view.getByText("Skip"));
    fireEvent.click(view.getByText("Start exploring"));
    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith("boom");
    });
    expect(onCompleted).not.toHaveBeenCalled();
  });
});
