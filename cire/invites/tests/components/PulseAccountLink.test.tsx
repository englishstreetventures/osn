// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AccountLinkState, FamilyMember, SignedInAccount } from "../../src/components/types";

/**
 * PulseAccountLink owns the guest "Link your musubi account" box for the
 * member the household chose. Sign-in itself is a redirect to the identity
 * app, owned by `@shared/rp-auth` — its sign-in and credentialed fetch are
 * stubbed here; `AuthExpiredError` and `isAuthExpired` are the real ones.
 * What this file asserts is the wiring the component introduces:
 *   - it draws from the link state alone: no request on mount
 *   - signed out ⇒ "Sign in with musubi", sent with prompt=select_account
 *   - signed in, unlinked ⇒ the account's picture, name and @handle before
 *     "Link {name} to @handle?"; Link POSTs with no body
 *   - the four return-visit states of a linked member
 *   - "Not you?" hands off to the panel
 */

const authFetchMock = vi.fn();
const signInMock = vi.fn();

vi.mock("@shared/rp-auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@shared/rp-auth")>()),
  createAuthFetch: () => authFetchMock,
  startSignIn: (...args: unknown[]) => signInMock(...args),
}));

import { AuthExpiredError } from "@shared/rp-auth";

import { PulseAccountLink } from "../../src/components/PulseAccountLink";

const API = "http://api.test";
const ADA: FamilyMember = {
  guestId: "g-ada",
  firstName: "Ada",
  lastName: "Okafor",
  nickname: null,
  eventIds: [],
};
const ACCOUNT: SignedInAccount = {
  displayName: "Ada Okafor",
  handle: "ada",
  avatarUrl: "https://avatars.example/ada.png",
  matchesMember: false,
};

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

const realFetch = globalThis.fetch;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  authFetchMock.mockReset();
  signInMock.mockReset();
  fetchMock = vi.fn();
  globalThis.fetch = fetchMock as typeof fetch;
});

afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
});

function renderBox(state: AccountLinkState) {
  const onLinked = vi.fn();
  const onUnlinked = vi.fn();
  const onNotYou = vi.fn();
  const view = render(() => (
    <PulseAccountLink
      apiUrl={API}
      member={ADA}
      state={state}
      onLinked={onLinked}
      onUnlinked={onUnlinked}
      onNotYou={onNotYou}
      class="mb-8"
    />
  ));
  return { view, onLinked, onUnlinked, onNotYou };
}

describe("PulseAccountLink", () => {
  it("draws at once from the state, with no request of its own", () => {
    renderBox({ signedIn: false, linkedGuestIds: [] });
    expect(screen.getByText("Link your musubi account")).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(authFetchMock).not.toHaveBeenCalled();
  });

  it("signs in with prompt=select_account, so musubi always shows the account", async () => {
    renderBox({ signedIn: false, linkedGuestIds: [] });
    await fireEvent.click(screen.getByRole("button", { name: "Sign in with musubi" }));
    expect(signInMock).toHaveBeenCalledWith({ apiBase: API }, window.location.href, {
      prompt: "select_account",
    });
  });

  it("names the signed-in account before linking, and links with no body", async () => {
    authFetchMock.mockResolvedValueOnce(jsonResponse(201, { linked: true, guestId: "g-ada" }));
    const { onLinked } = renderBox({ signedIn: true, linkedGuestIds: [], account: ACCOUNT });
    expect(screen.getByText("Ada Okafor")).toBeTruthy();
    expect(screen.getByText("@ada")).toBeTruthy();
    expect(screen.getByText("Link Ada to @ada?")).toBeTruthy();
    await fireEvent.click(screen.getByRole("button", { name: "Link" }));
    await waitFor(() => expect(onLinked).toHaveBeenCalledWith("g-ada"));
    const [url, init] = authFetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${API}/api/account/link`);
    expect(init.method).toBe("POST");
    expect(init.body).toBeUndefined();
  });

  it("falls back to the account's initial when the picture will not load", async () => {
    const { view } = renderBox({ signedIn: true, linkedGuestIds: [], account: ACCOUNT });
    const img = view.container.querySelector("img");
    expect(img?.getAttribute("src")).toBe(ACCOUNT.avatarUrl);
    await fireEvent.error(img!);
    expect(view.container.querySelector("img")).toBeNull();
    expect(screen.getByText("A")).toBeTruthy();
  });

  it("treats a 409 already_linked as linked", async () => {
    authFetchMock.mockResolvedValueOnce(jsonResponse(409, { error: "already_linked" }));
    const { onLinked } = renderBox({ signedIn: true, linkedGuestIds: [], account: ACCOUNT });
    await fireEvent.click(screen.getByRole("button", { name: "Link" }));
    await waitFor(() => expect(onLinked).toHaveBeenCalledWith("g-ada"));
  });

  it("sends the household back to 'Who are you?' on 409 member_required", async () => {
    authFetchMock.mockResolvedValueOnce(jsonResponse(409, { error: "member_required" }));
    const { onLinked, onNotYou } = renderBox({
      signedIn: true,
      linkedGuestIds: [],
      account: ACCOUNT,
    });
    await fireEvent.click(screen.getByRole("button", { name: "Link" }));
    await waitFor(() => expect(onNotYou).toHaveBeenCalled());
    expect(onLinked).not.toHaveBeenCalled();
  });

  it("offers sign-in again when the sign-in has expired", async () => {
    authFetchMock.mockRejectedValueOnce(new AuthExpiredError());
    renderBox({ signedIn: true, linkedGuestIds: [], account: ACCOUNT });
    await fireEvent.click(screen.getByRole("button", { name: "Link" }));
    await screen.findByRole("button", { name: "Sign in with musubi" });
    expect(screen.getByRole("alert").textContent).toContain("sign-in expired");
  });

  it("shows the account for a member linked to it, with Unlink", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { linked: false, guestId: "g-ada" }));
    const { onUnlinked } = renderBox({
      signedIn: true,
      linkedGuestIds: ["g-ada"],
      account: { ...ACCOUNT, matchesMember: true },
    });
    expect(screen.getByText("@ada")).toBeTruthy();
    expect(screen.getByText("✓ Linked")).toBeTruthy();
    await fireEvent.click(screen.getByRole("button", { name: "Unlink" }));
    await waitFor(() => expect(onUnlinked).toHaveBeenCalledWith("g-ada"));
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`${API}/api/account/link/g-ada`);
  });

  it("names neither account when the member is linked to a different one", () => {
    const { view } = renderBox({ signedIn: true, linkedGuestIds: ["g-ada"] });
    expect(screen.getByText("Ada is linked to a different musubi account.")).toBeTruthy();
    expect(view.container.querySelector("img")).toBeNull();
    expect(screen.queryByText(/@/)).toBeNull();
  });

  it("says the member is linked when signed out, and offers sign-in to manage it", async () => {
    renderBox({ signedIn: false, linkedGuestIds: ["g-ada"] });
    expect(screen.getByText("Ada · linked to musubi")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Unlink" })).toBeNull();
    await fireEvent.click(screen.getByRole("button", { name: "Sign in to manage" }));
    expect(signInMock).toHaveBeenCalledWith({ apiBase: API }, window.location.href, {
      prompt: "select_account",
    });
  });

  it("hands 'Not you?' to the panel", async () => {
    const { onNotYou } = renderBox({ signedIn: true, linkedGuestIds: [], account: ACCOUNT });
    await fireEvent.click(screen.getByRole("button", { name: "Not you?" }));
    expect(onNotYou).toHaveBeenCalled();
  });
});
