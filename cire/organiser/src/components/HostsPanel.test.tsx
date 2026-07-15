// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * HostsPanel lists a wedding's co-hosts and (for owners) adds one by OSN handle
 * or removes one. The OSN auth + api helpers + toasts are stubbed; this asserts
 * the wiring — the requests it sends, the optimistic list updates, the
 * owner-vs-co-host affordances, and the add error branches (404 / 409 / 503).
 */

const authFetchMock = vi.fn();
const redirectSpy = vi.fn();
const toastSuccess = vi.fn();
const toastError = vi.fn();

vi.mock("@osn/client/solid", () => ({
  useAuth: () => ({ authFetch: authFetchMock }),
}));

vi.mock("solid-toast", () => ({
  toast: { success: (m: string) => toastSuccess(m), error: (m: string) => toastError(m) },
}));

vi.mock("../lib/api", () => ({
  apiUrl: (path: string) => `https://api.test${path}`,
  isAuthExpired: (err: unknown) => String(err).includes("AuthExpiredError"),
  redirectToLogin: () => redirectSpy(),
}));

import HostsPanel from "./HostsPanel";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function typeHandle(value: string) {
  // The add-host input is a combobox (role="combobox") now it has autocomplete.
  fireEvent.input(screen.getByRole("combobox"), { target: { value } });
}

describe("HostsPanel", () => {
  afterEach(() => {
    cleanup();
    authFetchMock.mockReset();
    redirectSpy.mockReset();
    toastSuccess.mockReset();
    toastError.mockReset();
  });

  it("loads and lists existing hosts", async () => {
    authFetchMock.mockResolvedValueOnce(
      json({ hosts: [{ osnProfileId: "usr_bob", role: "host", createdAt: 1 }] }),
    );
    render(() => <HostsPanel weddingId="wed_a" canManage />);
    await waitFor(() => expect(screen.getByText("usr_bob")).toBeTruthy());
    // The GET request hit the hosts endpoint.
    expect(String(authFetchMock.mock.calls[0]![0])).toBe(
      "https://api.test/api/organiser/weddings/wed_a/hosts",
    );
  });

  it("adds a host by handle and appends it to the list", async () => {
    authFetchMock.mockResolvedValueOnce(json({ hosts: [] })); // initial load
    authFetchMock.mockResolvedValueOnce(
      json({ host: { osnProfileId: "usr_bob", handle: "bob", role: "host", createdAt: 2 } }, 201),
    );
    render(() => <HostsPanel weddingId="wed_a" canManage />);
    await waitFor(() => expect(screen.getByText(/No co-hosts yet/i)).toBeTruthy());

    typeHandle("@bob");
    fireEvent.click(screen.getByRole("button", { name: /Add host/i }));

    await waitFor(() => expect(screen.getByText("@bob")).toBeTruthy());
    const [url, init] = authFetchMock.mock.calls[1]!;
    expect(String(url)).toBe("https://api.test/api/organiser/weddings/wed_a/hosts");
    expect((init as RequestInit).method).toBe("POST");
    // Role defaults to editor unless the owner picks viewer in the form.
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({
      handle: "@bob",
      role: "editor",
    });
    expect(toastSuccess).toHaveBeenCalled();
  });

  it("sends role viewer when the owner picks the viewer option", async () => {
    authFetchMock.mockResolvedValueOnce(json({ hosts: [] })); // initial load
    authFetchMock.mockResolvedValueOnce(
      json({ host: { osnProfileId: "usr_bob", handle: "bob", role: "viewer", createdAt: 2 } }, 201),
    );
    render(() => <HostsPanel weddingId="wed_a" canManage />);
    await waitFor(() => expect(screen.getByText(/No co-hosts yet/i)).toBeTruthy());

    typeHandle("@bob");
    fireEvent.click(screen.getByRole("radio", { name: /Viewer/i }));
    fireEvent.click(screen.getByRole("button", { name: /Add host/i }));

    await waitFor(() => expect(screen.getByText("@bob")).toBeTruthy());
    const [, init] = authFetchMock.mock.calls[1]!;
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({
      handle: "@bob",
      role: "viewer",
    });
    // The freshly-added row carries a Viewer badge (scoped to the list — the
    // add form's radio label also says "Viewer").
    expect(within(screen.getByRole("listitem")).getByText("Viewer")).toBeTruthy();
  });

  it("changes a host's role via the Make viewer control (PUT …/role)", async () => {
    authFetchMock.mockResolvedValueOnce(
      json({ hosts: [{ osnProfileId: "usr_bob", handle: "bob", role: "editor", createdAt: 1 }] }),
    );
    authFetchMock.mockResolvedValueOnce(
      json({ host: { osnProfileId: "usr_bob", role: "viewer", createdAt: 1 } }),
    );
    render(() => <HostsPanel weddingId="wed_a" canManage />);
    await waitFor(() => expect(screen.getByText("@bob")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: /Make @bob a viewer/i }));

    await waitFor(() =>
      expect(within(screen.getByRole("listitem")).getByText("Viewer")).toBeTruthy(),
    );
    const [url, init] = authFetchMock.mock.calls[1]!;
    expect(String(url)).toBe("https://api.test/api/organiser/weddings/wed_a/hosts/usr_bob/role");
    expect((init as RequestInit).method).toBe("PUT");
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ role: "viewer" });
    expect(toastSuccess).toHaveBeenCalled();
    // The control now offers the reverse flip.
    expect(screen.getByRole("button", { name: /Make @bob an editor/i })).toBeTruthy();
  });

  it("hides the role + remove controls from a non-owner", async () => {
    authFetchMock.mockResolvedValueOnce(
      json({ hosts: [{ osnProfileId: "usr_bob", handle: "bob", role: "editor", createdAt: 1 }] }),
    );
    render(() => <HostsPanel weddingId="wed_a" canManage={false} />);
    await waitFor(() => expect(screen.getByText("@bob")).toBeTruthy());
    expect(screen.queryByRole("button", { name: /Make @bob/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /Remove/i })).toBeNull();
    // The role badge still shows.
    expect(screen.getByText("Editor", { selector: "span" })).toBeTruthy();
  });

  it("shows a not-found message when the handle resolves to nobody (404)", async () => {
    authFetchMock.mockResolvedValueOnce(json({ hosts: [] }));
    authFetchMock.mockResolvedValueOnce(json({ error: "No OSN account with that handle" }, 404));
    render(() => <HostsPanel weddingId="wed_a" canManage />);
    await waitFor(() => expect(screen.getByText(/No co-hosts yet/i)).toBeTruthy());

    typeHandle("ghost");
    fireEvent.click(screen.getByRole("button", { name: /Add host/i }));
    await waitFor(() => expect(screen.getByText(/No OSN account found for @ghost/i)).toBeTruthy());
  });

  it("shows an already-a-host message on 409", async () => {
    authFetchMock.mockResolvedValueOnce(json({ hosts: [] }));
    authFetchMock.mockResolvedValueOnce(json({ error: "already_host" }, 409));
    render(() => <HostsPanel weddingId="wed_a" canManage />);
    await waitFor(() => expect(screen.getByText(/No co-hosts yet/i)).toBeTruthy());

    typeHandle("bob");
    fireEvent.click(screen.getByRole("button", { name: /Add host/i }));
    await waitFor(() => expect(screen.getByText(/already a host/i)).toBeTruthy());
  });

  it("explains when adding hosts is unavailable (503)", async () => {
    authFetchMock.mockResolvedValueOnce(json({ hosts: [] }));
    authFetchMock.mockResolvedValueOnce(json({ error: "Adding hosts is not available" }, 503));
    render(() => <HostsPanel weddingId="wed_a" canManage />);
    await waitFor(() => expect(screen.getByText(/No co-hosts yet/i)).toBeTruthy());

    typeHandle("bob");
    fireEvent.click(screen.getByRole("button", { name: /Add host/i }));
    await waitFor(() =>
      expect(screen.getByText(/isn't available on this deployment/i)).toBeTruthy(),
    );
  });

  it("does not call the API when the handle is blank", async () => {
    authFetchMock.mockResolvedValueOnce(json({ hosts: [] }));
    render(() => <HostsPanel weddingId="wed_a" canManage />);
    await waitFor(() => expect(screen.getByText(/No co-hosts yet/i)).toBeTruthy());

    typeHandle("   ");
    fireEvent.click(screen.getByRole("button", { name: /Add host/i }));
    await waitFor(() => expect(screen.getByText(/Enter an OSN handle/i)).toBeTruthy());
    // Only the initial load happened.
    expect(authFetchMock).toHaveBeenCalledTimes(1);
  });

  it("removes a host on click", async () => {
    authFetchMock.mockResolvedValueOnce(
      json({ hosts: [{ osnProfileId: "usr_bob", role: "host", createdAt: 1 }] }),
    );
    authFetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ removed: true }), { status: 200 }),
    );
    render(() => <HostsPanel weddingId="wed_a" canManage />);
    await waitFor(() => expect(screen.getByText("usr_bob")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: /Remove/i }));
    await waitFor(() => expect(screen.queryByText("usr_bob")).toBeNull());
    const [url, init] = authFetchMock.mock.calls[1]!;
    expect(String(url)).toBe("https://api.test/api/organiser/weddings/wed_a/hosts/usr_bob");
    expect((init as RequestInit).method).toBe("DELETE");
  });

  it("hides the add form and remove controls for a co-host (read-only)", async () => {
    authFetchMock.mockResolvedValueOnce(
      json({ hosts: [{ osnProfileId: "usr_bob", role: "host", createdAt: 1 }] }),
    );
    render(() => <HostsPanel weddingId="wed_a" canManage={false} />);
    await waitFor(() => expect(screen.getByText("usr_bob")).toBeTruthy());
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("button", { name: /Add host/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /Remove/i })).toBeNull();
  });

  it("redirects to login on a 401 during load", async () => {
    authFetchMock.mockResolvedValueOnce(new Response(null, { status: 401 }));
    render(() => <HostsPanel weddingId="wed_a" canManage />);
    await waitFor(() => expect(redirectSpy).toHaveBeenCalledTimes(1));
  });

  // --- Handle autocomplete ---------------------------------------------------

  /** Convenience: the search response shape returned by /handle-search. */
  function searchJson(
    profiles: { profileId: string; handle: string; displayName: string | null }[],
  ) {
    return json({ profiles });
  }

  it("debounces the search and fetches suggestions for a 2+ char prefix", async () => {
    authFetchMock.mockResolvedValueOnce(json({ hosts: [] })); // initial load
    authFetchMock.mockResolvedValueOnce(
      searchJson([
        { profileId: "usr_alice", handle: "alice", displayName: "Alice" },
        { profileId: "usr_alina", handle: "alina", displayName: null },
      ]),
    );
    render(() => <HostsPanel weddingId="wed_a" canManage />);
    await waitFor(() => expect(screen.getByText(/No co-hosts yet/i)).toBeTruthy());

    typeHandle("al");
    // Suggestions appear after the debounce + fetch resolves.
    await waitFor(() => expect(screen.getByRole("listbox")).toBeTruthy());
    expect(screen.getByText("@alice")).toBeTruthy();
    expect(screen.getByText("@alina")).toBeTruthy();
    expect(screen.getByText("Alice")).toBeTruthy(); // displayName rendered

    // The second call is the debounced search hitting the handle-search endpoint.
    const [url] = authFetchMock.mock.calls[1]!;
    expect(String(url)).toBe("https://api.test/api/organiser/handle-search?q=al");
    // Exactly one search fetch despite a single multi-char input (debounced).
    expect(authFetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not search for a sub-2-char prefix", async () => {
    authFetchMock.mockResolvedValueOnce(json({ hosts: [] }));
    render(() => <HostsPanel weddingId="wed_a" canManage />);
    await waitFor(() => expect(screen.getByText(/No co-hosts yet/i)).toBeTruthy());

    typeHandle("a");
    // Give the debounce window time to fire (it shouldn't, the prefix is too short).
    await new Promise((r) => setTimeout(r, 350));
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(authFetchMock).toHaveBeenCalledTimes(1); // only the initial load
  });

  it("fills the input when a suggestion is selected", async () => {
    authFetchMock.mockResolvedValueOnce(json({ hosts: [] }));
    authFetchMock.mockResolvedValueOnce(
      searchJson([{ profileId: "usr_alice", handle: "alice", displayName: "Alice" }]),
    );
    render(() => <HostsPanel weddingId="wed_a" canManage />);
    await waitFor(() => expect(screen.getByText(/No co-hosts yet/i)).toBeTruthy());

    typeHandle("al");
    await waitFor(() => expect(screen.getByRole("option")).toBeTruthy());

    fireEvent.mouseDown(screen.getByRole("option", { name: /@alice/i }));
    // The input now holds the chosen handle and the list is gone.
    await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
    expect((screen.getByRole("combobox") as HTMLInputElement).value).toBe("@alice");
  });

  it("fails soft (no listbox) when the search endpoint errors", async () => {
    authFetchMock.mockResolvedValueOnce(json({ hosts: [] }));
    authFetchMock.mockResolvedValueOnce(json({ error: "nope" }, 500));
    render(() => <HostsPanel weddingId="wed_a" canManage />);
    await waitFor(() => expect(screen.getByText(/No co-hosts yet/i)).toBeTruthy());

    typeHandle("al");
    await waitFor(() => expect(authFetchMock).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("still allows manual type-and-submit without picking a suggestion", async () => {
    // The user types and submits immediately, before the search debounce fires.
    // The add POST is therefore call #2; a default mock absorbs the trailing
    // debounced search so it can't reject unmatched.
    authFetchMock.mockImplementation(() => Promise.resolve(searchJson([])));
    authFetchMock.mockResolvedValueOnce(json({ hosts: [] })); // load
    authFetchMock.mockResolvedValueOnce(
      json({ host: { osnProfileId: "usr_bob", handle: "bob", role: "host", createdAt: 2 } }, 201),
    );
    render(() => <HostsPanel weddingId="wed_a" canManage />);
    await waitFor(() => expect(screen.getByText(/No co-hosts yet/i)).toBeTruthy());

    typeHandle("bob");
    fireEvent.click(screen.getByRole("button", { name: /Add host/i }));
    await waitFor(() => expect(screen.getByText("@bob")).toBeTruthy());
    // The add request used the hosts POST endpoint, not the search endpoint.
    const postCall = authFetchMock.mock.calls.find(
      (c) => (c[1] as RequestInit | undefined)?.method === "POST",
    );
    expect(String(postCall?.[0])).toBe("https://api.test/api/organiser/weddings/wed_a/hosts");
  });
});
