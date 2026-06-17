// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
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
  fireEvent.input(screen.getByRole("textbox"), { target: { value } });
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
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ handle: "@bob" });
    expect(toastSuccess).toHaveBeenCalled();
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
});
