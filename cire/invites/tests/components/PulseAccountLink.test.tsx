// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AccountLinkState, FamilyMember } from "../../src/components/types";

/**
 * PulseAccountLink owns the guest "Link my Pulse account" flow. Sign-in itself
 * is a redirect to the identity app, owned by `@shared/rp-auth` — its sign-in
 * and credentialed fetch are stubbed here; `AuthExpiredError` and
 * `isAuthExpired` are the real ones.
 * What this file asserts is the wiring the component introduces:
 *   - it draws from the claim payload's link state alone: no request on mount
 *   - signed-out ⇒ a "Sign in with musubi" control gates the picker, and it
 *     hands the sign-in the current invite URL so the guest lands back here
 *   - signed-in ⇒ pick a member → POST /api/account/link with { guestId }
 *   - the payload's linked seats seed the linked/unlinked indicators
 *   - unlink issues DELETE /api/account/link/:guestId
 *   - 409 already-linked is treated as linked, not an error
 *   - an expired sign-in falls back to the sign-in control; a network failure
 *     does not
 */

const authFetchMock = vi.fn();
const signInMock = vi.fn();

vi.mock("@shared/rp-auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@shared/rp-auth")>()),
  createAuthFetch: () => authFetchMock,
  startSignIn: (...args: unknown[]) => signInMock(...args),
}));

vi.mock("@shared/toast", () => ({
  Toaster: () => null,
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { AuthExpiredError } from "@shared/rp-auth";

import { PulseAccountLink } from "../../src/components/PulseAccountLink";

const API = "http://api.test";

function member(firstName: string, id = `g-${firstName}`): FamilyMember {
  return { guestId: id, firstName, lastName: "Okafor", nickname: null, eventIds: [] };
}

const SIGNED_OUT: AccountLinkState = { signedIn: false, linkedGuestIds: [] };
const SIGNED_IN: AccountLinkState = { signedIn: true, linkedGuestIds: [] };

function renderLink(members: FamilyMember[], state: AccountLinkState = SIGNED_IN) {
  return render(() => <PulseAccountLink apiUrl={API} members={members} state={state} />);
}

/** Build a minimal Response-like object for the fetch mocks. */
function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
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

describe("PulseAccountLink", () => {
  it("draws at once from the payload's state, with no request of its own", () => {
    renderLink([member("Chidi"), member("Ada")], { signedIn: true, linkedGuestIds: ["g-Ada"] });

    // Synchronously on first render: nothing to wait for.
    expect(screen.getByText(/Link your Pulse account/i)).toBeTruthy();
    expect(screen.getByText(/Which guest are you/i)).toBeTruthy();
    expect(screen.getByText(/✓ Linked/i)).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(authFetchMock).not.toHaveBeenCalled();
  });

  it("shows the sign-in affordance when signed out", () => {
    renderLink([member("Chidi")], SIGNED_OUT);
    // Signed out → the sign-in control gates the picker, and the picker itself
    // is nowhere on the page.
    const button = screen.getByRole("button", { name: /Sign in with musubi/i });
    expect(screen.queryByText(/Which guest are you/i)).toBeNull();

    fireEvent.click(button);
    // The return-to is the invite URL itself — the guest cookie re-opens the
    // claimed view when they come back.
    expect(signInMock).toHaveBeenCalledWith({ apiBase: API }, window.location.href);
  });

  it("takes its placement from the panel that hosts it, and keeps its own surface", () => {
    // The claim and welcome panel decides width, centring and spacing per
    // layout; the component keeps only its bordered, tinted box.
    const { container } = render(() => (
      <PulseAccountLink
        apiUrl={API}
        members={[member("Chidi")]}
        state={SIGNED_OUT}
        class="max-w-column-sm mb-8"
      />
    ));
    const classes = container
      .querySelector("section[aria-labelledby='pulse-link-heading']")!
      .className.split(/\s+/);
    expect(classes).toEqual(expect.arrayContaining(["mb-8", "max-w-column-sm", "border"]));
    // No placement of its own left to fight the panel's.
    expect(classes).not.toContain("mt-10");
    expect(classes).not.toContain("mx-auto");
  });

  it("links the picked member via POST when signed in", async () => {
    // POST link → 201 created.
    authFetchMock.mockResolvedValue(jsonResponse(201, { linked: true, guestId: "g-Chidi" }));

    renderLink([member("Chidi"), member("Ada")]);

    // Pick Chidi, then link.
    fireEvent.click(screen.getByLabelText(/Chidi Okafor/i));
    fireEvent.click(screen.getByRole("button", { name: /Link my account/i }));

    await waitFor(() => {
      expect(authFetchMock).toHaveBeenCalledWith(
        `${API}/api/account/link`,
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ guestId: "g-Chidi" }),
        }),
      );
    });
    // The picked member now shows as linked.
    await waitFor(() => expect(screen.getByText(/✓ Linked/i)).toBeTruthy());
  });

  it("offers unlink for the seats the payload says are linked", () => {
    renderLink([member("Chidi"), member("Ada")], { signedIn: true, linkedGuestIds: ["g-Ada"] });
    expect(screen.getAllByText(/✓ Linked/i)).toHaveLength(1);
    expect(screen.getByRole("button", { name: /^Unlink$/i })).toBeTruthy();
    // A linked seat cannot be picked again.
    expect((screen.getByLabelText(/Ada Okafor/i) as HTMLInputElement).disabled).toBe(true);
  });

  it("treats a 409 conflict as linked rather than an error", async () => {
    authFetchMock.mockResolvedValue(jsonResponse(409, { error: "already_linked" }));

    renderLink([member("Chidi")]);
    fireEvent.click(screen.getByLabelText(/Chidi Okafor/i));
    fireEvent.click(screen.getByRole("button", { name: /Link my account/i }));

    await waitFor(() => expect(screen.getByText(/✓ Linked/i)).toBeTruthy());
    // No error surfaced for the success-shaped 409.
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("falls back to the sign-in control when the sign-in has expired", async () => {
    authFetchMock.mockRejectedValue(new AuthExpiredError());

    renderLink([member("Chidi")]);
    fireEvent.click(screen.getByLabelText(/Chidi Okafor/i));
    fireEvent.click(screen.getByRole("button", { name: /Link my account/i }));

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Sign in with musubi/i })).toBeTruthy(),
    );
    expect(screen.getByRole("alert").textContent).toMatch(/sign-in expired/i);
  });

  it("keeps the picker, and says to retry, when the link request cannot be sent", async () => {
    authFetchMock.mockRejectedValue(new TypeError("Failed to fetch"));

    renderLink([member("Chidi")]);
    fireEvent.click(screen.getByLabelText(/Chidi Okafor/i));
    fireEvent.click(screen.getByRole("button", { name: /Link my account/i }));

    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toMatch(/Couldn't link your account/i),
    );
    // Still signed in: the picker stays, and no sign-in is offered.
    expect(screen.getByText(/Which guest are you/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Sign in with musubi/i })).toBeNull();
  });

  it("unlinks a linked member via DELETE", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { linked: false, guestId: "g-Ada" }));

    renderLink([member("Ada")], { signedIn: true, linkedGuestIds: ["g-Ada"] });
    fireEvent.click(screen.getByRole("button", { name: /^Unlink$/i }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        `${API}/api/account/link/g-Ada`,
        expect.objectContaining({ method: "DELETE" }),
      ),
    );
    // The indicator flips back to unlinked.
    await waitFor(() => expect(screen.getByText(/Not linked/i)).toBeTruthy());
    // The DELETE was the only request the component made.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
