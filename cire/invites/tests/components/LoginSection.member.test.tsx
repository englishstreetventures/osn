// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";

import type { ClaimResult, FamilyMember } from "../../src/components/types";

/**
 * "Who are you?" — the household member step in the claim and welcome panel.
 * A claim code proves a household, not a person, so a household of two or
 * more says which member is at the keyboard; replies and the musubi link hang
 * off that choice. "Not you?" clears it and ends this browser's musubi
 * sign-in.
 */

const signOutMock = vi.fn(() => Promise.resolve());
vi.mock("@shared/rp-auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@shared/rp-auth")>()),
  signOut: (...args: unknown[]) => signOutMock(...(args as [])),
}));

vi.mock("../../src/components/PulseAccountLink", () => ({
  PulseAccountLink: (props: { member: FamilyMember }) => (
    <div data-testid="pulse-account-link-stub" data-member={props.member.guestId} />
  ),
}));

import { LoginSection } from "../../src/components/LoginSection";

const member = (firstName: string, extra: Partial<FamilyMember> = {}): FamilyMember => ({
  guestId: `g-${firstName}`,
  firstName,
  lastName: "Okafor",
  nickname: null,
  eventIds: [],
  ...extra,
});

const household = (members: FamilyMember[], chosen: string | null): ClaimResult => ({
  publicId: "OKAFOR-LILY-AB12CD",
  familyName: "Okafor",
  members,
  events: [],
  rsvps: [],
  accountLink: { enabled: true, signedIn: true, linkedGuestIds: [] },
  member: chosen === null ? null : { guestId: chosen },
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  signOutMock.mockClear();
});

function renderPanel(initial: ClaimResult) {
  const [result, setResult] = createSignal<ClaimResult>(initial);
  const view = render(() => (
    <LoginSection
      apiUrl="https://api.test"
      result={result()}
      onClaimed={() => {}}
      onMemberChange={(update) => setResult(update(result()))}
    />
  ));
  return { view, result };
}

it("asks a household of several who is answering, listing no plus-one", () => {
  vi.stubGlobal("fetch", vi.fn());
  const { view } = renderPanel(
    household([member("Chidi"), member("Ada"), member("Sam", { plusOneOf: "g-Chidi" })], null),
  );
  expect(view.getByText("Who are you?")).toBeTruthy();
  expect(view.getByRole("button", { name: "Chidi" })).toBeTruthy();
  expect(view.getByRole("button", { name: "Ada" })).toBeTruthy();
  expect(view.queryByRole("button", { name: "Sam" })).toBeNull();
  // No account link until someone is chosen.
  expect(view.queryByTestId("pulse-account-link-stub")).toBeNull();
});

it("asks nothing of a household with the step off", () => {
  vi.stubGlobal("fetch", vi.fn());
  const { member: _, ...off } = household([member("Chidi"), member("Ada")], null);
  const { view } = renderPanel(off);
  expect(view.queryByText("Who are you?")).toBeNull();
});

it("records the choice and takes the API's link state for that member", async () => {
  const fetchMock = vi.fn(() =>
    Promise.resolve(
      Response.json({
        member: { guestId: "g-Ada" },
        accountLink: { enabled: true, signedIn: true, linkedGuestIds: ["g-Ada"] },
      }),
    ),
  );
  vi.stubGlobal("fetch", fetchMock);
  const { view, result } = renderPanel(household([member("Chidi"), member("Ada")], null));

  fireEvent.click(view.getByRole("button", { name: "Ada" }));
  await view.findByText(/Answering as Ada/);
  const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe("https://api.test/api/claim/member");
  expect(init.method).toBe("POST");
  expect(init.body).toBe(JSON.stringify({ guestId: "g-Ada" }));
  expect(result().member).toEqual({ guestId: "g-Ada" });
  expect(result().accountLink).toEqual({
    enabled: true,
    signedIn: true,
    linkedGuestIds: ["g-Ada"],
  });
  expect((await view.findByTestId("pulse-account-link-stub")).dataset.member).toBe("g-Ada");
});

it("'Not you?' clears the member and ends the musubi sign-in", async () => {
  const fetchMock = vi.fn(() => Promise.resolve(new Response(null, { status: 204 })));
  vi.stubGlobal("fetch", fetchMock);
  const { view, result } = renderPanel(household([member("Chidi"), member("Ada")], "g-Chidi"));

  fireEvent.click(view.getByRole("button", { name: "Not you?" }));
  expect(view.getByText("Who are you?")).toBeTruthy();
  expect(result().member).toBeNull();
  expect(result().accountLink).toEqual({ enabled: true, signedIn: false, linkedGuestIds: [] });
  const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe("https://api.test/api/claim/member");
  expect(init.method).toBe("DELETE");
  await waitFor(() => expect(signOutMock).toHaveBeenCalledWith({ apiBase: "https://api.test" }));
});
