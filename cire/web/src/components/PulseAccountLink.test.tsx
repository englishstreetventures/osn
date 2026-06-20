// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { FamilyMember } from "./types";

/**
 * PulseAccountLink owns the guest "Link my Pulse account" flow. The OSN sign-in
 * ceremony itself is covered in @osn/ui; here we stub @osn/client + @osn/ui and
 * assert the wiring this component introduces:
 *   - the affordance only appears when the household's link state probes "ready"
 *     (503 ⇒ disabled ⇒ hidden; the core invite is never affected)
 *   - signed-out ⇒ a "Sign in with OSN" control gates the picker
 *   - signed-in ⇒ pick a member → POST /api/account/link with { guestId }
 *   - the GET probe seeds the linked/unlinked indicators
 *   - unlink issues DELETE /api/account/link/:guestId
 *   - 409 already-linked is treated as linked, not an error
 */

// A controllable session signal + authFetch spy, swapped per test via the
// module-level holders below (vi.mock factories can't close over per-test state
// directly, so they read through these mutable refs).
const sessionRef = { current: null as unknown };
const authFetchMock = vi.fn();

vi.mock("@osn/client", () => ({
  createLoginClient: () => ({}),
  createRecoveryClient: () => ({}),
  createRegistrationClient: () => ({}),
}));

vi.mock("@osn/client/solid", () => ({
  AuthProvider: (props: { children: unknown }) => props.children,
  useAuth: () => ({
    session: () => sessionRef.current,
    authFetch: authFetchMock,
  }),
}));

vi.mock("@osn/ui/auth", () => ({
  SignIn: () => <div data-testid="osn-signin">sign in ceremony</div>,
  Register: () => <div data-testid="osn-register">register ceremony</div>,
}));

vi.mock("solid-toast", () => ({
  Toaster: () => null,
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { PulseAccountLink } from "./PulseAccountLink";

const API = "http://api.test";

function member(firstName: string, id = `g-${firstName}`): FamilyMember {
  return { guestId: id, firstName, lastName: "Okafor", nickname: null, eventIds: [] };
}

function renderLink(members: FamilyMember[]) {
  return render(() => (
    <PulseAccountLink apiUrl={API} members={members} issuerUrl="http://osn.test" />
  ));
}

/** Build a minimal Response-like object for the global fetch mock. */
function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

const realFetch = globalThis.fetch;

beforeEach(() => {
  sessionRef.current = null;
  authFetchMock.mockReset();
});

afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
});

describe("PulseAccountLink", () => {
  it("hides the feature entirely when linking is disabled (probe 503)", async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse(503, { error: "disabled" })) as typeof fetch;
    const { container } = renderLink([member("Chidi")]);
    // Give the probe resource a tick to resolve.
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());
    await Promise.resolve();
    expect(container.querySelector("#pulse-link-heading")).toBeNull();
    expect(screen.queryByText(/Link your Pulse account/i)).toBeNull();
  });

  it("shows the sign-in affordance post-probe when signed out", async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse(200, { links: [] })) as typeof fetch;
    renderLink([member("Chidi")]);
    await waitFor(() => expect(screen.getByText(/Link your Pulse account/i)).toBeTruthy());
    // Signed out → the OSN sign-in control gates the picker.
    const button = screen.getByRole("button", { name: /Sign in with OSN/i });
    expect(button).toBeTruthy();
    fireEvent.click(button);
    await waitFor(() => expect(screen.getByTestId("osn-signin")).toBeTruthy());
  });

  it("links the picked member via POST when signed in", async () => {
    sessionRef.current = { accessToken: "tok", expiresAt: Date.now() + 60_000 };
    globalThis.fetch = vi.fn(async () => jsonResponse(200, { links: [] })) as typeof fetch;
    // POST link → 201 created.
    authFetchMock.mockResolvedValue(jsonResponse(201, { linked: true, guestId: "g-Chidi" }));

    renderLink([member("Chidi"), member("Ada")]);
    await waitFor(() => expect(screen.getByText(/Which guest are you/i)).toBeTruthy());

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

  it("reflects already-linked members from the GET probe", async () => {
    sessionRef.current = { accessToken: "tok", expiresAt: Date.now() + 60_000 };
    globalThis.fetch = vi.fn(async () =>
      jsonResponse(200, { links: [{ guestId: "g-Ada", linkedAt: 123 }] }),
    ) as typeof fetch;

    renderLink([member("Chidi"), member("Ada")]);
    await waitFor(() => expect(screen.getByText(/✓ Linked/i)).toBeTruthy());
    // An unlink control is offered for the already-linked seat.
    expect(screen.getByRole("button", { name: /^Unlink$/i })).toBeTruthy();
  });

  it("treats a 409 conflict as linked rather than an error", async () => {
    sessionRef.current = { accessToken: "tok", expiresAt: Date.now() + 60_000 };
    globalThis.fetch = vi.fn(async () => jsonResponse(200, { links: [] })) as typeof fetch;
    authFetchMock.mockResolvedValue(jsonResponse(409, { error: "already_linked" }));

    renderLink([member("Chidi")]);
    await waitFor(() => expect(screen.getByText(/Which guest are you/i)).toBeTruthy());
    fireEvent.click(screen.getByLabelText(/Chidi Okafor/i));
    fireEvent.click(screen.getByRole("button", { name: /Link my account/i }));

    await waitFor(() => expect(screen.getByText(/✓ Linked/i)).toBeTruthy());
    // No error surfaced for the success-shaped 409.
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("unlinks a linked member via DELETE", async () => {
    sessionRef.current = { accessToken: "tok", expiresAt: Date.now() + 60_000 };
    const fetchMock = vi.fn();
    // First call: the GET probe (Ada already linked). Subsequent: the DELETE.
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { links: [{ guestId: "g-Ada", linkedAt: 1 }] }),
    );
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { linked: false, guestId: "g-Ada" }));
    globalThis.fetch = fetchMock as typeof fetch;

    renderLink([member("Ada")]);
    await waitFor(() => expect(screen.getByText(/✓ Linked/i)).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: /^Unlink$/i }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        `${API}/api/account/link/g-Ada`,
        expect.objectContaining({ method: "DELETE" }),
      ),
    );
    // The indicator flips back to unlinked.
    await waitFor(() => expect(screen.getByText(/Not linked/i)).toBeTruthy());
  });
});
