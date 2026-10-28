import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, describe, expect, it } from "vitest";
import { userEvent } from "vitest/browser";

import "../../src/styles/global.css";
import ProfileMenu from "../../src/components/ProfileMenu";

/**
 * `menu-pop` on a Kobalte dropdown, as the engine runs it: the menu scales up
 * and fades in on open, and on close leaves at once with focus back on its
 * trigger. An exit animation would hold the closing menu mounted with focus
 * inside it, and the hand-back would fall to `<body>` — which jsdom, running
 * no animation, cannot see. The profile menu stands for the seven popovers and
 * menus that carry the utility.
 */

const SESSION = {
  osnProfileId: "usr_1",
  email: "alex@example.com",
  handle: "alex",
  displayName: "Alex Host",
  avatarUrl: null,
  expiresAt: "2099-01-01T00:00:00Z",
};

afterEach(() => cleanup());

describe("the profile menu's motion", () => {
  it("pops in on open, and on Escape leaves at once with focus on its trigger", async () => {
    render(() => <ProfileMenu session={SESSION} onSecurity={() => {}} onSignOut={() => {}} />);
    const trigger = screen.getByRole("button", { name: /account menu/i });
    fireEvent.pointerDown(trigger, { button: 0 });
    const open = await waitFor(() => screen.getByRole("menu"));
    expect(getComputedStyle(open).animationName).toBe("menu-pop-in");
    await Promise.all(open.getAnimations().map((a) => a.finished));

    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(open.isConnected).toBe(false));
    expect(document.activeElement).toBe(trigger);
  });
});
