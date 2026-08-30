// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";

import ProfileMenu from "./ProfileMenu";

/**
 * The top bar's account affordance. Kobalte's menu trigger opens on pointerdown
 * and its items select on pointerup — the interactions below mirror that.
 */

const SESSION = {
  osnProfileId: "usr_1",
  email: "hello@acme.test",
  handle: "acme",
  displayName: "Acme Florals",
  avatarUrl: null,
  expiresAt: "2099-01-01T00:00:00Z",
};

function openMenu() {
  fireEvent.pointerDown(screen.getByRole("button", { name: /account menu/i }), { button: 0 });
}

describe("ProfileMenu", () => {
  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  it("renders an initial from the display name when there is no avatar image", () => {
    render(() => <ProfileMenu session={SESSION} onSignOut={() => {}} />);
    const trigger = screen.getByRole("button", { name: /account menu/i });
    expect(trigger.textContent).toBe("A");
    expect(trigger.querySelector("img")).toBeNull();
  });

  it("refuses a non-https avatar URL and falls back to the initial", () => {
    // The OIDC `picture` claim is unvalidated at every earlier hop, so the sink
    // is what enforces the scheme.
    // The URL is folded into the compared value rather than passed as a second
    // argument to `expect` (which `vitest/valid-expect` rejects), so a failure
    // still names which of the three got through.
    for (const avatarUrl of ["http://cdn.test/a.png", "javascript:alert(1)", "not a url"]) {
      const { unmount } = render(() => (
        <ProfileMenu session={{ ...SESSION, avatarUrl }} onSignOut={() => {}} />
      ));
      const trigger = screen.getByRole("button", { name: /account menu/i });
      expect({ avatarUrl, img: trigger.querySelector("img") }).toEqual({ avatarUrl, img: null });
      expect(trigger.textContent).toBe("A");
      unmount();
    }
  });

  it("names the signed-in account, so two accounts can be told apart", async () => {
    render(() => <ProfileMenu session={SESSION} onSignOut={() => {}} />);
    openMenu();
    await waitFor(() => expect(screen.getByText("Acme Florals")).toBeInTheDocument());
    expect(screen.getByText("@acme")).toBeInTheDocument();
  });

  it("offers all three theme states, not just the two visible ones", async () => {
    // Collapsing "system" into "dark" would silently convert a vendor who
    // follows their OS into one pinned to dark, the moment they opened the menu.
    render(() => <ProfileMenu session={SESSION} onSignOut={() => {}} />);
    openMenu();
    await waitFor(() =>
      expect(screen.getByRole("menuitemradio", { name: /system/i })).toBeInTheDocument(),
    );
    for (const name of [/system/i, /light/i, /dark/i]) {
      expect(screen.getByRole("menuitemradio", { name })).toBeInTheDocument();
    }
  });

  it("writes the chosen theme onto the document and remembers it", async () => {
    render(() => <ProfileMenu session={SESSION} onSignOut={() => {}} />);
    openMenu();
    await waitFor(() => screen.getByRole("menuitemradio", { name: /light/i }));

    const light = screen.getByRole("menuitemradio", { name: /light/i });
    fireEvent.pointerDown(light, { button: 0 });
    fireEvent.pointerUp(light, { button: 0 });
    fireEvent.click(light);

    await waitFor(() => expect(document.documentElement.getAttribute("data-theme")).toBe("light"));
    expect(localStorage.getItem("cire.vendor.theme")).toBe("light");
  });

  it("links account management out to musubi in a new tab, without an opener", async () => {
    // Passkeys and recovery codes are bound to the musubi RP ID, so every
    // ceremony has to run on musubi's own origin — there is no in-portal
    // security panel to open, unlike the host portal.
    render(() => <ProfileMenu session={SESSION} onSignOut={() => {}} />);
    openMenu();
    await waitFor(() => screen.getByRole("menuitem", { name: /account & passkeys/i }));

    const link = screen.getByRole("menuitem", { name: /account & passkeys/i });
    expect(link.tagName).toBe("A");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link.getAttribute("rel")).toContain("noopener");
    expect(link.getAttribute("href")).toContain("/settings");
  });

  it("signs out", async () => {
    const onSignOut = vi.fn();
    render(() => <ProfileMenu session={SESSION} onSignOut={onSignOut} />);
    openMenu();
    await waitFor(() => screen.getByRole("menuitem", { name: /sign out/i }));

    const item = screen.getByRole("menuitem", { name: /sign out/i });
    fireEvent.pointerDown(item, { button: 0 });
    fireEvent.pointerUp(item, { button: 0 });
    fireEvent.click(item);

    await waitFor(() => expect(onSignOut).toHaveBeenCalled());
  });

  // ── Haptics (T-U1) ────────────────────────────────────────────────────────

  it("offers a haptics switch at all, and defaults it on", async () => {
    // Whether a *stored* preference is honoured is `readHapticsPreference`'s
    // contract and is covered in `lib/theme.test.ts`, which re-imports the
    // module per case — the signal here is initialised once at module load, so
    // writing localStorage from this file could not affect it anyway.
    //
    // What this pins is the part only the menu can break: that the row is
    // rendered (it is gated on `hapticsAvailable()`, whose whole point is to
    // stay true on iOS, where the Vibration API check says no and the
    // switch-element fallback says yes) and that the default is on.
    render(() => <ProfileMenu session={SESSION} onSignOut={() => {}} />);
    openMenu();
    const row = await screen.findByRole("menuitemcheckbox", { name: /haptics/i });
    expect(row).toHaveAttribute("aria-checked", "true");
  });

  it("remembers the switch being turned off", async () => {
    render(() => <ProfileMenu session={SESSION} onSignOut={() => {}} />);
    openMenu();
    const row = await screen.findByRole("menuitemcheckbox", { name: /haptics/i });
    // Defaults to on, so the first press is a disable.
    expect(row).toHaveAttribute("aria-checked", "true");

    fireEvent.pointerDown(row, { button: 0 });
    fireEvent.pointerUp(row, { button: 0 });
    fireEvent.click(row);

    await waitFor(() => expect(localStorage.getItem("cire.vendor.haptics")).toBe("off"));
  });

  it("stays open when the switch is used, so it can be tried twice", async () => {
    render(() => <ProfileMenu session={SESSION} onSignOut={() => {}} />);
    openMenu();
    const row = await screen.findByRole("menuitemcheckbox", { name: /haptics/i });

    fireEvent.pointerDown(row, { button: 0 });
    fireEvent.pointerUp(row, { button: 0 });
    fireEvent.click(row);

    // `closeOnSelect={false}` — a setting you feel is one you try, feel, and
    // try again; closing the menu each time makes that a three-click job.
    await waitFor(() =>
      expect(screen.getByRole("menuitemcheckbox", { name: /haptics/i })).toBeInTheDocument(),
    );
  });
});
