// @vitest-environment happy-dom
import { AuthContext } from "@osn/client/solid";
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ProfileSwitcherDialog } from "../../src/components/ProfileSwitcherDialog";

function resource<T>(value: T) {
  return Object.assign(() => value, {
    state: "ready",
    loading: false,
    error: undefined,
    latest: null,
    refetch: () => {},
    mutate: () => {},
  });
}

const alice = {
  id: "usr_1",
  handle: "alice",
  displayName: "Alice",
  email: "a@b.com",
  avatarUrl: null,
};
const bob = { id: "usr_2", handle: "bob", displayName: null, email: "a@b.com", avatarUrl: null };

function makeAuth(switchProfile: (id: string) => Promise<unknown>) {
  const authValue = {
    session: resource({ accessToken: "tkn", idToken: null, expiresAt: 0, scopes: [] }),
    profiles: resource([alice, bob]),
    activeProfileId: () => "usr_1",
    logout: () => Promise.resolve(),
    adoptSession: () => Promise.resolve(),
    switchProfile,
    createProfile: () => Promise.reject(new Error("unused")),
    deleteProfile: () => Promise.resolve(),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mocked AuthContext; full interface fidelity not required
  return authValue as any;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- mocked AuthContext value
function renderSwitcher(auth: any, onOpenChange: (open: boolean) => void) {
  return render(() => (
    <AuthContext.Provider value={auth}>
      <ProfileSwitcherDialog open={true} onOpenChange={onOpenChange} />
    </AuthContext.Provider>
  ));
}

/** The dialog renders through a portal, so rows are looked up on `screen`
 *  (document.body), not the render container. */
function profileRow(handle: string): HTMLButtonElement {
  const row = screen.getAllByRole("button").find((b) => b.textContent?.includes(`@${handle}`)) as
    | HTMLButtonElement
    | undefined;
  expect(row).toBeDefined();
  return row!;
}

afterEach(() => {
  cleanup();
});

describe("<ProfileSwitcherDialog />", () => {
  it("switches to an inactive profile and closes on success", async () => {
    const switchProfile = vi.fn(() =>
      Promise.resolve({ session: { accessToken: "t2" }, profile: bob }),
    );
    const onOpenChange = vi.fn();
    renderSwitcher(makeAuth(switchProfile), onOpenChange);

    fireEvent.click(profileRow("bob"));
    await waitFor(() => expect(switchProfile).toHaveBeenCalledWith("usr_2"));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it("stays open and re-enables the rows when the switch fails", async () => {
    const switchProfile = vi.fn(() => Promise.reject(new Error("boom")));
    const onOpenChange = vi.fn();
    renderSwitcher(makeAuth(switchProfile), onOpenChange);

    const row = profileRow("bob");
    fireEvent.click(row);
    await waitFor(() => expect(switchProfile).toHaveBeenCalled());
    expect(onOpenChange).not.toHaveBeenCalled();
    await waitFor(() => expect(row.disabled).toBe(false));
  });

  it("never calls switchProfile for the already-active profile", async () => {
    const switchProfile = vi.fn(() => Promise.reject(new Error("must not be called")));
    renderSwitcher(makeAuth(switchProfile), () => {});

    fireEvent.click(profileRow("alice"));
    // Give any (incorrect) async work a tick to surface.
    await new Promise((r) => setTimeout(r, 0));
    expect(switchProfile).not.toHaveBeenCalled();
  });
});
