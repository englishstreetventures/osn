/**
 * pulse's guest list, `RsvpModal`, under pulse's stylesheet at a phone width:
 * the one `Dialog` that scrolls a list of its own inside the panel, below a
 * tab row that stays put. `@shared/ui`'s panel is capped and scrolls at every
 * width, with a fade under its header once the panel scrolls; the guest list
 * sets its own cap and a column the list fills, so the panel itself fits and
 * only the list scrolls. With 60 guests on a 390×600 window: the panel does
 * not scroll, the list does, and scrolled to its end the header draws no fade.
 */

import { cleanup, render, screen } from "@solidjs/testing-library";
import { afterEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";

import type { Rsvp } from "../../src/lib/rsvps";

const guests: Rsvp[] = Array.from({ length: 60 }, (_, i) => ({
  id: `rsvp_${i}`,
  eventId: "evt_1",
  profileId: `usr_${i}`,
  status: "going",
  invitedByProfileId: null,
  isCloseFriend: false,
  createdAt: "2026-11-01T00:00:00Z",
  profile: { id: `usr_${i}`, handle: `guest${i}`, displayName: `Guest ${i}`, avatarUrl: null },
}));

vi.mock("../../src/lib/rsvps", () => ({
  fetchRsvpsByStatus: () => Promise.resolve(guests),
}));

import { RsvpModal } from "../../src/components/RsvpModal";

import "../../src/app.css";

afterEach(() => cleanup());

const frames = () =>
  new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );

it("scrolls the guest list inside a panel that fits, with no fade under the title", async () => {
  await page.viewport(390, 600);
  render(() => (
    <RsvpModal
      event={{
        id: "evt_1",
        guestListVisibility: "public",
        allowInterested: true,
        joinPolicy: "open",
        createdByProfileId: "usr_0",
      }}
      currentProfileId="usr_0"
      onClose={() => {}}
    />
  ));
  const panel = await vi.waitFor(() => screen.getByRole("dialog", { name: "Guest list" }));
  await vi.waitFor(() => screen.getByText("Guest 59"));
  const timed = document.getAnimations().filter((a) => a.timeline instanceof DocumentTimeline);
  await Promise.all(timed.map((a) => a.finished.catch(() => undefined)));
  await frames();

  const list = screen.getByRole("list").parentElement!;
  const header = screen.getByRole("heading", { name: "Guest list" }).parentElement!;
  expect(panel.scrollHeight).toBeLessThanOrEqual(panel.clientHeight);
  expect(list.scrollHeight).toBeGreaterThan(list.clientHeight);

  list.scrollTop = list.scrollHeight;
  await frames();
  expect(list.scrollTop).toBeGreaterThan(0);
  expect(Number(getComputedStyle(header, "::after").opacity)).toBe(0);
  await page.screenshot({
    path: "__screenshots__/rsvp-modal-scroll.browser.test.tsx/390x600-end.png",
  });
});
