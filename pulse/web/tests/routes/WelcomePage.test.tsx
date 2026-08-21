// @vitest-environment happy-dom
import { cleanup, fireEvent, render as _baseRender } from "@solidjs/testing-library";
import type { JSX } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { wrapRouter } from "../helpers/router";

vi.mock("@shared/toast", async () => {
  const { toastMock } = await import("../helpers/toast");
  return toastMock();
});

// Auth context — the page reads `session()` for the viewer, and `displayNameOf`
// picks the label out of it. No token decode: the session already carries the
// identity fields the Pulse API resolved at sign-in.
import { authState, fakeSession } from "../helpers/auth";

vi.mock("@shared/rp-auth/solid", async () => {
  const { rpAuthSolidMock } = await import("../helpers/auth");
  return rpAuthSolidMock();
});

// Spy on the navigation hook so we can assert that handleCompleted runs
// markOnboardingResolvedThisSession BEFORE navigate("/"). Routing is the
// observable side effect — without ordering, the gate would still see
// the cached pre-complete status and bounce the user back to /welcome.
const mockNavigate = vi.fn();
vi.mock("@solidjs/router", async () => {
  const actual = await vi.importActual<typeof import("@solidjs/router")>("@solidjs/router");
  return { ...actual, useNavigate: () => mockNavigate };
});

const mockMarkResolved = vi.fn();
vi.mock("../../src/lib/onboarding", () => ({
  markOnboardingResolvedThisSession: () => mockMarkResolved(),
}));

// Stub the stepper to a tiny harness that exposes the `onCompleted`
// callback as a clickable button — that's the only seam this suite
// needs to verify WelcomePage's completion handler.
vi.mock("../../src/components/onboarding/OnboardingStepper", () => ({
  OnboardingStepper: (props: { displayName: string | null; onCompleted: () => void }) => (
    <div data-testid="stepper">
      stepper:{props.displayName ?? "anon"}
      <button data-testid="complete" onClick={() => props.onCompleted()}>
        complete
      </button>
    </div>
  ),
}));

import { WelcomePage } from "../../src/routes/welcome";

const render: typeof _baseRender = ((factory: () => JSX.Element) =>
  _baseRender(wrapRouter(factory))) as unknown as typeof _baseRender;

describe("WelcomePage", () => {
  beforeEach(() => {
    authState.session = fakeSession({ displayName: "Sarah" });
    mockNavigate.mockReset();
    mockMarkResolved.mockReset();
  });

  afterEach(() => cleanup());

  it("mounts the stepper when a session is present", () => {
    const { getByTestId } = render(() => <WelcomePage />);
    expect(getByTestId("stepper")).toBeTruthy();
  });

  it("passes the session's displayName through to the stepper", () => {
    const { getByText } = render(() => <WelcomePage />);
    expect(getByText("stepper:Sarah")).toBeTruthy();
  });

  it("falls back to @handle when the session carries no displayName", () => {
    authState.session = fakeSession({ displayName: null, handle: "sarah" });
    const { getByText } = render(() => <WelcomePage />);
    expect(getByText("stepper:@sarah")).toBeTruthy();
  });

  it("shows the sign-in fallback when no session is present", () => {
    authState.session = null;
    const { getByText, queryByTestId } = render(() => <WelcomePage />);
    expect(getByText("Sign in to continue")).toBeTruthy();
    expect(queryByTestId("stepper")).toBeNull();
  });

  // Regression guard for the redirect-loop fix in commit c4c629c:
  // OnboardingGate's createResource is keyed on the access token and
  // caches the pre-complete status. Without marking the session resolved
  // BEFORE navigating, the gate immediately bounces the user back to
  // /welcome, looping the just-finished flow.
  it("marks the session resolved BEFORE navigating home on completion", () => {
    const { getByTestId } = render(() => <WelcomePage />);
    fireEvent.click(getByTestId("complete"));
    expect(mockMarkResolved).toHaveBeenCalledTimes(1);
    expect(mockNavigate).toHaveBeenCalledWith("/", { replace: true });
    const markOrder = mockMarkResolved.mock.invocationCallOrder[0];
    const navOrder = mockNavigate.mock.invocationCallOrder[0];
    expect(markOrder).toBeLessThan(navOrder);
  });
});
