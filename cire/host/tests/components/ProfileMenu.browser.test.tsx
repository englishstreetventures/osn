import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, describe, expect, it } from "vitest";

import "../../src/styles/global.css";
import ProfileMenu from "../../src/components/ProfileMenu";

/**
 * `menu-pop` on a Kobalte dropdown, as the engine runs it: the menu scales up
 * and fades in on open, and on close stays mounted until its own exit has run.
 * Kobalte keeps a closing panel only while an animation with a different name
 * from the opening one is running, so an exit that reused the entry's
 * keyframes would drop the menu at once — which jsdom, running no animation,
 * cannot see. The profile menu stands for the seven popovers and menus that
 * carry the utility.
 */

const SESSION = {
  osnProfileId: "usr_1",
  email: "alex@example.com",
  handle: "alex",
  displayName: "Alex Host",
  avatarUrl: null,
  expiresAt: "2099-01-01T00:00:00Z",
};

const menu = () => screen.queryByRole("menu");

afterEach(() => cleanup());

describe("the profile menu's motion", () => {
  it("pops in on open, and stays mounted through its own exit on close", async () => {
    render(() => <ProfileMenu session={SESSION} onSecurity={() => {}} onSignOut={() => {}} />);
    fireEvent.pointerDown(screen.getByRole("button", { name: /account menu/i }), { button: 0 });
    const open = await waitFor(() => menu()!);
    expect(getComputedStyle(open).animationName).toBe("menu-pop-in");
    await Promise.all(open.getAnimations().map((a) => a.finished));

    fireEvent.keyDown(open, { key: "Escape" });
    await waitFor(() => expect(open.hasAttribute("data-closed")).toBe(true));
    expect(getComputedStyle(open).animationName).toBe("menu-pop-out");
    expect(open.isConnected).toBe(true);
    await waitFor(() => expect(open.isConnected).toBe(false));
  });
});
