import { cleanup, render } from "@solidjs/testing-library";
// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";

import { RsvpAvatar } from "../../src/components/RsvpAvatar";
import type { Rsvp } from "../../src/lib/rsvps";
import { CLOSE_FRIEND_RING_CLASS } from "../../src/lib/ui";

const baseRsvp: Rsvp = {
  id: "rsvp_1",
  eventId: "evt_1",
  profileId: "usr_bob",
  status: "going",
  invitedByProfileId: null,
  isCloseFriend: false,
  createdAt: "2030-01-01T00:00:00Z",
  profile: { id: "usr_bob", handle: "bob", displayName: "Bob Smith", avatarUrl: null },
};

/** The Avatar component renders an outer <span> wrapper with base: variant classes. */
function avatarWrapper(container: HTMLElement): HTMLElement {
  return container.querySelector("span.base\\:relative") as HTMLElement;
}

/** The AvatarFallback renders the initials text. */
function fallbackSpan(container: HTMLElement): HTMLElement | null {
  return avatarWrapper(container)?.querySelector("span") ?? null;
}

describe("RsvpAvatar", () => {
  afterEach(() => cleanup());

  it("renders initials when user has no avatar URL", () => {
    const { container } = render(() => <RsvpAvatar rsvp={baseRsvp} />);
    const initials = fallbackSpan(container);
    expect(initials).toBeTruthy();
    expect(initials!.textContent).toBe("BS");
  });

  it("renders an <img> when user has an avatar URL", () => {
    const { container } = render(() => (
      <RsvpAvatar
        rsvp={{ ...baseRsvp, profile: { ...baseRsvp.profile!, avatarUrl: "https://x/y.jpg" } }}
      />
    ));
    const img = container.querySelector("img") as HTMLImageElement;
    expect(img).toBeTruthy();
    expect(img.src).toBe("https://x/y.jpg");
  });

  it("does NOT apply the close-friend ring when isCloseFriend is false", () => {
    const { container } = render(() => <RsvpAvatar rsvp={baseRsvp} />);
    const wrapper = avatarWrapper(container);
    // Sanity: the ring class should be absent when the flag is false.
    for (const cls of CLOSE_FRIEND_RING_CLASS.split(" ")) {
      expect(wrapper.classList.contains(cls)).toBe(false);
    }
  });

  it("applies the centralised close-friend ring class when isCloseFriend is true", () => {
    const { container } = render(() => <RsvpAvatar rsvp={{ ...baseRsvp, isCloseFriend: true }} />);
    const wrapper = avatarWrapper(container);
    // Every class from the centralised constant should be present —
    // changing the constant in lib/ui.ts updates the affordance, and
    // this test verifies the connection between the constant and the
    // rendered DOM is intact.
    for (const cls of CLOSE_FRIEND_RING_CLASS.split(" ")) {
      expect(wrapper.classList.contains(cls)).toBe(true);
    }
  });

  it("applies the close-friend ring to the <img> variant too", () => {
    const { container } = render(() => (
      <RsvpAvatar
        rsvp={{
          ...baseRsvp,
          isCloseFriend: true,
          profile: { ...baseRsvp.profile!, avatarUrl: "https://x/y.jpg" },
        }}
      />
    ));
    // The close-friend ring is on the outer Avatar wrapper, not the img itself.
    const wrapper = avatarWrapper(container);
    for (const cls of CLOSE_FRIEND_RING_CLASS.split(" ")) {
      expect(wrapper.classList.contains(cls)).toBe(true);
    }
  });

  it("uses the larger size when size='md' is passed", () => {
    const { container } = render(() => <RsvpAvatar rsvp={baseRsvp} size="md" />);
    const wrapper = avatarWrapper(container);
    expect(wrapper.classList.contains("w-10")).toBe(true);
    expect(wrapper.classList.contains("h-10")).toBe(true);
  });
});
