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
  accountLink: { enabled: true, signedIn: true, linkedGuestIds: ["g-ada"] },
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("draws the account link from the claim payload, with no request to wait on", async () => {
  const fetchMock = vi.fn(() => new Promise<Response>(() => {}));
  vi.stubGlobal("fetch", fetchMock);

  const view = render(() => (
    <LoginSection apiUrl="https://api.test" result={household} onClaimed={() => {}} />
  ));

  await view.findByText("Link your Pulse account", {}, { timeout: 3000 });
  // Drawn in the payload's state: signed in, Ada's seat already linked.
  expect(view.getByText("Which guest are you?")).toBeTruthy();
  expect(view.getAllByText("✓ Linked")).toHaveLength(1);
  expect(fetchMock).not.toHaveBeenCalled();
});

it("draws the sign-in control, not the picker, when the payload says signed out", async () => {
  const fetchMock = vi.fn(() => new Promise<Response>(() => {}));
  vi.stubGlobal("fetch", fetchMock);

  const view = render(() => (
    <LoginSection
      apiUrl="https://api.test"
      result={{ ...household, accountLink: { enabled: true, signedIn: false, linkedGuestIds: [] } }}
      onClaimed={() => {}}
    />
  ));

  await view.findByRole("button", { name: "Sign in with musubi" }, { timeout: 3000 });
  expect(view.queryByText("Which guest are you?")).toBeNull();
  expect(fetchMock).not.toHaveBeenCalled();
});

it("keeps a new link when a later copy of the same payload arrives", async () => {
  // Linking answers 201; nothing else is asked.
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
    <LoginSection apiUrl="https://api.test" result={result()} onClaimed={() => {}} />
  ));
  await view.findByText("Which guest are you?", {}, { timeout: 3000 });
  fireEvent.click(view.getByLabelText(/Chidi Okafor/));
  fireEvent.click(view.getByRole("button", { name: "Link my account" }));
  await waitFor(() => expect(view.getAllByText("✓ Linked")).toHaveLength(2));

  // An RSVP save hands the page a new result spread from the old one, still
  // carrying the link state from before Chidi linked.
  setResult({ ...result(), rsvps: [] });

  expect(view.getAllByText("✓ Linked")).toHaveLength(2);
  expect((view.getByLabelText(/Chidi Okafor/) as HTMLInputElement).disabled).toBe(true);
});
