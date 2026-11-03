import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, describe, expect, it } from "vitest";
import { userEvent } from "vitest/browser";

import "../../src/styles/global.css";
import ProfileMenu from "../../src/components/ProfileMenu";

/**
 * The shared menu's accent look in host's stylesheet, as the engine runs it:
 * the menu pops in on open at host's own `--dur-fast`, and on close leaves at
 * once with focus back on its trigger. An exit animation would hold the
 * closing menu mounted with focus inside it, and the hand-back would fall to
 * `<body>` — which jsdom, running no animation, cannot see. The profile menu
 * stands for every portal menu, all on the accent look.
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
    expect(getComputedStyle(open).animationName).toBe("ui-enter");
    // Host's pace, not the contract's default: the panel reads `--dur-fast`.
    const probe = document.createElement("div");
    probe.style.animationDuration = "var(--dur-fast)";
    document.body.append(probe);
    const fast = getComputedStyle(probe).animationDuration;
    probe.remove();
    expect(getComputedStyle(open).animationDuration).toBe(fast);
    await Promise.all(open.getAnimations().map((a) => a.finished));

    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(open.isConnected).toBe(false));
    expect(document.activeElement).toBe(trigger);
  });
});
