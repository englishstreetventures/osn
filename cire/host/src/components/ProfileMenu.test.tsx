// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";

import ProfileMenu from "./ProfileMenu";

/**
 * ProfileMenu is the masthead's account affordance: an avatar trigger opening
 * the account-scoped actions (security, sign out) with the signed-in identity
 * named at the top. Kobalte's menu trigger opens on pointerdown and its items
 * select on pointerup — the interactions below mirror that.
 */

const SESSION = {
  osnProfileId: "usr_1",
  email: "alex@example.com",
  handle: "alex",
  displayName: "Alex Host",
  avatarUrl: null,
  expiresAt: "2099-01-01T00:00:00Z",
};

function openMenu() {
  fireEvent.pointerDown(screen.getByRole("button", { name: /account menu/i }), { button: 0 });
}

describe("ProfileMenu", () => {
  afterEach(cleanup);

  it("renders an initial from the display name when there is no avatar image", () => {
    render(() => <ProfileMenu session={SESSION} onSecurity={() => {}} onSignOut={() => {}} />);
    const trigger = screen.getByRole("button", { name: /account menu/i });
    expect(trigger.textContent).toBe("A");
    expect(trigger.querySelector("img")).toBeNull();
  });

  it("renders the avatar image when the session carries one", () => {
    render(() => (
      <ProfileMenu
        session={{ ...SESSION, avatarUrl: "https://cdn.test/alex.png" }}
        onSecurity={() => {}}
        onSignOut={() => {}}
      />
    ));
    const img = screen
      .getByRole("button", { name: /account menu/i })
      .querySelector("img") as HTMLImageElement;
    expect(img).toBeTruthy();
    expect(img.src).toBe("https://cdn.test/alex.png");
  });

  it("refuses a non-https avatar URL and falls back to the initial", () => {
    // The `picture` claim is unvalidated upstream — the sink enforces https.
    for (const avatarUrl of ["http://cdn.test/alex.png", "javascript:alert(1)", "not a url"]) {
      const { unmount } = render(() => (
        <ProfileMenu
          session={{ ...SESSION, avatarUrl }}
          onSecurity={() => {}}
          onSignOut={() => {}}
        />
      ));
      const trigger = screen.getByRole("button", { name: /account menu/i });
      expect(trigger.querySelector("img")).toBeNull();
      expect(trigger.textContent).toBe("A");
      unmount();
    }
  });

  it("names the account (display name + handle) at the top of the open menu", async () => {
    render(() => <ProfileMenu session={SESSION} onSecurity={() => {}} onSignOut={() => {}} />);
    openMenu();
    expect(await screen.findByText("Alex Host")).toBeTruthy();
    expect(screen.getByText("@alex")).toBeTruthy();
  });

  it("renders the loading/absent-session fallbacks without crashing", async () => {
    // useAuth().session is a Resource: undefined while the probe is in flight,
    // null when signed out — the masthead renders through both on every load.
    render(() => <ProfileMenu session={null} onSecurity={() => {}} onSignOut={() => {}} />);
    expect(screen.getByRole("button", { name: /account menu/i }).textContent).toBe("Y");
    openMenu();
    expect(await screen.findByText("Your account")).toBeTruthy();
    expect(screen.queryByText(/@/)).toBeNull();
  });

  it("shows the email as the detail line when the account has no handle", async () => {
    render(() => (
      <ProfileMenu
        session={{ ...SESSION, handle: null }}
        onSecurity={() => {}}
        onSignOut={() => {}}
      />
    ));
    openMenu();
    expect(await screen.findByText("Alex Host")).toBeTruthy();
    expect(screen.getByText("alex@example.com")).toBeTruthy();
    expect(screen.queryByText(/@alex$/)).toBeNull();
  });

  it("renders no detail line when there is nothing beyond the display name", async () => {
    render(() => (
      <ProfileMenu
        session={{ ...SESSION, handle: null, email: null }}
        onSecurity={() => {}}
        onSignOut={() => {}}
      />
    ));
    openMenu();
    const name = await screen.findByText("Alex Host");
    // The identity header holds only the primary line — no sibling detail span.
    expect(name.parentElement?.querySelectorAll("span")).toHaveLength(1);
  });

  it("falls back to the handle as the primary line (no duplicate detail row)", async () => {
    render(() => (
      <ProfileMenu
        session={{ ...SESSION, displayName: null }}
        onSecurity={() => {}}
        onSignOut={() => {}}
      />
    ));
    openMenu();
    expect(await screen.findByText("alex")).toBeTruthy();
    // The secondary line is the email, never a repeat of the primary line.
    expect(screen.queryByText("@alex")).toBeNull();
    expect(screen.getByText("alex@example.com")).toBeTruthy();
  });

  it("selecting Security & passkeys fires onSecurity", async () => {
    const onSecurity = vi.fn();
    render(() => <ProfileMenu session={SESSION} onSecurity={onSecurity} onSignOut={() => {}} />);
    openMenu();
    fireEvent.pointerUp(await screen.findByText(/Security & passkeys/i), { button: 0 });
    expect(onSecurity).toHaveBeenCalledOnce();
  });

  it("selecting Sign out fires onSignOut", async () => {
    const onSignOut = vi.fn();
    render(() => <ProfileMenu session={SESSION} onSecurity={() => {}} onSignOut={onSignOut} />);
    openMenu();
    fireEvent.pointerUp(await screen.findByText(/Sign out/i), { button: 0 });
    expect(onSignOut).toHaveBeenCalledOnce();
  });
});
