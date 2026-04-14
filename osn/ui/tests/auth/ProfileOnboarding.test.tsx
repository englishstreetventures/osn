// @vitest-environment happy-dom
import { render, cleanup, screen, fireEvent, waitFor } from "@solidjs/testing-library";
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

const DISMISSED_KEY = "@osn/ui:profile_onboarding_dismissed";

const hoisted = vi.hoisted(() => {
  return {
    session: vi.fn((): { accessToken: string } | null => ({ accessToken: "tok" })),
    profiles: vi.fn(() => [
      { id: "p_1", handle: "alice", email: "a@b.com", displayName: null, avatarUrl: null },
    ]),
    createProfile: vi.fn(),
  };
});

vi.mock("@osn/client/solid", () => ({
  useAuth: () => ({
    session: hoisted.session,
    profiles: hoisted.profiles,
    createProfile: hoisted.createProfile,
  }),
}));

vi.mock("solid-toast", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { ProfileOnboarding } from "../../src/auth/ProfileOnboarding";

describe("ProfileOnboarding", () => {
  beforeEach(() => {
    localStorage.removeItem(DISMISSED_KEY);
    hoisted.session.mockReturnValue({ accessToken: "tok" });
    hoisted.profiles.mockReturnValue([
      { id: "p_1", handle: "alice", email: "a@b.com", displayName: null, avatarUrl: null },
    ]);
    hoisted.createProfile.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it("renders when authenticated with exactly 1 profile", () => {
    render(() => <ProfileOnboarding />);
    expect(screen.getByText("Add another profile")).toBeTruthy();
  });

  it("does not render when user has multiple profiles", () => {
    hoisted.profiles.mockReturnValue([
      { id: "p_1", handle: "alice", email: "a@b.com", displayName: null, avatarUrl: null },
      { id: "p_2", handle: "bob", email: "b@b.com", displayName: null, avatarUrl: null },
    ]);
    render(() => <ProfileOnboarding />);
    expect(screen.queryByText("Add another profile")).toBeNull();
  });

  it("does not render when there is no session", () => {
    hoisted.session.mockReturnValue(null);
    render(() => <ProfileOnboarding />);
    expect(screen.queryByText("Add another profile")).toBeNull();
  });

  it("dismiss button hides card and persists to localStorage", () => {
    render(() => <ProfileOnboarding dismissible />);
    expect(screen.getByText("Add another profile")).toBeTruthy();

    fireEvent.click(screen.getByLabelText("Dismiss"));
    expect(screen.queryByText("Add another profile")).toBeNull();
    expect(localStorage.getItem(DISMISSED_KEY)).toBe("1");
  });

  it("does not render when previously dismissed", () => {
    localStorage.setItem(DISMISSED_KEY, "1");
    render(() => <ProfileOnboarding />);
    expect(screen.queryByText("Add another profile")).toBeNull();
  });

  it("clicking 'Create profile' opens the create dialog", async () => {
    render(() => <ProfileOnboarding />);
    fireEvent.click(screen.getByText("Create profile"));

    await waitFor(() => {
      expect(screen.getByText("Create a new profile")).toBeTruthy();
    });
  });
});
