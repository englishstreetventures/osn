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

const toastSuccess = vi.fn();
const toastError = vi.fn();
const toastInfo = vi.fn();
vi.mock("@shared/toast", () => ({
  Toaster: () => null,
  // The upgrade return, the helper screen's leave control and a deleted
  // wedding toast their outcome.
  toast: {
    success: (...args: unknown[]) => toastSuccess(...args),
    error: (...args: unknown[]) => toastError(...args),
    info: (...args: unknown[]) => toastInfo(...args),
  },
}));

vi.mock("../../src/lib/api", async () => {
  const { organiserApiMock } = await import("../test-support/mocks");
  return organiserApiMock();
});

// Leaf views stubbed to data-testids; WeddingList exposes select, create,
// restore and restore-expired triggers so we can drive the parent's state
// transitions. The last two act on the first deleted wedding listed.
vi.mock("../../src/components/WeddingList", () => ({
  default: (props: {
    weddings: { id: string; displayName: string }[];
    deleted?: { id: string }[];
    onSelect: (w: unknown) => void;
    onCreated: (w: unknown) => void;
    onRestored?: (weddingId: string) => void;
    onRestoreExpired?: (weddingId: string) => void;
  }) => (
    <div data-testid="wedding-list">
      <span data-testid="count">{props.weddings.length}</span>
      <span data-testid="deleted-count">{(props.deleted ?? []).length}</span>
      <span data-testid="deleted-ids">{(props.deleted ?? []).map((w) => w.id).join(",")}</span>
      <button onClick={() => props.onSelect(props.weddings[0])}>select-first</button>
      <button onClick={() => props.onRestored?.(props.deleted![0]!.id)}>
        restore-first-deleted
      </button>
      <button onClick={() => props.onRestoreExpired?.(props.deleted![0]!.id)}>
        expire-first-deleted
      </button>
      <button
        onClick={() =>
          props.onCreated({
            id: "wed_new",
            slug: "new-x",
            displayName: "Fresh Wedding",
            role: "owner",
            tier: "ivory",
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
      tier: string;
      onModule: (m: string, sub?: string) => void;
      onSub: (s: string) => void;
      onWeddingUpdated?: (patch: { displayName: string; slug: string }) => void;
      onWeddingDeleted?: (restoreUntil: string) => void;
      onLeftWedding?: () => void;
      onOwnRoleChanged?: (role: "owner" | "editor" | "viewer" | "helper") => void;
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
          data-tier={props.tier}
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
          <button onClick={() => props.onWeddingDeleted?.("2026-10-08T12:00:00.000Z")}>
            delete-wedding
          </button>
          <button onClick={() => props.onLeftWedding?.()}>leave</button>
          <button onClick={() => props.onOwnRoleChanged?.("editor")}>step-down</button>
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

/** A `GET /api/organiser/weddings` answer. `deleted`, when given, is the
 *  owner's restorable weddings; left out, the body carries no `deleted` key. */
function listResponse(
  weddings: {
    id: string;
    slug: string;
    displayName: string;
    role?: string;
    tier?: string;
    entitlements?: string[];
    guestCap?: number;
  }[],
  deleted?: { id: string; slug: string; displayName: string }[],
  status = 200,
) {
  return new Response(
    JSON.stringify({
      weddings: weddings.map((w) => ({
        role: "owner",
        tier: "ivory",
        entitlements: [],
        guestCap: 100,
        ...w,
      })),
      ...(deleted && {
        deleted: deleted.map((w) => ({
          deletedAt: "2026-10-01T12:00:00.000Z",
          restoreUntil: "2026-10-08T12:00:00.000Z",
          ...w,
        })),
      }),
    }),
    {
      status,
      headers: { "Content-Type": "application/json" },
    },
  );
}

describe("OrganiserApp Dashboard", () => {
  beforeEach(() => {
    authFetchMock.mockReset();
    // The toast spies are this suite's own, so `resetOrganiserMocks` does not
    // clear them; a test asserting a toast is absent needs them empty.
    toastSuccess.mockReset();
    toastError.mockReset();
    toastInfo.mockReset();
    __resetWeddingScope();
    __resetVendorsCache();
  });

  afterEach(async () => {
    cleanup();
    // Kobalte's menus set and clear `aria-hidden` on everything outside them
    // from a zero-delay timeout that requests an animation frame. Both run
    // here, before the next test starts; otherwise a menu opened in this test
    // can leave <body> hidden from a later test's role queries.
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => requestAnimationFrame(resolve));
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

  it("lets a helper leave from the run-sheet screen, which drops the wedding", async () => {
    // A helper never reaches the co-host panel, so the run-sheet screen is the
    // only place their leave control can live.
    authFetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === "DELETE") return new Response(JSON.stringify({ left: true }));
      return listResponse([{ id: "wed_h", slug: "h", displayName: "Helped", role: "helper" }]);
    });
    render(() => <OrganiserApp />);
    await waitFor(() => expect(screen.getByTestId("wedding-list")).toBeTruthy());
    fireEvent.click(screen.getByText("select-first"));
    expect(screen.getByText(/Helper access/i)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Leave this wedding/i }));
    fireEvent.click(await screen.findByRole("button", { name: /Yes, leave/i }));

    await waitFor(() => expect(screen.getByTestId("count").textContent).toBe("0"));
    expect(screen.queryByText(/Helper access/i)).toBeNull();
    const del = authFetchMock.mock.calls.find(([, init]) => init?.method === "DELETE");
    expect(String(del?.[0])).toBe("https://api.test/api/organiser/weddings/wed_h/hosts/me");
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

  it("hands the wedding's tier to the module shell", async () => {
    authFetchMock.mockResolvedValue(
      listResponse([{ id: "wed_g", slug: "g", displayName: "Golden", tier: "gold" }]),
    );
    render(() => <OrganiserApp />);
    await waitFor(() => expect(screen.getByTestId("wedding-list")).toBeTruthy());

    fireEvent.click(screen.getByText("select-first"));
    expect(screen.getByTestId("module-shell").getAttribute("data-tier")).toBe("gold");
  });

  it("reads the tier from the legacy keys of an API that sends none", async () => {
    // The portal can deploy ahead of the API. That API's list has no `tier`,
    // only the packs a wedding bought; `vendors` was the Crimson pack, and
    // reading it as Ivory would lock a module the couple paid for.
    authFetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          weddings: [
            {
              id: "wed_l",
              slug: "l",
              displayName: "Legacy",
              role: "owner",
              entitlements: ["vendors"],
              guestCap: 1000,
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    render(() => <OrganiserApp />);
    await waitFor(() => expect(screen.getByTestId("wedding-list")).toBeTruthy());

    fireEvent.click(screen.getByText("select-first"));
    expect(screen.getByTestId("module-shell").getAttribute("data-tier")).toBe("crimson");
  });

  it("treats a tier it has never heard of as Ivory, which opens nothing paid", async () => {
    authFetchMock.mockResolvedValue(
      listResponse([
        {
          id: "wed_p",
          slug: "p",
          displayName: "Platinum",
          tier: "platinum",
          entitlements: ["vendors"],
        },
      ]),
    );
    render(() => <OrganiserApp />);
    await waitFor(() => expect(screen.getByTestId("wedding-list")).toBeTruthy());

    fireEvent.click(screen.getByText("select-first"));
    expect(screen.getByTestId("module-shell").getAttribute("data-tier")).toBe("ivory");
  });

  it("names the tier bought when a returning purchase has settled, and refreshes the list", async () => {
    // Stripe sends the organiser back with the receipt in the query.
    history.replaceState(null, "", "/?w=wed_a&m=registry&upgrade=upg_1");
    let listReads = 0;
    authFetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith("/upgrade/purchases/upg_1")) {
        return new Response(JSON.stringify({ purchase: { status: "succeeded", tier: "gold" } }), {
          status: 200,
        });
      }
      listReads += 1;
      return listResponse([
        {
          id: "wed_a",
          slug: "a",
          displayName: "Alice & Bob",
          tier: listReads > 1 ? "gold" : "ivory",
        },
      ]);
    });
    render(() => <OrganiserApp />);

    await waitFor(() =>
      expect(toastSuccess).toHaveBeenCalledWith("Upgrade complete — this wedding is on Gold."),
    );
    // The list is what the nav locks by, so it is read again once the tier is raised.
    expect(listReads).toBe(2);
    // And the receipt is gone from the URL, so a refresh does not poll again.
    expect(window.location.search).toBe("");
    toastSuccess.mockReset();
  });

  it("says the upgrade is complete without naming a tier this build does not know", async () => {
    // A purchase the API reports in a tier this portal has no name for comes
    // back with no tier at all; the toast must not try to name one.
    history.replaceState(null, "", "/?w=wed_a&m=registry&upgrade=upg_1");
    let listReads = 0;
    authFetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith("/upgrade/purchases/upg_1")) {
        return new Response(
          JSON.stringify({ purchase: { status: "succeeded", tier: "platinum" } }),
          { status: 200 },
        );
      }
      listReads += 1;
      return listResponse([{ id: "wed_a", slug: "a", displayName: "Alice & Bob", tier: "gold" }]);
    });
    render(() => <OrganiserApp />);

    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith("Upgrade complete."));
    expect(listReads).toBe(2);
    expect(window.location.search).toBe("");
    toastSuccess.mockReset();
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

  it("drops a wedding the organiser leaves from the list, the route and the caches", async () => {
    history.replaceState(null, "", "#/w/wed_a");
    authFetchMock.mockResolvedValue(
      listResponse([
        { id: "wed_a", slug: "a", displayName: "Alice & Bob", role: "editor" },
        { id: "wed_b", slug: "b", displayName: "Bea & Cal", role: "viewer" },
      ]),
    );
    render(() => <OrganiserApp />);
    await waitFor(() => expect(shell().textContent).toContain("wed_a"));
    setCachedVendors("wed_a", [vendorRow("wed_a")]);
    expect(peekCachedVendors("wed_a")).toHaveLength(1);

    fireEvent.click(screen.getByText("leave"));

    await waitFor(() => expect(screen.getByTestId("wedding-list")).toBeTruthy());
    expect(screen.queryByTestId("module-shell")).toBeNull();
    expect(screen.getByTestId("count").textContent).toBe("1");
    expect(window.location.hash).not.toContain("wed_a");
    expect(peekCachedVendors("wed_a")).toBeNull();
    // Leaving is local: the list is not asked again.
    expect(listCalls()).toBe(1);
  });

  it("narrows the open dashboard when its owner steps down, without a refetch or a remount", async () => {
    history.replaceState(null, "", "#/w/wed_a");
    authFetchMock.mockResolvedValue(
      listResponse([{ id: "wed_a", slug: "a", displayName: "Alice & Bob" }]),
    );
    render(() => <OrganiserApp />);
    await waitFor(() => expect(shell().textContent).toContain("wed_a"));
    expect(shell().getAttribute("data-can-manage")).toBe("true");
    const mount = shell().getAttribute("data-mount");
    const reads = authFetchMock.mock.calls.length;

    fireEvent.click(screen.getByText("step-down"));

    expect(shell().getAttribute("data-can-manage")).toBe("false");
    expect(shell().getAttribute("data-can-edit")).toBe("true");
    expect(shell().getAttribute("data-mount")).toBe(mount);
    expect(authFetchMock.mock.calls.length).toBe(reads);
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

  it("moves a wedding its owner deleted from the dashboard to the restorable list", async () => {
    history.replaceState(null, "", "#/w/wed_a");
    authFetchMock.mockImplementation(async (url: string) =>
      url === LIST_URL
        ? listResponse([{ id: "wed_a", slug: "a", displayName: "Alice & Bob" }])
        : new Response("{}", { status: 200 }),
    );
    render(() => <OrganiserApp />);
    await waitFor(() => expect(shell().textContent).toContain("wed_a"));
    setCachedVendors("wed_a", [vendorRow("wed_a")]);

    fireEvent.click(screen.getByText("delete-wedding"));

    await waitFor(() => expect(screen.getByTestId("wedding-list")).toBeTruthy());
    expect(screen.getByTestId("count").textContent).toBe("0");
    expect(screen.getByTestId("deleted-count").textContent).toBe("1");
    expect(screen.queryByTestId("module-shell")).toBeNull();
    expect(peekCachedVendors("wed_a")).toBeNull();
    expect(toastSuccess).toHaveBeenCalledWith(expect.stringMatching(/restore it .* until/));
  });

  it("rechecks on a wedding_not_found 404, and drops a wedding another owner deleted", async () => {
    history.replaceState(null, "", "#/w/wed_a");
    let deleted = false;
    authFetchMock.mockImplementation(async (url: string) => {
      if (url === LIST_URL) {
        return deleted
          ? new Response(
              JSON.stringify({
                weddings: [],
                deleted: [
                  {
                    id: "wed_a",
                    slug: "a",
                    displayName: "Alice & Bob",
                    deletedAt: "2026-10-01T12:00:00.000Z",
                    restoreUntil: "2026-10-08T12:00:00.000Z",
                  },
                ],
              }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            )
          : listResponse([{ id: "wed_a", slug: "a", displayName: "Alice & Bob" }]);
      }
      return new Response(JSON.stringify({ error: "wedding_not_found" }), { status: 404 });
    });
    render(() => <OrganiserApp />);
    await waitFor(() => expect(shell().textContent).toContain("wed_a"));

    deleted = true;
    fireEvent.click(screen.getByText("read-vendors"));

    await waitFor(() => expect(screen.getByTestId("wedding-list")).toBeTruthy());
    expect(listCalls()).toBe(2);
    expect(screen.getByTestId("deleted-count").textContent).toBe("1");
  });

  // ── Restoring a deleted wedding ─────────────────────────────────────────────

  const deletedA = { id: "wed_a", slug: "a", displayName: "Alice & Bob" };

  it("opens a restored wedding, takes it off the restorable list, and says so", async () => {
    let listReads = 0;
    authFetchMock.mockImplementation(async () => {
      listReads += 1;
      return listReads === 1 ? listResponse([], [deletedA]) : listResponse([deletedA], []);
    });
    render(() => <OrganiserApp />);
    await waitFor(() => expect(screen.getByTestId("deleted-count").textContent).toBe("1"));

    fireEvent.click(screen.getByText("restore-first-deleted"));

    await waitFor(() => expect(shell().textContent).toContain("wed_a"));
    expect(window.location.hash).toBe("#/w/wed_a");
    expect(toastSuccess).toHaveBeenCalledWith("Wedding restored.");
    expect(listReads).toBe(2);

    // Back on the list, the wedding is live and no longer restorable.
    fireEvent.click(screen.getByRole("button", { name: /All weddings/i }));
    expect(screen.getByTestId("count").textContent).toBe("1");
    expect(screen.getByTestId("deleted-count").textContent).toBe("0");
  });

  it("sends the organiser to sign-in when the session lapses as the restored list loads", async () => {
    let listReads = 0;
    authFetchMock.mockImplementation(() => {
      listReads += 1;
      return listReads === 1
        ? Promise.resolve(listResponse([], [deletedA]))
        : Promise.reject(new Error("AuthExpiredError"));
    });
    render(() => <OrganiserApp />);
    await waitFor(() => expect(screen.getByTestId("deleted-count").textContent).toBe("1"));

    fireEvent.click(screen.getByText("restore-first-deleted"));

    await waitFor(() => expect(redirectSpy).toHaveBeenCalledTimes(1));
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(screen.getByTestId("deleted-count").textContent).toBe("1");
  });

  it.each([
    // A refused read is not a list, even when its body looks like one.
    ["refused", () => Promise.resolve(listResponse([deletedA], [], 503))],
    ["lost to the network", () => Promise.reject(new Error("network down"))],
  ])("changes nothing when the list read after a restore is %s", async (_label, failedRead) => {
    let listReads = 0;
    authFetchMock.mockImplementation(() => {
      listReads += 1;
      return listReads === 1 ? Promise.resolve(listResponse([], [deletedA])) : failedRead();
    });
    render(() => <OrganiserApp />);
    await waitFor(() => expect(screen.getByTestId("deleted-count").textContent).toBe("1"));

    fireEvent.click(screen.getByText("restore-first-deleted"));
    // The read is counted the moment the handler sends it; what it does with
    // the answer runs after, so wait past that before asserting nothing moved.
    await waitFor(() => expect(listReads).toBe(2));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(screen.queryByTestId("module-shell")).toBeNull();
    expect(screen.getByTestId("count").textContent).toBe("0");
    expect(screen.getByTestId("deleted-count").textContent).toBe("1");
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(redirectSpy).not.toHaveBeenCalled();
  });

  it("drops a deleted wedding from the restorable list once its restore window has passed", async () => {
    authFetchMock.mockResolvedValue(
      listResponse([], [deletedA, { id: "wed_c", slug: "c", displayName: "Cal & Dee" }]),
    );
    render(() => <OrganiserApp />);
    await waitFor(() => expect(screen.getByTestId("deleted-ids").textContent).toBe("wed_a,wed_c"));

    fireEvent.click(screen.getByText("expire-first-deleted"));

    expect(screen.getByTestId("deleted-ids").textContent).toBe("wed_c");
    // Local: the list is not asked again.
    expect(listCalls()).toBe(1);
  });

  it("does not recheck on a 404 for a row inside the wedding", async () => {
    history.replaceState(null, "", "#/w/wed_a");
    authFetchMock.mockImplementation(async (url: string) =>
      url === LIST_URL
        ? listResponse([{ id: "wed_a", slug: "a", displayName: "Alice & Bob" }])
        : new Response(JSON.stringify({ error: "vendor_not_found" }), { status: 404 }),
    );
    render(() => <OrganiserApp />);
    await waitFor(() => expect(shell().textContent).toContain("wed_a"));

    fireEvent.click(screen.getByText("read-vendors"));
    await waitFor(() => expect(authFetchMock.mock.calls.length).toBe(2));
    expect(listCalls()).toBe(1);
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
