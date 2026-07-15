// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * OrganiserApp's Dashboard owns the glue the child components don't: mapping the
 * weddings-list fetch into load/error/ready states, the create → auto-open flow,
 * and the module IA hash routing (`#/w/:id/:module/:sub`, with the pre-IA
 * `#/weddings/:id/:tab` bookmarks aliased forward for one release). The OSN auth
 * context + the leaf components (WeddingList, the module shell) are stubbed so
 * this asserts only that glue.
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

// The module shell is controlled now: it gets the active `module` + `sub` and an
// `onModule` / `onSub` callback pair. Surface all four so the suite can assert
// the hash-driven module/sub and exercise a module switch (which the parent
// mirrors into the URL hash). It also owns the import + Overview internally now,
// so those aren't separately mounted at the dashboard level.
vi.mock("./ModuleShell", () => ({
  default: (props: {
    weddingId: string;
    canManage: boolean;
    canEdit: boolean;
    module: string;
    sub: string;
    onModule: (m: string) => void;
    onSub: (s: string) => void;
  }) => (
    <div
      data-testid="module-shell"
      data-can-manage={String(props.canManage)}
      data-can-edit={String(props.canEdit)}
      data-module={props.module}
      data-sub={props.sub}
    >
      {props.weddingId}
      <button onClick={() => props.onModule("guests")}>go-guests</button>
      <button onClick={() => props.onSub("rsvps")}>go-rsvps</button>
    </div>
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
    expect(screen.getByTestId("module-shell").textContent).toContain("wed_a");
    // Owner ⇒ management enabled (the shell gates the owner-only sub-views).
    expect(screen.getByTestId("module-shell").getAttribute("data-can-manage")).toBe("true");
    // Lands on the Overview module by default.
    expect(screen.getByTestId("module-shell").getAttribute("data-module")).toBe("overview");
  });

  it("passes editor edit rights (no owner management) through to the module shell", async () => {
    authFetchMock.mockResolvedValue(
      listResponse([{ id: "wed_c", slug: "c", displayName: "Co-hosted", role: "editor" }]),
    );
    render(() => <OrganiserApp />);
    await waitFor(() => expect(screen.getByTestId("wedding-list")).toBeTruthy());

    fireEvent.click(screen.getByText("select-first"));
    expect(screen.getByTestId("module-shell").textContent).toContain("wed_c");
    // Editor ⇒ owner-only management disabled but write surfaces enabled — the
    // shell decides which sub-views to expose (import, invite design), gated
    // server-side by weddingEditor.
    expect(screen.getByTestId("module-shell").getAttribute("data-can-manage")).toBe("false");
    expect(screen.getByTestId("module-shell").getAttribute("data-can-edit")).toBe("true");
  });

  it("passes viewer read-only rights through to the module shell", async () => {
    authFetchMock.mockResolvedValue(
      listResponse([{ id: "wed_v", slug: "v", displayName: "Viewed", role: "viewer" }]),
    );
    render(() => <OrganiserApp />);
    await waitFor(() => expect(screen.getByTestId("wedding-list")).toBeTruthy());

    fireEvent.click(screen.getByText("select-first"));
    expect(screen.getByTestId("module-shell").textContent).toContain("wed_v");
    expect(screen.getByTestId("module-shell").getAttribute("data-can-manage")).toBe("false");
    expect(screen.getByTestId("module-shell").getAttribute("data-can-edit")).toBe("false");
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
    expect(screen.getByTestId("module-shell").textContent).toContain("wed_new");
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

  it("restores a wedding + module/sub from the URL hash on load (survives a hard refresh)", async () => {
    // Simulate landing with a canonical IA deep link / a hard refresh.
    history.replaceState(null, "", "#/w/wed_a/guests/rsvps");
    authFetchMock.mockResolvedValue(
      listResponse([{ id: "wed_a", slug: "a", displayName: "Alice & Bob" }]),
    );
    render(() => <OrganiserApp />);

    // It opens straight to the wedding's dashboard on the deep-linked module/sub
    // — no bounce back to the list.
    await waitFor(() => expect(screen.getByTestId("module-shell")).toBeTruthy());
    expect(screen.queryByTestId("wedding-list")).toBeNull();
    expect(screen.getByTestId("module-shell").getAttribute("data-module")).toBe("guests");
    expect(screen.getByTestId("module-shell").getAttribute("data-sub")).toBe("rsvps");
  });

  it("aliases a pre-IA bookmark (#/weddings/:id/:tab) forward to the new module route", async () => {
    // A bookmark from before the IA shell — the legacy `rsvps` tab aliases to the
    // guests module's rsvps sub, and the hash migrates to the canonical `#/w/…`.
    history.replaceState(null, "", "#/weddings/wed_a/rsvps");
    authFetchMock.mockResolvedValue(
      listResponse([{ id: "wed_a", slug: "a", displayName: "Alice & Bob" }]),
    );
    render(() => <OrganiserApp />);

    await waitFor(() => expect(screen.getByTestId("module-shell")).toBeTruthy());
    expect(screen.getByTestId("module-shell").getAttribute("data-module")).toBe("guests");
    expect(screen.getByTestId("module-shell").getAttribute("data-sub")).toBe("rsvps");
    // The old bookmark was rewritten to the canonical IA form on mount.
    expect(window.location.hash).toBe("#/w/wed_a/guests/rsvps");
  });

  it("falls back to the list for a hash naming a wedding the organiser can't load", async () => {
    // Deep link to a wedding that isn't in the loaded list (not owner/host, or
    // gone) — it must not hang; it drops to the list.
    history.replaceState(null, "", "#/w/wed_missing/invite");
    authFetchMock.mockResolvedValue(
      listResponse([{ id: "wed_a", slug: "a", displayName: "Alice & Bob" }]),
    );
    render(() => <OrganiserApp />);

    await waitFor(() => expect(screen.getByTestId("wedding-list")).toBeTruthy());
    expect(screen.queryByTestId("module-shell")).toBeNull();
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
    // Opens on the default (overview) module — left implicit in the canonical URL.
    expect(window.location.hash).toBe("#/w/wed_a");

    // Switching module reflects in the hash (shareable / refresh-safe).
    fireEvent.click(screen.getByText("go-guests"));
    expect(window.location.hash).toBe("#/w/wed_a/guests");
    expect(screen.getByTestId("module-shell").getAttribute("data-module")).toBe("guests");

    // Switching sub within the module appends it to the hash.
    fireEvent.click(screen.getByText("go-rsvps"));
    expect(window.location.hash).toBe("#/w/wed_a/guests/rsvps");
    expect(screen.getByTestId("module-shell").getAttribute("data-sub")).toBe("rsvps");

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
    window.location.hash = "#/w/wed_a/invite";
    window.dispatchEvent(new HashChangeEvent("hashchange"));

    await waitFor(() => expect(screen.getByTestId("module-shell")).toBeTruthy());
    expect(screen.getByTestId("module-shell").getAttribute("data-module")).toBe("invite");
  });
});
