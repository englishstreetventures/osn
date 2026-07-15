// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * OrganiserApp's Dashboard owns the glue the child components don't: mapping the
 * weddings-list fetch into load/error/ready states, and the create → auto-open
 * flow. The OSN auth context + the leaf components (WeddingList, the dashboard
 * tabs) are stubbed so this asserts only that glue.
 */

const authFetchMock = vi.fn();
const logoutMock = vi.fn().mockResolvedValue(undefined);
const redirectSpy = vi.fn();

// session() returns a truthy value so RequireAuth renders its children.
vi.mock("@osn/client/solid", () => ({
  AuthProvider: (props: { children: unknown }) => props.children,
  useAuth: () => ({
    authFetch: authFetchMock,
    logout: logoutMock,
    session: () => ({ sub: "usr_owner" }),
  }),
}));

vi.mock("solid-toast", () => ({ Toaster: () => null }));

vi.mock("../lib/api", () => ({
  apiUrl: (path: string) => `https://api.test${path}`,
  isAuthExpired: (err: unknown) => String(err).includes("AuthExpiredError"),
  redirectToLogin: () => redirectSpy(),
}));

// Leaf views stubbed to data-testids; WeddingList exposes select + create
// triggers so we can drive the parent's state transitions.
vi.mock("./WeddingList", () => ({
  default: (props: {
    weddings: { id: string; displayName: string }[];
    onSelect: (w: unknown) => void;
    onCreated: (w: unknown) => void;
  }) => (
    <div data-testid="wedding-list">
      <span data-testid="count">{props.weddings.length}</span>
      <button onClick={() => props.onSelect(props.weddings[0])}>select-first</button>
      <button
        onClick={() =>
          props.onCreated({
            id: "wed_new",
            slug: "new-x",
            displayName: "Fresh Wedding",
            role: "owner",
          })
        }
      >
        create
      </button>
    </div>
  ),
}));

// The tab bar is controlled now: it gets the active `tab` + an `onTab` callback.
// Surface both so the suite can assert the hash-driven tab and exercise a tab
// switch (which the parent mirrors into the URL hash).
vi.mock("./DashboardTabs", () => ({
  default: (props: {
    weddingId: string;
    canManage: boolean;
    canEdit: boolean;
    tab: string;
    onTab: (t: string) => void;
  }) => (
    <div
      data-testid="dashboard-tabs"
      data-can-manage={String(props.canManage)}
      data-can-edit={String(props.canEdit)}
      data-tab={props.tab}
    >
      {props.weddingId}
      <button onClick={() => props.onTab("guests")}>go-guests</button>
    </div>
  ),
}));
vi.mock("./ImportPanel", () => ({
  default: (props: { weddingId: string }) => (
    <div data-testid="import-panel">{props.weddingId}</div>
  ),
}));
// GettingStarted fetches its own events/guests/invite snapshot — stub it so this
// suite stays on the Dashboard's view glue rather than the checklist's fetches.
vi.mock("./GettingStarted", () => ({
  default: (props: { weddingId: string }) => (
    <div data-testid="getting-started">{props.weddingId}</div>
  ),
}));
vi.mock("./PreviewInviteButton", () => ({
  default: () => <div data-testid="preview-button" />,
}));
// SecurityPanel pulls in @osn/client + @osn/ui + @simplewebauthn/browser;
// stub it so this suite stays focused on the Dashboard's view glue.
vi.mock("./SecurityPanel", () => ({
  default: () => <div data-testid="security-panel">passkeys</div>,
}));

import OrganiserApp from "./OrganiserApp";

function listResponse(
  weddings: {
    id: string;
    slug: string;
    displayName: string;
    role?: "owner" | "editor" | "viewer";
  }[],
) {
  return new Response(
    JSON.stringify({ weddings: weddings.map((w) => ({ role: "owner", ...w })) }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" },
    },
  );
}

describe("OrganiserApp Dashboard", () => {
  afterEach(() => {
    cleanup();
    authFetchMock.mockReset();
    redirectSpy.mockReset();
    // The dashboard mirrors its state into the URL hash — reset it so one test's
    // deep link doesn't seed the next.
    history.replaceState(null, "", window.location.pathname + window.location.search);
  });

  it("renders the wedding list once the fetch resolves", async () => {
    authFetchMock.mockResolvedValue(
      listResponse([{ id: "wed_a", slug: "a", displayName: "Alice & Bob" }]),
    );
    render(() => <OrganiserApp />);
    await waitFor(() => expect(screen.getByTestId("wedding-list")).toBeTruthy());
    expect(screen.getByTestId("count").textContent).toBe("1");
  });

  it("shows an error banner when the list fetch fails", async () => {
    authFetchMock.mockResolvedValue(new Response(null, { status: 500 }));
    render(() => <OrganiserApp />);
    await waitFor(() => expect(screen.getByText(/Could not load weddings/i)).toBeTruthy());
    expect(screen.queryByTestId("wedding-list")).toBeNull();
  });

  it("opens the dashboard for a selected wedding", async () => {
    authFetchMock.mockResolvedValue(
      listResponse([{ id: "wed_a", slug: "a", displayName: "Alice & Bob" }]),
    );
    render(() => <OrganiserApp />);
    await waitFor(() => expect(screen.getByTestId("wedding-list")).toBeTruthy());

    fireEvent.click(screen.getByText("select-first"));
    expect(screen.getByTestId("dashboard-tabs").textContent).toContain("wed_a");
    // Owner ⇒ management enabled + the import panel rendered.
    expect(screen.getByTestId("dashboard-tabs").getAttribute("data-can-manage")).toBe("true");
    expect(screen.getByTestId("import-panel").textContent).toBe("wed_a");
  });

  it("disables owner-only management but still surfaces import for an editor co-host", async () => {
    authFetchMock.mockResolvedValue(
      listResponse([{ id: "wed_c", slug: "c", displayName: "Co-hosted", role: "editor" }]),
    );
    render(() => <OrganiserApp />);
    await waitFor(() => expect(screen.getByTestId("wedding-list")).toBeTruthy());

    fireEvent.click(screen.getByText("select-first"));
    expect(screen.getByTestId("dashboard-tabs").textContent).toContain("wed_c");
    // Editor ⇒ owner-only management disabled (threaded into the Hosts/Codes
    // tabs), but the spreadsheet import is available — editors are trusted
    // co-organisers (gated server-side by weddingEditor).
    expect(screen.getByTestId("dashboard-tabs").getAttribute("data-can-manage")).toBe("false");
    expect(screen.getByTestId("dashboard-tabs").getAttribute("data-can-edit")).toBe("true");
    expect(screen.getByTestId("import-panel").textContent).toBe("wed_c");
  });

  it("hides the import panel and disables edit for a viewer co-host", async () => {
    authFetchMock.mockResolvedValue(
      listResponse([{ id: "wed_v", slug: "v", displayName: "Viewed", role: "viewer" }]),
    );
    render(() => <OrganiserApp />);
    await waitFor(() => expect(screen.getByTestId("wedding-list")).toBeTruthy());

    fireEvent.click(screen.getByText("select-first"));
    expect(screen.getByTestId("dashboard-tabs").textContent).toContain("wed_v");
    expect(screen.getByTestId("dashboard-tabs").getAttribute("data-can-manage")).toBe("false");
    expect(screen.getByTestId("dashboard-tabs").getAttribute("data-can-edit")).toBe("false");
    // The import is a pure write surface — a viewer doesn't see it at all.
    expect(screen.queryByTestId("import-panel")).toBeNull();
    // The header badge says Viewer.
    expect(screen.getByText("Viewer")).toBeTruthy();
  });

  it("auto-opens a freshly created wedding's dashboard", async () => {
    authFetchMock.mockResolvedValue(listResponse([]));
    render(() => <OrganiserApp />);
    await waitFor(() => expect(screen.getByTestId("wedding-list")).toBeTruthy());

    fireEvent.click(screen.getByText("create"));
    // The new wedding is selected (its dashboard renders) and the list now
    // carries it.
    expect(screen.getByTestId("dashboard-tabs").textContent).toContain("wed_new");
  });

  it("toggles to the Security (devices / passkeys) panel from the nav", async () => {
    authFetchMock.mockResolvedValue(
      listResponse([{ id: "wed_a", slug: "a", displayName: "Alice & Bob" }]),
    );
    render(() => <OrganiserApp />);
    await waitFor(() => expect(screen.getByTestId("wedding-list")).toBeTruthy());

    // Security is reachable whenever signed in, independent of any wedding.
    fireEvent.click(screen.getByRole("button", { name: /^Security$/ }));
    expect(screen.getByTestId("security-panel")).toBeTruthy();
    expect(screen.queryByTestId("wedding-list")).toBeNull();

    // And back to weddings.
    fireEvent.click(screen.getByRole("button", { name: /^Weddings$/ }));
    expect(screen.getByTestId("wedding-list")).toBeTruthy();
    expect(screen.queryByTestId("security-panel")).toBeNull();
  });

  // ── Deep-linking + refresh persistence (the headline ask) ───────────────────

  it("restores a wedding + tab from the URL hash on load (survives a hard refresh)", async () => {
    // Simulate landing with a deep link / a hard refresh on a wedding tab.
    history.replaceState(null, "", "#/weddings/wed_a/guests");
    authFetchMock.mockResolvedValue(
      listResponse([{ id: "wed_a", slug: "a", displayName: "Alice & Bob" }]),
    );
    render(() => <OrganiserApp />);

    // It opens straight to the wedding's dashboard on the deep-linked tab — no
    // bounce back to the list.
    await waitFor(() => expect(screen.getByTestId("dashboard-tabs")).toBeTruthy());
    expect(screen.queryByTestId("wedding-list")).toBeNull();
    expect(screen.getByTestId("dashboard-tabs").getAttribute("data-tab")).toBe("guests");
  });

  it("falls back to the list for a hash naming a wedding the organiser can't load", async () => {
    // Deep link to a wedding that isn't in the loaded list (not owner/host, or
    // gone) — it must not hang; it drops to the list.
    history.replaceState(null, "", "#/weddings/wed_missing/invite");
    authFetchMock.mockResolvedValue(
      listResponse([{ id: "wed_a", slug: "a", displayName: "Alice & Bob" }]),
    );
    render(() => <OrganiserApp />);

    await waitFor(() => expect(screen.getByTestId("wedding-list")).toBeTruthy());
    expect(screen.queryByTestId("dashboard-tabs")).toBeNull();
    // And the hash was corrected to the canonical list route.
    expect(window.location.hash).toBe("#/weddings");
  });

  it("writes the wedding to the hash when one is opened, and clears it on back", async () => {
    authFetchMock.mockResolvedValue(
      listResponse([{ id: "wed_a", slug: "a", displayName: "Alice & Bob" }]),
    );
    render(() => <OrganiserApp />);
    await waitFor(() => expect(screen.getByTestId("wedding-list")).toBeTruthy());

    fireEvent.click(screen.getByText("select-first"));
    expect(window.location.hash).toBe("#/weddings/wed_a");

    // Switching tabs reflects in the hash (shareable / refresh-safe).
    fireEvent.click(screen.getByText("go-guests"));
    expect(window.location.hash).toBe("#/weddings/wed_a/guests");
    expect(screen.getByTestId("dashboard-tabs").getAttribute("data-tab")).toBe("guests");

    // Back to all weddings clears the wedding from the hash.
    fireEvent.click(screen.getByRole("button", { name: /All weddings/i }));
    expect(screen.getByTestId("wedding-list")).toBeTruthy();
    expect(window.location.hash).toBe("#/weddings");
  });

  it("re-syncs on a browser Back/Forward style hashchange", async () => {
    authFetchMock.mockResolvedValue(
      listResponse([{ id: "wed_a", slug: "a", displayName: "Alice & Bob" }]),
    );
    render(() => <OrganiserApp />);
    await waitFor(() => expect(screen.getByTestId("wedding-list")).toBeTruthy());

    // Simulate the browser navigating the hash (Back/Forward, or a manual edit).
    window.location.hash = "#/weddings/wed_a/invite";
    window.dispatchEvent(new HashChangeEvent("hashchange"));

    await waitFor(() => expect(screen.getByTestId("dashboard-tabs")).toBeTruthy());
    expect(screen.getByTestId("dashboard-tabs").getAttribute("data-tab")).toBe("invite");
  });
});
