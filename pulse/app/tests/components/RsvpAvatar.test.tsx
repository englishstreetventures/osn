import { cleanup, render } from "@solidjs/testing-library";
// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";

import { RsvpAvatar } from "../../src/components/RsvpAvatar";
import type { Rsvp } from "../../src/lib/rsvps";
import { CLOSE_FRIEND_RING_CLASS } from "../../src/lib/ui";

const baseRsvp: Rsvp = {
  id: "rsvp_1",
  eventId: "evt_1",
  userId: "usr_bob",
  status: "going",
  invitedByUserId: null,
  isCloseFriend: false,
  createdAt: "2030-01-01T00:00:00Z",
  user: { id: "usr_bob", handle: "bob", displayName: "Bob Smith", avatarUrl: null },
};

describe("RsvpAvatar", () => {
  afterEach(() => cleanup());

  it("renders initials when user has no avatar URL", () => {
    const { container } = render(() => <RsvpAvatar rsvp={baseRsvp} />);
    const initials = container.querySelector("span.inline-flex");
    expect(initials).toBeTruthy();
    expect(initials!.textContent).toBe("BS");
  });

  it("renders an <img> when user has an avatar URL", () => {
    const { container } = render(() => (
      <RsvpAvatar
        rsvp={{ ...baseRsvp, user: { ...baseRsvp.user!, avatarUrl: "https://x/y.jpg" } }}
      />
    ));
    const img = container.querySelector("img") as HTMLImageElement;
    expect(img).toBeTruthy();
    expect(img.src).toBe("https://x/y.jpg");
  });

  it("does NOT apply the close-friend ring when isCloseFriend is false", () => {
    const { container } = render(() => <RsvpAvatar rsvp={baseRsvp} />);
    const initials = container.querySelector("span.inline-flex") as HTMLElement;
    // Sanity: the ring class should be absent when the flag is false.
    for (const cls of CLOSE_FRIEND_RING_CLASS.split(" ")) {
      expect(initials.classList.contains(cls)).toBe(false);
    }
  });

  it("applies the centralised close-friend ring class when isCloseFriend is true", () => {
    const { container } = render(() => <RsvpAvatar rsvp={{ ...baseRsvp, isCloseFriend: true }} />);
    const initials = container.querySelector("span.inline-flex") as HTMLElement;
    // Every class from the centralised constant should be present —
    // changing the constant in lib/ui.ts updates the affordance, and
    // this test verifies the connection between the constant and the
    // rendered DOM is intact.
    for (const cls of CLOSE_FRIEND_RING_CLASS.split(" ")) {
      expect(initials.classList.contains(cls)).toBe(true);
    }
  });

  it("applies the close-friend ring to the <img> variant too", () => {
    const { container } = render(() => (
      <RsvpAvatar
        rsvp={{
          ...baseRsvp,
          isCloseFriend: true,
          user: { ...baseRsvp.user!, avatarUrl: "https://x/y.jpg" },
        }}
      />
    ));
    const img = container.querySelector("img") as HTMLImageElement;
    for (const cls of CLOSE_FRIEND_RING_CLASS.split(" ")) {
      expect(img.classList.contains(cls)).toBe(true);
    }
  });

  it("uses the larger size when size='md' is passed", () => {
    const { container } = render(() => <RsvpAvatar rsvp={baseRsvp} size="md" />);
    const initials = container.querySelector("span.inline-flex") as HTMLElement;
    expect(initials.classList.contains("w-10")).toBe(true);
    expect(initials.classList.contains("h-10")).toBe(true);
  });
});
