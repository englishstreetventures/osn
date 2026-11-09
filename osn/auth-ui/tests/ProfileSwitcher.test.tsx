import type { PublicProfile } from "@osn/client";
// @vitest-environment happy-dom
import { render, cleanup, screen, fireEvent, waitFor } from "@solidjs/testing-library";
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

const sampleProfiles: PublicProfile[] = [
  { id: "p_1", handle: "alice", email: "a@b.com", displayName: "Alice", avatarUrl: null },
  { id: "p_2", handle: "bob", email: "b@b.com", displayName: null, avatarUrl: null },
];

const hoisted = vi.hoisted(() => {
  return {
    profiles: vi.fn(() => sampleProfiles),
    activeProfileId: vi.fn(() => "p_1"),
    switchProfile: vi.fn(),
    deleteProfile: vi.fn(),
    createProfile: vi.fn(),
    session: vi.fn(() => ({ accessToken: "tok" })),
  };
});

vi.mock("@osn/client/solid", () => ({
  useAuth: () => ({
    profiles: hoisted.profiles,
    activeProfileId: hoisted.activeProfileId,
    switchProfile: hoisted.switchProfile,
    deleteProfile: hoisted.deleteProfile,
    createProfile: hoisted.createProfile,
    session: hoisted.session,
  }),
}));

vi.mock("@shared/toast", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { toast } from "@shared/toast";

import { ProfileSwitcher } from "../src/ProfileSwitcher";
import { SERVER, WAIT, alertsText, apiError } from "./helpers/errors";

describe("ProfileSwitcher", () => {
  beforeEach(() => {
    hoisted.profiles.mockReturnValue(sampleProfiles);
    hoisted.activeProfileId.mockReturnValue("p_1");
    hoisted.switchProfile.mockReset();
    hoisted.deleteProfile.mockReset();
    hoisted.createProfile.mockReset();
    vi.mocked(toast.success).mockClear();
    vi.mocked(toast.error).mockClear();
  });

  afterEach(() => {
    cleanup();
  });

  it("opens popover and lists all profiles", async () => {
    render(() => <ProfileSwitcher />);
    fireEvent.click(screen.getByRole("button", { name: /@alice/ }));
    await waitFor(() => {
      expect(screen.getByText("Profiles")).toBeTruthy();
      expect(screen.getByText("@bob")).toBeTruthy();
    });
  });

  it("marks active profile with aria-current", async () => {
    render(() => <ProfileSwitcher />);
    fireEvent.click(screen.getByRole("button", { name: /@alice/ }));
    await waitFor(() => {
      const btn = document.querySelector("button[aria-current='true']");
      expect(btn).toBeTruthy();
      expect(btn!.textContent).toContain("alice");
    });
  });

  it("calls switchProfile when clicking a different profile", async () => {
    hoisted.switchProfile.mockResolvedValue({
      session: { accessToken: "tok2" },
      profile: sampleProfiles[1],
    });
    const onSwitch = vi.fn();
    render(() => <ProfileSwitcher onSwitch={onSwitch} />);

    // Open popover
    fireEvent.click(screen.getByRole("button", { name: /@alice/ }));
    await waitFor(() => screen.getByText("@bob"));

    // Click bob's profile row — find the button containing @bob text
    const bobButton = screen.getByText("@bob").closest("button") as HTMLButtonElement;
    fireEvent.click(bobButton);

    await waitFor(() => {
      expect(hoisted.switchProfile).toHaveBeenCalledWith("p_2");
    });
    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith("Switched to @bob");
      expect(onSwitch).toHaveBeenCalled();
    });
  });

  it("shows a failed switch inside the popover, with no error toast", async () => {
    vi.mocked(toast.error).mockClear();
    hoisted.switchProfile.mockRejectedValue(apiError("PLANTED Switch failed", 429, "rate_limited"));
    render(() => <ProfileSwitcher />);

    fireEvent.click(screen.getByRole("button", { name: /@alice/ }));
    await waitFor(() => screen.getByText("@bob"));

    const bobButton = screen.getByText("@bob").closest("button") as HTMLButtonElement;
    fireEvent.click(bobButton);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(WAIT);
    expect(alertsText()).not.toContain("PLANTED");
    expect(toast.error).not.toHaveBeenCalled();
    // Still beside the list it is about.
    expect(screen.getByText("@bob")).toBeTruthy();
  });

  it("shows a failed delete inside its dialog, with no error toast", async () => {
    vi.mocked(toast.error).mockClear();
    hoisted.deleteProfile.mockRejectedValue(apiError("PLANTED-delete", 500, "internal_error"));
    render(() => <ProfileSwitcher />);

    fireEvent.click(screen.getByRole("button", { name: /@alice/ }));
    await waitFor(() => screen.getByText("@bob"));
    fireEvent.click(screen.getByLabelText("Delete profile @bob"));
    await waitFor(() => screen.getByText(/Permanently delete/));
    const confirmBtn = Array.from(document.querySelectorAll("button")).find(
      (btn) => btn.textContent?.trim() === "Delete" && btn.className.includes("ui-danger"),
    ) as HTMLButtonElement;
    fireEvent.click(confirmBtn);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(SERVER);
    expect(alertsText()).not.toContain("PLANTED");
    expect(toast.error).not.toHaveBeenCalled();
    expect(screen.getByText(/Permanently delete/)).toBeTruthy();
  });

  it("opens delete confirmation and calls deleteProfile on confirm", async () => {
    hoisted.deleteProfile.mockResolvedValue(undefined);
    render(() => <ProfileSwitcher />);

    // Open popover
    fireEvent.click(screen.getByRole("button", { name: /@alice/ }));
    await waitFor(() => screen.getByText("@bob"));

    // Click delete button on bob's row
    const deleteBtn = screen.getByLabelText("Delete profile @bob");
    fireEvent.click(deleteBtn);

    // Confirmation dialog appears
    await waitFor(() => {
      expect(screen.getByText(/Permanently delete/)).toBeTruthy();
    });

    // Confirm deletion — the dialog footer has Cancel + Delete buttons, and the
    // row that opened it also says "Delete", so the variant is what tells them
    // apart. `ui-danger` rather than `destructive` since the primitives were
    // re-keyed onto the token contract; the assertion is unchanged in substance
    // — this still checks the confirm button is the destructive variant and not
    // the trigger.
    const allDeleteBtns = document.querySelectorAll("button");
    const confirmBtn = Array.from(allDeleteBtns).find(
      (btn) => btn.textContent?.trim() === "Delete" && btn.className.includes("ui-danger"),
    ) as HTMLButtonElement;
    expect(confirmBtn).toBeTruthy();
    await fireEvent.click(confirmBtn);

    await waitFor(() => {
      expect(hoisted.deleteProfile).toHaveBeenCalledWith("p_2");
      expect(toast.success).toHaveBeenCalledWith("Profile @bob deleted");
    });
  });

  it("does not call switchProfile when clicking already-active profile", async () => {
    render(() => <ProfileSwitcher />);

    fireEvent.click(screen.getByRole("button", { name: /@alice/ }));
    await waitFor(() => screen.getByText("Profiles"));

    // Click alice's row (active profile)
    const aliceBtn = document.querySelector("button[aria-current='true']") as HTMLButtonElement;
    fireEvent.click(aliceBtn);

    expect(hoisted.switchProfile).not.toHaveBeenCalled();
  });

  it("shows '+ Add profile' button that opens create dialog", async () => {
    render(() => <ProfileSwitcher />);

    fireEvent.click(screen.getByRole("button", { name: /@alice/ }));
    await waitFor(() => screen.getByText("+ Add profile"));

    fireEvent.click(screen.getByText("+ Add profile"));

    await waitFor(() => {
      expect(screen.getByText("Create a new profile")).toBeTruthy();
    });
  });
});
