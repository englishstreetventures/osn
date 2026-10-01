// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";

import { LoginSection } from "../../src/components/LoginSection";
import type { ClaimResult } from "../../src/components/types";

/**
 * The account-link box sits above the events. If it appeared a request after
 * the invite opened, it would push events already on screen down the page —
 * on every session restore, where the welcome and the events arrive together.
 *
 * So it must draw from the claim payload alone. The real panel and the real
 * account link render here, with every network request held unanswered: the
 * box still appears, and nothing is even asked. Only the lazy chunk stands
 * between the payload and the box, and that download starts as the claim or
 * restore begins (LoginSection.lazy.test.tsx, LoginSection.warm.test.tsx).
 */

const household: ClaimResult = {
  publicId: "OKAFOR-LILY-AB12CD",
  familyName: "Okafor",
  members: [
    { guestId: "g-chidi", firstName: "Chidi", lastName: "Okafor", nickname: null, eventIds: [] },
    { guestId: "g-ada", firstName: "Ada", lastName: "Okafor", nickname: null, eventIds: [] },
  ],
  events: [],
  rsvps: [],
  accountLink: {
    enabled: true,
    signedIn: true,
    linkedGuestIds: [],
    account: { displayName: "Chidi O", handle: "chidi", avatarUrl: null, matchesMember: false },
  },
  member: { guestId: "g-chidi" },
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("draws the account link from the claim payload, with no request to wait on", async () => {
  const fetchMock = vi.fn(() => new Promise<Response>(() => {}));
  vi.stubGlobal("fetch", fetchMock);

  const view = render(() => (
    <LoginSection
      apiUrl="https://api.test"
      result={household}
      onClaimed={() => {}}
      onMemberChange={() => {}}
    />
  ));

  await view.findByText("Link your musubi account", {}, { timeout: 3000 });
  // Drawn in the payload's state: signed in, the account named before Link.
  expect(view.getByText("Link Chidi to @chidi?")).toBeTruthy();
  expect(fetchMock).not.toHaveBeenCalled();
});

it("draws the sign-in control when the payload says signed out", async () => {
  const fetchMock = vi.fn(() => new Promise<Response>(() => {}));
  vi.stubGlobal("fetch", fetchMock);

  const view = render(() => (
    <LoginSection
      apiUrl="https://api.test"
      result={{ ...household, accountLink: { enabled: true, signedIn: false, linkedGuestIds: [] } }}
      onClaimed={() => {}}
      onMemberChange={() => {}}
    />
  ));

  await view.findByRole("button", { name: "Sign in with musubi" }, { timeout: 3000 });
  expect(view.queryByText(/Link Chidi to/)).toBeNull();
  expect(fetchMock).not.toHaveBeenCalled();
});

it("hands a new link to the page, which keeps it through a later copy of the payload", async () => {
  const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
    Promise.resolve(
      init?.method === "POST"
        ? Response.json({ linked: true, guestId: "g-chidi" }, { status: 201 })
        : new Promise<Response>(() => {}),
    ),
  );
  vi.stubGlobal("fetch", fetchMock);
  const [result, setResult] = createSignal<ClaimResult>(household);

  const view = render(() => (
    <LoginSection
      apiUrl="https://api.test"
      result={result()}
      onClaimed={() => {}}
      onMemberChange={(update) => setResult(update(result()))}
    />
  ));
  fireEvent.click(await view.findByRole("button", { name: "Link" }, { timeout: 3000 }));
  await waitFor(() => expect(view.getByText("✓ Linked")).toBeTruthy());

  // An RSVP save hands the page a new result spread from its current one.
  setResult({ ...result(), rsvps: [] });
  expect(view.getByText("✓ Linked")).toBeTruthy();
});
