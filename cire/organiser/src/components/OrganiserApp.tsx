import { AuthProvider, useAuth } from "@shared/rp-auth/solid";
import {
  createEffect,
  createResource,
  createSignal,
  lazy,
  onCleanup,
  onMount,
  type ParentProps,
  Show,
  Suspense,
} from "solid-js";
import { Toaster } from "solid-toast";

import { apiUrl, isAuthExpired, redirectToLogin } from "../lib/api";
import { createCommandShortcut } from "../lib/command-shortcut";
import {
  type DashboardRoute,
  DEFAULT_MODULE,
  defaultSub,
  LIST_ROUTE,
  type Module,
  parseRoute,
  serializeRoute,
} from "../lib/dashboard-route";
import { CIRE_API_URL } from "../lib/osn";
import { initTheme } from "../lib/theme";
import { confirmNavigation } from "../lib/unsaved-guard";
import type { WeddingSummary } from "./CreateWeddingForm";
import ModuleShell from "./ModuleShell";
import SecurityPanel from "./SecurityPanel";
import TopBar from "./TopBar";
import Notice from "./ui/Notice";
import WeddingList from "./WeddingList";

/**
 * The palette is the one piece of chrome nobody sees until they ask for it, and
 * it is not small — a dialog, a filtered listbox, the module catalogue and the
 * theme switch. Splitting it out is the portal's only route-level split that
 * costs nothing in reach: the shortcut that summons it lives in
 * `lib/command-shortcut`, so it is bound from the first paint whether or not
 * this chunk has arrived.
 */
const CommandPalette = lazy(() => import("./CommandPalette"));

type WeddingsState =
  | { kind: "error"; message: string }
  | { kind: "ready"; weddings: WeddingSummary[] };

function Loading(props: { label: string }) {
  return (
    <p class="font-body text-text-muted animate-pulse text-[0.88rem] tracking-[0.1em] uppercase">
      {props.label}
    </p>
  );
}

/**
 * Gate: session() is undefined while the SDK restores the session, null
 * when signed out, a Session when signed in.
 */
function RequireAuth(props: ParentProps) {
  const { session } = useAuth();

  createEffect(() => {
    if (session() === null) redirectToLogin();
  });

  return (
    <Show
      when={session()}
      fallback={
        // The signed-in tree owns the page measure (the top bar is full-bleed,
        // so `page-frame` moved inside it). This fallback renders instead of
        // that tree, so it carries its own frame or it sits against the edge.
        <div class="page-frame py-10">
          <Loading label="Checking session…" />
        </div>
      }
    >
      {props.children}
    </Show>
  );
}

/** The chosen wedding's dashboard — the module shell (left module rail +
 *  panel), scoped to whichever wedding the organiser opened. It has no header
 *  of its own: which wedding is open, the role badge and "preview invite" all
 *  live in the top bar now, so the first thing under the chrome is the work.
 *  Access follows the caller's role: EDITOR co-hosts get the full read/edit
 *  dashboard (import, invite design, event locations, and the settings panel's
 *  RSVP-by date — the API gates writes with weddingEditor); VIEWER co-hosts get
 *  the read views only (`canEdit` hides the write surfaces). The owner-only
 *  management actions (co-hosts, re-minting codes, deactivating household
 *  codes, the rest of the settings save) stay gated on `isOwner` via
 *  `canManage`.
 *
 *  The active module + sub are fully controlled by the parent (URL-hash driven)
 *  so a deep link / hard refresh restores the exact view; the shell reports
 *  navigation back up via `onModule` / `onSub`. Getting-started (now the Overview
 *  empty-state) and the import both moved into their modules. */
function WeddingDashboard(props: {
  wedding: WeddingSummary;
  /** Active module + sub as accessors so they stay reactive across hash changes
   *  even while the same wedding object stays selected. */
  module: () => Module;
  sub: () => string;
  onModule: (module: Module) => void;
  onSub: (sub: string) => void;
  /** A Settings save changed the name/slug — bubble it up so the wedding list
   *  (and the top bar's switcher) reflect it without a refetch. */
  onWeddingUpdated: (patch: { displayName: string; slug: string }) => void;
}) {
  const isOwner = () => props.wedding.role === "owner";
  // Editors (and owners) get the write surfaces; viewers are read-only — the
  // API enforces this with weddingEditor()/weddingOwner(); the flags just keep
  // the portal from offering actions that would 403.
  const canEdit = () => props.wedding.role !== "viewer";

  return (
    <ModuleShell
      weddingId={props.wedding.id}
      weddingName={props.wedding.displayName}
      weddingSlug={props.wedding.slug}
      canManage={isOwner()}
      canEdit={canEdit()}
      module={props.module()}
      sub={props.sub()}
      onModule={props.onModule}
      onSub={props.onSub}
      onWeddingUpdated={props.onWeddingUpdated}
      entitlements={props.wedding.entitlements ?? []}
      guestCap={props.wedding.guestCap ?? 100}
    />
  );
}

function initialRoute(): DashboardRoute {
  if (typeof window === "undefined") return LIST_ROUTE;
  return parseRoute(window.location.hash);
}

function Dashboard() {
  const { authFetch, logout, session } = useAuth();
  // Locally-tracked weddings so a freshly-created one shows up without a
  // refetch. Seeded from the initial load.
  const [weddings, setWeddings] = createSignal<WeddingSummary[] | null>(null);

  // The single source of navigable state: top-level view + selected wedding +
  // active tab, mirrored into the URL hash so a hard refresh restores it and a
  // shared link reopens it. Seeded from the hash on first paint.
  const [route, setRouteSignal] = createSignal<DashboardRoute>(initialRoute());

  // The ⌘K palette is chrome-level state — it opens over whichever view is
  // showing. Two signals rather than one: `open` is what the dialog reads,
  // `summoned` latches on the first open and never clears, so the chunk is
  // fetched and mounted once instead of on every ⌘K.
  const [paletteOpen, setPaletteOpen] = createSignal(false);
  const [paletteSummoned, setPaletteSummoned] = createSignal(false);

  function setPalette(open: boolean) {
    if (open) setPaletteSummoned(true);
    setPaletteOpen(open);
  }

  createCommandShortcut(() => setPalette(!paletteOpen()));

  // Warm the chunk while the browser is idle, so the first ⌘K opens on the
  // frame it is pressed rather than after a round trip. Idle, not eager: the
  // point of the split is to keep it off the path to first paint, and putting
  // it back on that path with a bare `import()` at mount would undo it.
  onMount(() => {
    const warm = () => void import("./CommandPalette");
    if (typeof requestIdleCallback === "function") {
      const id = requestIdleCallback(warm, { timeout: 4000 });
      onCleanup(() => cancelIdleCallback(id));
    } else {
      const id = setTimeout(warm, 2000);
      onCleanup(() => clearTimeout(id));
    }
  });

  // Write the hash with replaceState by default (tab switches) so they don't
  // pile up history entries; explicit navigations (open a wedding, go back to
  // the list, switch view) push so Back/Forward walks them. Either way the URL
  // stays the source of truth and a manual edit or browser Back/Forward
  // re-syncs via the hashchange listener below.
  function setRoute(next: DashboardRoute, mode: "push" | "replace" = "replace") {
    // A mounted write surface with unsaved edits (the invite builder) gets to
    // veto in-app navigation — switching module/sub/view unmounts it and would
    // silently discard the draft. Browser Back/Forward bypasses this (see
    // lib/unsaved-guard); beforeunload covers tab close/reload.
    if (serializeRoute(next) !== serializeRoute(route()) && !confirmNavigation()) return;
    setRouteSignal(next);
    if (typeof window === "undefined") return;
    const hash = serializeRoute(next);
    if (window.location.hash === hash) return;
    const url = `${window.location.pathname}${window.location.search}${hash}`;
    if (mode === "push") history.pushState(null, "", url);
    else history.replaceState(null, "", url);
  }

  // Re-sync from the hash on browser Back/Forward and manual edits. The signal
  // is the source of truth for render; the listener just mirrors external hash
  // changes back into it (it never writes the hash, so no feedback loop).
  function onHashChange() {
    setRouteSignal(parseRoute(window.location.hash));
  }
  onMount(() => {
    window.addEventListener("hashchange", onHashChange);
    // Normalise a legacy / shorthand hash (e.g. `#security`, `#guests`, or "")
    // into the canonical `#/…` form without adding a history entry.
    const canonical = serializeRoute(parseRoute(window.location.hash));
    if (window.location.hash !== canonical) {
      history.replaceState(
        null,
        "",
        `${window.location.pathname}${window.location.search}${canonical}`,
      );
    }
  });
  onCleanup(() => {
    if (typeof window !== "undefined") window.removeEventListener("hashchange", onHashChange);
  });

  const view = () => route().view;

  function selectView(next: "weddings" | "security") {
    if (next === "security")
      setRoute(
        {
          view: "security",
          weddingId: null,
          module: DEFAULT_MODULE,
          sub: defaultSub(DEFAULT_MODULE),
        },
        "push",
      );
    else setRoute(LIST_ROUTE, "push");
  }

  function selectWedding(wedding: WeddingSummary) {
    setRoute(
      {
        view: "weddings",
        weddingId: wedding.id,
        module: DEFAULT_MODULE,
        sub: defaultSub(DEFAULT_MODULE),
      },
      "push",
    );
  }

  function backToList() {
    setRoute(LIST_ROUTE, "push");
  }

  /** Switch module — resets the sub to that module's default (push, so the
   *  module change is a Back-able history entry). */
  function selectModule(module: Module) {
    const r = route();
    if (r.view !== "weddings" || r.weddingId === null) return;
    setRoute({ view: "weddings", weddingId: r.weddingId, module, sub: defaultSub(module) }, "push");
  }

  /** Switch sub within the current module (replace — a sub flip shouldn't pile
   *  up history entries, matching the old tab behaviour). */
  function selectSub(sub: string) {
    const r = route();
    if (r.view !== "weddings" || r.weddingId === null) return;
    setRoute({ view: "weddings", weddingId: r.weddingId, module: r.module, sub }, "replace");
  }

  const [loaded] = createResource<WeddingsState>(async () => {
    try {
      const res = await authFetch(apiUrl("/api/organiser/weddings"));
      if (res.status === 401) {
        redirectToLogin();
        return { kind: "ready", weddings: [] };
      }
      if (!res.ok) return { kind: "error", message: `Could not load weddings (${res.status}).` };
      const body = (await res.json()) as { weddings: WeddingSummary[] };
      setWeddings(body.weddings);
      return { kind: "ready", weddings: body.weddings };
    } catch (err) {
      if (isAuthExpired(err)) {
        redirectToLogin();
        return { kind: "ready", weddings: [] };
      }
      return { kind: "error", message: "Could not load weddings. Is the API running?" };
    }
  });

  const loadError = () => {
    const state = loaded();
    return state?.kind === "error" ? state.message : null;
  };

  // The wedding named by the route, once the list has loaded. A deep link to a
  // wedding the organiser can't load (not owner/host, or gone) resolves to null;
  // the effect below then falls the route back to the list rather than hanging.
  const selected = () => {
    const r = route();
    if (r.view !== "weddings" || r.weddingId === null) return null;
    return weddings()?.find((w) => w.id === r.weddingId) ?? null;
  };

  // Graceful fallback: once the list is loaded, if the route names a wedding
  // that isn't in it, drop back to the list (replace — a dead link shouldn't
  // leave a Back-able entry).
  createEffect(() => {
    const r = route();
    if (r.view !== "weddings" || r.weddingId === null) return;
    const list = weddings();
    if (!list) return; // still loading — don't judge yet
    if (!list.some((w) => w.id === r.weddingId)) setRoute(LIST_ROUTE, "replace");
  });

  /** A Settings save renamed the selected wedding (or moved its slug) — patch
   *  the local list so the header, list, and invite-message copy stay current. */
  function handleWeddingUpdated(weddingId: string, patch: { displayName: string; slug: string }) {
    setWeddings((prev) => (prev ?? []).map((w) => (w.id === weddingId ? { ...w, ...patch } : w)));
  }

  function handleCreated(wedding: WeddingSummary) {
    setWeddings((prev) => [...(prev ?? []), wedding]);
    // Open the new wedding straight away — the organiser just made it to fill
    // it in.
    selectWedding(wedding);
  }

  async function signOut() {
    await logout();
    redirectToLogin();
  }

  /** What the top bar names when no wedding is open. With one open, the
   *  switcher names it instead and this is unused. */
  const sectionLabel = () => (view() === "security" ? "Security" : "All weddings");

  return (
    <>
      <TopBar
        session={session()}
        wedding={selected()}
        weddings={weddings() ?? []}
        sectionLabel={sectionLabel()}
        onWedding={selectWedding}
        onAll={backToList}
        onSecurity={() => selectView("security")}
        onSignOut={() => void signOut()}
        onOpenPalette={() => setPalette(true)}
      />

      {/* No Suspense fallback on purpose: the palette is an overlay, and a
          spinner where an overlay is about to be is worse than the overlay
          arriving a frame later. */}
      <Show when={paletteSummoned()}>
        <Suspense>
          <CommandPalette
            open={paletteOpen()}
            onOpenChange={setPalette}
            wedding={selected()}
            weddings={weddings() ?? []}
            onModule={selectModule}
            onWedding={selectWedding}
            onAll={backToList}
            onSecurity={() => selectView("security")}
            onSignOut={() => void signOut()}
          />
        </Suspense>
      </Show>

      {/* `@container/page` is the outermost query context for the views that sit
          outside the module shell (the wedding list, the create form). The main
          element carries the page measure: the bar above is full-bleed so its
          hairline runs edge to edge, while its contents share this gutter. */}
      <main class="page-frame @container/page flex flex-col gap-8 py-8 @2xl/frame:py-10">
        <Show when={view() === "security"}>
          <SecurityPanel />
        </Show>

        <Show when={view() === "weddings"}>
          <Show when={loaded()} fallback={<Loading label="Loading weddings…" />}>
            <Show when={loadError()}>{(message) => <Notice tone="error">{message()}</Notice>}</Show>

            <Show when={!loadError() && weddings()}>
              {(list) => (
                <Show
                  when={selected()}
                  fallback={
                    <WeddingList
                      weddings={list()}
                      onSelect={(w) => selectWedding(w)}
                      onCreated={handleCreated}
                    />
                  }
                >
                  {(wedding) => (
                    <WeddingDashboard
                      wedding={wedding()}
                      module={() => {
                        const r = route();
                        return r.view === "weddings" ? r.module : DEFAULT_MODULE;
                      }}
                      sub={() => {
                        const r = route();
                        return r.view === "weddings" ? r.sub : defaultSub(DEFAULT_MODULE);
                      }}
                      onModule={selectModule}
                      onSub={selectSub}
                      onWeddingUpdated={(patch) => handleWeddingUpdated(wedding().id, patch)}
                    />
                  )}
                </Show>
              )}
            </Show>
          </Show>
        </Show>
      </main>
    </>
  );
}

/**
 * Single root island for the dashboard page. Astro pages cannot share a
 * SolidJS context across islands, so AuthProvider wraps everything here.
 */
export default function OrganiserApp() {
  // The inline boot script already put the right theme on `data-theme` before
  // first paint; this takes over from it, so a host who follows their system
  // theme sees the portal change with it rather than at the next reload.
  onMount(() => onCleanup(initTheme()));

  return (
    <AuthProvider config={{ apiBase: CIRE_API_URL }}>
      <RequireAuth>
        <Dashboard />
      </RequireAuth>
      <Toaster position="bottom-right" />
    </AuthProvider>
  );
}
