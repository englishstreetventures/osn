// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

// session() returns a truthy value so RequireAuth renders its children; the
// identity fields feed the ProfileMenu (real, not stubbed) in the masthead.
//
// `AuthContext` is a real context and `useAuth` reads it before falling back
// to the base value, because the Dashboard provides a context of its own — the
// same `authFetch`, wrapped to notice a 403 — and everything below it must see
// that one, as it does in the app.
vi.mock("@shared/rp-auth/solid", async () => {
  const { createContext, useContext } = await import("solid-js");
  const base = {
    authFetch: (...args: unknown[]) => authFetchMock(...args),
    logout: (...args: unknown[]) => logoutMock(...args),
    session: () => ({
      osnProfileId: "usr_owner",
      displayName: "Alex Host",
      handle: "alex",
      email: null,
      avatarUrl: null,
      expiresAt: "2099-01-01T00:00:00Z",
    }),
  };
  const AuthContext = createContext<typeof base>();
  return {
    AuthContext,
    AuthProvider: (props: { children: unknown }) => props.children,
    useAuth: () => useContext(AuthContext) ?? base,
  };
});

vi.mock("@shared/toast", () => ({ Toaster: () => null }));

vi.mock("../../src/lib/api", async () => {
  const { organiserApiMock } = await import("../test-support/mocks");
  return organiserApiMock();
});

// Leaf views stubbed to data-testids; WeddingList exposes select + create
// triggers so we can drive the parent's state transitions.
vi.mock("../../src/components/WeddingList", () => ({
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
            entitlements: [],
            guestCap: 100,
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
//
// It also stands in for every view below it in two ways: `read-vendors` sends
// a wedding-scoped request through the `authFetch` the shell sees (resolved in
// the component body, where the context is visible), and each mount stamps a
// fresh `data-mount` so a test can tell a remount from a re-render.
let shellMounts = 0;
vi.mock("../../src/components/ModuleShell", async () => {
  const { useAuth } = await import("@shared/rp-auth/solid");
  return {
    default: (props: {
      weddingId: string;
      canManage: boolean;
      canEdit: boolean;
      module: string;
      sub: string;
      onModule: (m: string, sub?: string) => void;
      onSub: (s: string) => void;
      onWeddingUpdated?: (patch: { displayName: string; slug: string }) => void;
    }) => {
      const { authFetch } = useAuth();
      shellMounts += 1;
      const mount = shellMounts;
      return (
        <div
          data-testid="module-shell"
          data-can-manage={String(props.canManage)}
          data-can-edit={String(props.canEdit)}
          data-module={props.module}
          data-sub={props.sub}
          data-mount={String(mount)}
        >
          {props.weddingId}
          <button onClick={() => props.onModule("guests")}>go-guests</button>
          <button onClick={() => props.onSub("rsvps")}>go-rsvps</button>
          <button onClick={() => props.onModule("invite", "codes")}>go-invite-codes</button>
          <button onClick={() => props.onModule("guests", "codes")}>go-guests-codes</button>
          <button
            onClick={() =>
              void authFetch(`https://api.test/api/organiser/weddings/${props.weddingId}/vendors`)
            }
          >
            read-vendors
          </button>
          <button
            onClick={() => props.onWeddingUpdated?.({ displayName: "Renamed", slug: "renamed" })}
          >
            rename
          </button>
        </div>
      );
    },
  };
});
vi.mock("../../src/components/PreviewInviteButton", () => ({
  default: () => <div data-testid="preview-button" />,
}));
// Stub SecurityPanel so this suite stays focused on the Dashboard's view glue.
vi.mock("../../src/components/SecurityPanel", () => ({
  default: () => <div data-testid="security-panel">passkeys</div>,
}));

import OrganiserApp from "../../src/components/OrganiserApp";
// The unsaved-changes guard is real (unmocked) — the veto tests below register
// a guard directly, standing in for any mounted dirty form (the invite builder).
import { registerUnsavedGuard } from "../../src/lib/unsaved-guard";
import {
  __resetVendorsCache,
  peekCachedVendors,
  setCachedVendors,
  type VendorRow,
} from "../../src/lib/vendors-store";
import { __resetWeddingScope } from "../../src/lib/wedding-scope";
import { redirectSpy, resetOrganiserMocks } from "../test-support/mocks";

function listResponse(
  weddings: {
    id: string;
    slug: string;
    displayName: string;
    role?: string;
    entitlements?: string[];
    guestCap?: number;
  }[],
) {
  return new Response(
    JSON.stringify({
      weddings: weddings.map((w) => ({
        role: "owner",
        entitlements: [],
        guestCap: 100,
        ...w,
      })),
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" },
    },
  );
}

describe("OrganiserApp Dashboard", () => {
  beforeEach(() => {
    authFetchMock.mockReset();
    __resetWeddingScope();
    __resetVendorsCache();
  });

  afterEach(() => {
    cleanup();
    resetOrganiserMocks();
    vi.unstubAllGlobals();
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

  it("opens a HELPER onto their seat, not onto a dashboard that would 403", async () => {
    // A helper's wedding is listed — that is how they reach the run sheet at
    // all — but every dashboard read is refused for them upstream, so the shell
    // must not mount. Nothing here is about hiding: it is that there is nothing
    // behind those panels for this seat.
    authFetchMock.mockResolvedValue(
      listResponse([{ id: "wed_h", slug: "h", displayName: "Helped", role: "helper" }]),
    );
    render(() => <OrganiserApp />);
    await waitFor(() => expect(screen.getByTestId("wedding-list")).toBeTruthy());

    fireEvent.click(screen.getByText("select-first"));
    expect(screen.queryByTestId("module-shell")).toBeNull();
    expect(screen.getByText(/Helper access/i)).toBeTruthy();
    // The preview button mints a code through a member-gated route, so it is
    // not offered either.
    expect(screen.queryByTestId("preview-button")).toBeNull();
  });

  it("treats a role it has never heard of as the narrowest one, not as an editor", async () => {
    // The check this replaced was `role !== "viewer"`, which is true of any
    // unknown value — so a role the portal did not recognise was handed every
    // write surface. It now falls to the bottom of the rank instead.
    authFetchMock.mockResolvedValue(
      listResponse([{ id: "wed_x", slug: "x", displayName: "Strange", role: "planner" }]),
    );
    render(() => <OrganiserApp />);
    await waitFor(() => expect(screen.getByTestId("wedding-list")).toBeTruthy());

    fireEvent.click(screen.getByText("select-first"));
    expect(screen.queryByTestId("module-shell")).toBeNull();
    expect(screen.getByText(/Helper access/i)).toBeTruthy();
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

  it("opens the Security (devices / passkeys) panel from the profile menu", async () => {
    authFetchMock.mockResolvedValue(
      listResponse([{ id: "wed_a", slug: "a", displayName: "Alice & Bob" }]),
    );
    render(() => <OrganiserApp />);
    await waitFor(() => expect(screen.getByTestId("wedding-list")).toBeTruthy());

    // Security lives under the avatar menu, not the section nav. Kobalte's
    // menu trigger opens on pointerdown and items select on pointerup.
    fireEvent.pointerDown(screen.getByRole("button", { name: /account menu/i }), { button: 0 });
    const item = await screen.findByText(/Security & passkeys/i);
    fireEvent.pointerUp(item, { button: 0 });
    expect(screen.getByTestId("security-panel")).toBeTruthy();
    expect(screen.queryByTestId("wedding-list")).toBeNull();
    // Deep-linkable: the account-security view keeps its hash route.
    expect(window.location.hash).toBe("#/security");

    // The view carries its own way back to the weddings list. Kobalte closes
    // the menu on a queued task (closeOnSelect → setTimeout) and un-hides the
    // outside content then — wait for the back affordance to be queryable.
    const back = await waitFor(() => screen.getByRole("button", { name: /All weddings/i }));
    fireEvent.click(back);
    expect(screen.getByTestId("wedding-list")).toBeTruthy();
    expect(screen.queryByTestId("security-panel")).toBeNull();
  });

  it("restores the security view from a #/security deep link on load", async () => {
    // With the Security nav tab gone, the hash route is the only thing keeping
    // the view alive across a hard refresh — assert the read side too.
    history.replaceState(null, "", "#/security");
    authFetchMock.mockResolvedValue(
      listResponse([{ id: "wed_a", slug: "a", displayName: "Alice & Bob" }]),
    );
    render(() => <OrganiserApp />);

    expect(screen.getByTestId("security-panel")).toBeTruthy();
    expect(screen.queryByTestId("wedding-list")).toBeNull();
  });

  it("signs out from the profile menu", async () => {
    authFetchMock.mockResolvedValue(
      listResponse([{ id: "wed_a", slug: "a", displayName: "Alice & Bob" }]),
    );
    render(() => <OrganiserApp />);
    await waitFor(() => expect(screen.getByTestId("wedding-list")).toBeTruthy());

    fireEvent.pointerDown(screen.getByRole("button", { name: /account menu/i }), { button: 0 });
    const item = await screen.findByText(/Sign out/i);
    fireEvent.pointerUp(item, { button: 0 });

    await waitFor(() => expect(logoutMock).toHaveBeenCalled());
    await waitFor(() => expect(redirectSpy).toHaveBeenCalled());
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

  it("moves to another module's sub in one history entry, never through its default sub", async () => {
    authFetchMock.mockResolvedValue(
      listResponse([{ id: "wed_a", slug: "a", displayName: "Alice & Bob" }]),
    );
    render(() => <OrganiserApp />);
    await waitFor(() => expect(screen.getByTestId("wedding-list")).toBeTruthy());
    fireEvent.click(screen.getByText("select-first"));

    const pushState = vi.spyOn(history, "pushState");
    const replaceState = vi.spyOn(history, "replaceState");
    fireEvent.click(screen.getByText("go-invite-codes"));

    expect(window.location.hash).toBe("#/w/wed_a/invite/codes");
    expect(screen.getByTestId("module-shell").getAttribute("data-module")).toBe("invite");
    expect(screen.getByTestId("module-shell").getAttribute("data-sub")).toBe("codes");
    // One write: a stop at invite/design first would mount the invite builder
    // for nothing and leave a second history write behind it.
    expect(pushState).toHaveBeenCalledTimes(1);
    expect(replaceState).not.toHaveBeenCalled();

    // A sub the module does not have lands on its default sub.
    fireEvent.click(screen.getByText("go-guests-codes"));
    expect(window.location.hash).toBe("#/w/wed_a/guests");
  });

  // ── Unsaved-changes navigation veto (lib/unsaved-guard) ─────────────────────

  it("vetoes navigation while a dirty guard declines, proceeds when accepted", async () => {
    authFetchMock.mockResolvedValue(
      listResponse([{ id: "wed_a", slug: "a", displayName: "Alice & Bob" }]),
    );
    render(() => <OrganiserApp />);
    await waitFor(() => expect(screen.getByTestId("wedding-list")).toBeTruthy());
    fireEvent.click(screen.getByText("select-first"));
    expect(window.location.hash).toBe("#/w/wed_a");

    // A mounted write surface with unsaved edits registers a dirty check
    // (happy-dom ships no window.confirm — stub it, declined).
    const confirmSpy = vi.fn().mockReturnValue(false);
    vi.stubGlobal("confirm", confirmSpy);
    const unregister = registerUnsavedGuard(() => true);
    try {
      // Declined ⇒ the route AND the hash stay untouched.
      fireEvent.click(screen.getByText("go-guests"));
      expect(confirmSpy).toHaveBeenCalledTimes(1);
      expect(window.location.hash).toBe("#/w/wed_a");
      expect(screen.getByTestId("module-shell").getAttribute("data-module")).toBe("overview");

      // Accepted ⇒ navigation proceeds normally.
      confirmSpy.mockReturnValue(true);
      fireEvent.click(screen.getByText("go-guests"));
      expect(window.location.hash).toBe("#/w/wed_a/guests");
      expect(screen.getByTestId("module-shell").getAttribute("data-module")).toBe("guests");

      // Navigating to the SAME route never prompts — the guard is consulted
      // only when the route would actually change (re-clicking the active
      // module must not spam confirms).
      confirmSpy.mockClear();
      confirmSpy.mockReturnValue(false);
      fireEvent.click(screen.getByText("go-guests"));
      expect(confirmSpy).not.toHaveBeenCalled();
      expect(window.location.hash).toBe("#/w/wed_a/guests");
    } finally {
      unregister();
    }
  });

  it("never prompts when the registered guard reports clean", async () => {
    authFetchMock.mockResolvedValue(
      listResponse([{ id: "wed_a", slug: "a", displayName: "Alice & Bob" }]),
    );
    render(() => <OrganiserApp />);
    await waitFor(() => expect(screen.getByTestId("wedding-list")).toBeTruthy());
    fireEvent.click(screen.getByText("select-first"));

    const confirmSpy = vi.fn().mockReturnValue(false);
    vi.stubGlobal("confirm", confirmSpy);
    const unregister = registerUnsavedGuard(() => false);
    try {
      fireEvent.click(screen.getByText("go-guests"));
      expect(window.location.hash).toBe("#/w/wed_a/guests");
      expect(confirmSpy).not.toHaveBeenCalled();
    } finally {
      unregister();
    }
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
  // ── Per-wedding cache lifetime ──────────────────────────────────────────────

  const vendorRow = (weddingId: string): VendorRow => ({
    id: `ven_${weddingId}`,
    weddingId,
    directoryVendorId: null,
    name: "Florist",
    category: "florals",
    status: "researching",
    contactName: "Sam",
    email: "sam@example.com",
    phone: "0400 000 000",
    notes: null,
    quotedMinor: null,
    sortOrder: 0,
    createdAt: 1,
    updatedAt: 1,
  });

  const LIST_URL = "https://api.test/api/organiser/weddings";
  const listCalls = () => authFetchMock.mock.calls.filter(([url]) => url === LIST_URL).length;
  const shell = () => screen.getByTestId("module-shell");

  it("drops the rows of a wedding the organiser leaves, from a deep link onward", async () => {
    history.replaceState(null, "", "#/w/wed_a");
    authFetchMock.mockResolvedValue(
      listResponse([
        { id: "wed_a", slug: "a", displayName: "Alice & Bob" },
        { id: "wed_b", slug: "b", displayName: "Bea & Cal" },
      ]),
    );
    render(() => <OrganiserApp />);
    await waitFor(() => expect(shell().textContent).toContain("wed_a"));
    const firstMount = shell().getAttribute("data-mount");

    setCachedVendors("wed_a", [vendorRow("wed_a")]);
    expect(peekCachedVendors("wed_a")).toHaveLength(1);

    // Browser Back/Forward or an edited URL: the route moves without any
    // in-app handler running.
    window.location.hash = "#/w/wed_b";
    window.dispatchEvent(new HashChangeEvent("hashchange"));

    await waitFor(() => expect(shell().textContent).toContain("wed_b"));
    // Another wedding is another dashboard, not the old one re-pointed.
    expect(shell().getAttribute("data-mount")).not.toBe(firstMount);
    expect(peekCachedVendors("wed_a")).toBeNull();
    // A request the old dashboard started cannot put the rows back.
    setCachedVendors("wed_a", [vendorRow("wed_a")]);
    expect(peekCachedVendors("wed_a")).toBeNull();

    // Back to the list drops the wedding it came from too.
    setCachedVendors("wed_b", [vendorRow("wed_b")]);
    expect(peekCachedVendors("wed_b")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: /All weddings/i }));
    expect(screen.getByTestId("wedding-list")).toBeTruthy();
    expect(peekCachedVendors("wed_b")).toBeNull();

    // Opening a wedding again opens its caches again.
    window.location.hash = "#/w/wed_a";
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    await waitFor(() => expect(shell().textContent).toContain("wed_a"));
    setCachedVendors("wed_a", [vendorRow("wed_a")]);
    expect(peekCachedVendors("wed_a")).toHaveLength(1);
  });

  it("keeps the same dashboard when the open wedding is renamed", async () => {
    history.replaceState(null, "", "#/w/wed_a");
    authFetchMock.mockResolvedValue(
      listResponse([{ id: "wed_a", slug: "a", displayName: "Alice & Bob" }]),
    );
    render(() => <OrganiserApp />);
    await waitFor(() => expect(shell().textContent).toContain("wed_a"));
    const mount = shell().getAttribute("data-mount");
    setCachedVendors("wed_a", [vendorRow("wed_a")]);

    fireEvent.click(screen.getByText("rename"));

    expect(shell().getAttribute("data-mount")).toBe(mount);
    expect(peekCachedVendors("wed_a")).toHaveLength(1);
  });

  it("rechecks the list on a refusal, and drops a wedding the organiser was removed from", async () => {
    history.replaceState(null, "", "#/w/wed_a");
    let removed = false;
    authFetchMock.mockImplementation(async (url: string) => {
      if (url === LIST_URL) {
        return listResponse(
          removed ? [] : [{ id: "wed_a", slug: "a", displayName: "Alice & Bob" }],
        );
      }
      return new Response(JSON.stringify({ error: "forbidden" }), { status: 403 });
    });
    render(() => <OrganiserApp />);
    await waitFor(() => expect(shell().textContent).toContain("wed_a"));
    setCachedVendors("wed_a", [vendorRow("wed_a")]);
    expect(listCalls()).toBe(1);

    // The organiser is removed server-side; the next wedding request says so.
    removed = true;
    fireEvent.click(screen.getByText("read-vendors"));

    await waitFor(() => expect(screen.getByTestId("wedding-list")).toBeTruthy());
    expect(listCalls()).toBe(2);
    expect(screen.queryByTestId("module-shell")).toBeNull();
    expect(peekCachedVendors("wed_a")).toBeNull();
  });

  it("drops the rows when a recheck finds the role narrowed to one with no dashboard", async () => {
    history.replaceState(null, "", "#/w/wed_a");
    let role = "editor";
    authFetchMock.mockImplementation(async (url: string) => {
      if (url === LIST_URL) {
        return listResponse([{ id: "wed_a", slug: "a", displayName: "Alice & Bob", role }]);
      }
      return new Response(JSON.stringify({ error: "forbidden" }), { status: 403 });
    });
    render(() => <OrganiserApp />);
    await waitFor(() => expect(shell().textContent).toContain("wed_a"));
    setCachedVendors("wed_a", [vendorRow("wed_a")]);

    role = "helper";
    fireEvent.click(screen.getByText("read-vendors"));

    await waitFor(() => expect(screen.getByText(/Helper access/i)).toBeTruthy());
    expect(screen.queryByTestId("module-shell")).toBeNull();
    expect(peekCachedVendors("wed_a")).toBeNull();
  });

  it("keeps the dashboard and its rows when a refusal changes nothing", async () => {
    // A refusal that is not about the wedding — an owner-only field refused to
    // an editor — costs one list read and nothing else.
    history.replaceState(null, "", "#/w/wed_a");
    authFetchMock.mockImplementation(async (url: string) =>
      url === LIST_URL
        ? listResponse([{ id: "wed_a", slug: "a", displayName: "Alice & Bob", role: "editor" }])
        : new Response(JSON.stringify({ error: "owner_only_fields" }), { status: 403 }),
    );
    render(() => <OrganiserApp />);
    await waitFor(() => expect(shell().textContent).toContain("wed_a"));
    const mount = shell().getAttribute("data-mount");
    setCachedVendors("wed_a", [vendorRow("wed_a")]);

    fireEvent.click(screen.getByText("read-vendors"));

    await waitFor(() => expect(listCalls()).toBe(2));
    expect(shell().getAttribute("data-mount")).toBe(mount);
    expect(peekCachedVendors("wed_a")).toHaveLength(1);
  });

  it("does not recheck on a response that is not a refusal", async () => {
    history.replaceState(null, "", "#/w/wed_a");
    authFetchMock.mockImplementation(async (url: string) =>
      url === LIST_URL
        ? listResponse([{ id: "wed_a", slug: "a", displayName: "Alice & Bob" }])
        : new Response(JSON.stringify({ vendors: [] }), { status: 200 }),
    );
    render(() => <OrganiserApp />);
    await waitFor(() => expect(shell().textContent).toContain("wed_a"));

    fireEvent.click(screen.getByText("read-vendors"));
    await waitFor(() => expect(authFetchMock.mock.calls.length).toBe(2));
    expect(listCalls()).toBe(1);
  });

  it("throws away a recheck answer the list was written over, and asks again", async () => {
    history.replaceState(null, "", "#/w/wed_a");
    const wedA = [{ id: "wed_a", slug: "a", displayName: "Alice & Bob" }];
    let releaseStale: (res: Response) => void = () => {};
    let listReads = 0;
    authFetchMock.mockImplementation((url: string) => {
      if (url !== LIST_URL) {
        return Promise.resolve(new Response(JSON.stringify({ error: "x" }), { status: 403 }));
      }
      listReads += 1;
      // The recheck's first answer is held back until after a local write.
      if (listReads === 2) return new Promise<Response>((resolve) => (releaseStale = resolve));
      return Promise.resolve(listResponse(wedA));
    });
    render(() => <OrganiserApp />);
    await waitFor(() => expect(shell().textContent).toContain("wed_a"));

    fireEvent.click(screen.getByText("read-vendors"));
    await waitFor(() => expect(listReads).toBe(2));
    // A rename lands while the recheck is in flight.
    fireEvent.click(screen.getByText("rename"));
    // The held answer predates the rename and omits the wedding. Applied, it
    // would close the dashboard; it must be dropped and the list asked again.
    releaseStale(listResponse([]));

    await waitFor(() => expect(listReads).toBe(3));
    expect(shell().textContent).toContain("wed_a");
  });

  it("rechecks when the tab comes back into view, at most once a minute", async () => {
    const start = 1_900_000_000_000;
    const clock = vi.spyOn(Date, "now").mockReturnValue(start);
    try {
      history.replaceState(null, "", "#/w/wed_a");
      authFetchMock.mockResolvedValue(
        listResponse([{ id: "wed_a", slug: "a", displayName: "Alice & Bob" }]),
      );
      render(() => <OrganiserApp />);
      await waitFor(() => expect(shell().textContent).toContain("wed_a"));
      expect(listCalls()).toBe(1);

      // Straight back: too soon to ask again.
      clock.mockReturnValue(start + 30_000);
      document.dispatchEvent(new Event("visibilitychange"));
      expect(listCalls()).toBe(1);

      // Back after a minute: ask.
      clock.mockReturnValue(start + 61_000);
      document.dispatchEvent(new Event("visibilitychange"));
      await waitFor(() => expect(listCalls()).toBe(2));
    } finally {
      clock.mockRestore();
    }
  });

  /** A list read the test answers by hand. */
  function heldList() {
    let answer: (res: Response) => void = () => {};
    const promise = new Promise<Response>((resolve) => (answer = resolve));
    return { promise, answer };
  }

  it.each([
    ["answers 500", () => Promise.resolve(new Response(null, { status: 500 }))],
    ["fails outright", () => Promise.reject(new Error("network down"))],
    [
      "answers without a list",
      () => Promise.resolve(new Response(JSON.stringify({ weddings: null }), { status: 200 })),
    ],
  ])("changes nothing when the recheck %s", async (_label, failedRead) => {
    history.replaceState(null, "", "#/w/wed_a");
    let listReads = 0;
    authFetchMock.mockImplementation((url: string) => {
      if (url !== LIST_URL) {
        return Promise.resolve(new Response(JSON.stringify({ error: "x" }), { status: 403 }));
      }
      listReads += 1;
      return listReads === 1
        ? Promise.resolve(listResponse([{ id: "wed_a", slug: "a", displayName: "Alice & Bob" }]))
        : failedRead();
    });
    render(() => <OrganiserApp />);
    await waitFor(() => expect(shell().textContent).toContain("wed_a"));
    const mount = shell().getAttribute("data-mount");
    setCachedVendors("wed_a", [vendorRow("wed_a")]);

    fireEvent.click(screen.getByText("read-vendors"));
    await waitFor(() => expect(listReads).toBe(2));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(shell().getAttribute("data-mount")).toBe(mount);
    expect(peekCachedVendors("wed_a")).toHaveLength(1);
    expect(redirectSpy).not.toHaveBeenCalled();
  });

  it("sends the organiser to sign-in when the recheck finds the session gone", async () => {
    history.replaceState(null, "", "#/w/wed_a");
    let listReads = 0;
    authFetchMock.mockImplementation((url: string) => {
      if (url !== LIST_URL) {
        return Promise.resolve(new Response(JSON.stringify({ error: "x" }), { status: 403 }));
      }
      listReads += 1;
      return listReads === 1
        ? Promise.resolve(listResponse([{ id: "wed_a", slug: "a", displayName: "Alice & Bob" }]))
        : Promise.reject(new Error("AuthExpiredError"));
    });
    render(() => <OrganiserApp />);
    await waitFor(() => expect(shell().textContent).toContain("wed_a"));

    fireEvent.click(screen.getByText("read-vendors"));

    await waitFor(() => expect(redirectSpy).toHaveBeenCalledTimes(1));
  });

  it("shares one list read between refusals that arrive together", async () => {
    history.replaceState(null, "", "#/w/wed_a");
    const held = heldList();
    let listReads = 0;
    authFetchMock.mockImplementation((url: string) => {
      if (url !== LIST_URL) {
        return Promise.resolve(new Response(JSON.stringify({ error: "x" }), { status: 403 }));
      }
      listReads += 1;
      return listReads === 1
        ? Promise.resolve(listResponse([{ id: "wed_a", slug: "a", displayName: "Alice & Bob" }]))
        : held.promise;
    });
    render(() => <OrganiserApp />);
    await waitFor(() => expect(shell().textContent).toContain("wed_a"));

    for (let i = 0; i < 3; i += 1) fireEvent.click(screen.getByText("read-vendors"));
    await waitFor(() => expect(authFetchMock.mock.calls.length).toBe(5));
    expect(listReads).toBe(2);

    held.answer(listResponse([{ id: "wed_a", slug: "a", displayName: "Alice & Bob" }]));
  });

  it("gives up on a recheck left unanswered, and lets the newest answer win", async () => {
    const start = 1_900_000_000_000;
    const clock = vi.spyOn(Date, "now").mockReturnValue(start);
    try {
      history.replaceState(null, "", "#/w/wed_a");
      const wedA = [{ id: "wed_a", slug: "a", displayName: "Alice & Bob" }];
      const hung = heldList();
      const newer = heldList();
      let listReads = 0;
      authFetchMock.mockImplementation((url: string) => {
        if (url !== LIST_URL) {
          return Promise.resolve(new Response(JSON.stringify({ error: "x" }), { status: 403 }));
        }
        listReads += 1;
        if (listReads === 2) return hung.promise;
        if (listReads === 3) return newer.promise;
        return Promise.resolve(listResponse(wedA));
      });
      render(() => <OrganiserApp />);
      await waitFor(() => expect(shell().textContent).toContain("wed_a"));
      setCachedVendors("wed_a", [vendorRow("wed_a")]);

      fireEvent.click(screen.getByText("read-vendors"));
      await waitFor(() => expect(listReads).toBe(2));

      // Half a minute on, the first read is still unanswered: a new refusal
      // sends a new read rather than waiting on it.
      clock.mockReturnValue(start + 31_000);
      fireEvent.click(screen.getByText("read-vendors"));
      await waitFor(() => expect(listReads).toBe(3));

      // The newer read says the organiser was removed...
      newer.answer(listResponse([]));
      await waitFor(() => expect(screen.getByTestId("wedding-list")).toBeTruthy());
      expect(peekCachedVendors("wed_a")).toBeNull();

      // ...and the older one, landing late with the wedding still in it,
      // must not bring the wedding back.
      hung.answer(listResponse(wedA));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(screen.getByTestId("count").textContent).toBe("0");
      expect(screen.queryByTestId("module-shell")).toBeNull();
      expect(peekCachedVendors("wed_a")).toBeNull();
    } finally {
      clock.mockRestore();
    }
  });

  it("drops the wedding's rows when the organiser opens Security", async () => {
    history.replaceState(null, "", "#/w/wed_a");
    authFetchMock.mockResolvedValue(
      listResponse([{ id: "wed_a", slug: "a", displayName: "Alice & Bob" }]),
    );
    render(() => <OrganiserApp />);
    await waitFor(() => expect(shell().textContent).toContain("wed_a"));
    setCachedVendors("wed_a", [vendorRow("wed_a")]);

    window.location.hash = "#/security";
    window.dispatchEvent(new HashChangeEvent("hashchange"));

    await waitFor(() => expect(screen.getByTestId("security-panel")).toBeTruthy());
    expect(peekCachedVendors("wed_a")).toBeNull();
  });

  it("rechecks when the organiser moves within the dashboard, at most once a minute", async () => {
    // Loaded modules answer from their caches, so moving between them sends
    // no request a refusal could come back on.
    const start = 1_900_000_000_000;
    const clock = vi.spyOn(Date, "now").mockReturnValue(start);
    try {
      history.replaceState(null, "", "#/w/wed_a");
      authFetchMock.mockResolvedValue(
        listResponse([{ id: "wed_a", slug: "a", displayName: "Alice & Bob" }]),
      );
      render(() => <OrganiserApp />);
      await waitFor(() => expect(shell().textContent).toContain("wed_a"));

      clock.mockReturnValue(start + 30_000);
      fireEvent.click(screen.getByText("go-guests"));
      expect(listCalls()).toBe(1);

      clock.mockReturnValue(start + 61_000);
      fireEvent.click(screen.getByText("go-rsvps"));
      await waitFor(() => expect(listCalls()).toBe(2));
    } finally {
      clock.mockRestore();
    }
  });

  it("asks again when a refusal comes from a request sent after the check in flight", async () => {
    // The check in flight may have been answered before the change the new
    // refusal reports; joining it would spend that evidence on a stale answer.
    const start = 1_900_000_000_000;
    const clock = vi.spyOn(Date, "now").mockReturnValue(start);
    try {
      history.replaceState(null, "", "#/w/wed_a");
      const wedA = [{ id: "wed_a", slug: "a", displayName: "Alice & Bob" }];
      const early = heldList();
      let listReads = 0;
      authFetchMock.mockImplementation((url: string) => {
        if (url !== LIST_URL) {
          return Promise.resolve(new Response(JSON.stringify({ error: "x" }), { status: 403 }));
        }
        listReads += 1;
        if (listReads === 2) return early.promise;
        return Promise.resolve(listResponse(listReads === 3 ? [] : wedA));
      });
      render(() => <OrganiserApp />);
      await waitFor(() => expect(shell().textContent).toContain("wed_a"));

      fireEvent.click(screen.getByText("read-vendors"));
      await waitFor(() => expect(listReads).toBe(2));

      clock.mockReturnValue(start + 1_000);
      fireEvent.click(screen.getByText("read-vendors"));

      await waitFor(() => expect(screen.getByTestId("wedding-list")).toBeTruthy());
      expect(listReads).toBe(3);
      early.answer(listResponse(wedA));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(screen.queryByTestId("module-shell")).toBeNull();
    } finally {
      clock.mockRestore();
    }
  });
});
