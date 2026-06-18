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

vi.mock("./DashboardTabs", () => ({
  default: (props: { weddingId: string; canManage: boolean }) => (
    <div data-testid="dashboard-tabs" data-can-manage={String(props.canManage)}>
      {props.weddingId}
    </div>
  ),
}));
vi.mock("./ImportPanel", () => ({
  default: (props: { weddingId: string }) => (
    <div data-testid="import-panel">{props.weddingId}</div>
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
  weddings: { id: string; slug: string; displayName: string; role?: "owner" | "host" }[],
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
    expect(screen.getByTestId("dashboard-tabs").textContent).toBe("wed_a");
    // Owner ⇒ management enabled + the owner-only import panel rendered.
    expect(screen.getByTestId("dashboard-tabs").getAttribute("data-can-manage")).toBe("true");
    expect(screen.getByTestId("import-panel").textContent).toBe("wed_a");
  });

  it("hides owner-only surfaces and disables management when only co-hosting", async () => {
    authFetchMock.mockResolvedValue(
      listResponse([{ id: "wed_c", slug: "c", displayName: "Co-hosted", role: "host" }]),
    );
    render(() => <OrganiserApp />);
    await waitFor(() => expect(screen.getByTestId("wedding-list")).toBeTruthy());

    fireEvent.click(screen.getByText("select-first"));
    expect(screen.getByTestId("dashboard-tabs").textContent).toBe("wed_c");
    // Co-host ⇒ management disabled (threaded into the Hosts tab) + no import panel.
    expect(screen.getByTestId("dashboard-tabs").getAttribute("data-can-manage")).toBe("false");
    expect(screen.queryByTestId("import-panel")).toBeNull();
  });

  it("auto-opens a freshly created wedding's dashboard", async () => {
    authFetchMock.mockResolvedValue(listResponse([]));
    render(() => <OrganiserApp />);
    await waitFor(() => expect(screen.getByTestId("wedding-list")).toBeTruthy());

    fireEvent.click(screen.getByText("create"));
    // The new wedding is selected (its dashboard renders) and the list now
    // carries it.
    expect(screen.getByTestId("dashboard-tabs").textContent).toBe("wed_new");
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
});
