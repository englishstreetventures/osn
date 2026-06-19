import { AuthProvider, useAuth } from "@osn/client/solid";
import {
  createEffect,
  createResource,
  createSignal,
  onCleanup,
  onMount,
  type ParentProps,
  Show,
} from "solid-js";
import { Toaster } from "solid-toast";

import { apiUrl, isAuthExpired, redirectToLogin } from "../lib/api";
import {
  type DashboardRoute,
  type DashboardTab,
  isDashboardTab,
  LIST_ROUTE,
  parseRoute,
  serializeRoute,
} from "../lib/dashboard-route";
import { OSN_ISSUER_URL } from "../lib/osn";
import type { WeddingSummary } from "./CreateWeddingForm";
import DashboardTabs from "./DashboardTabs";
import GettingStarted from "./GettingStarted";
import ImportPanel from "./ImportPanel";
import PreviewInviteButton from "./PreviewInviteButton";
import SecurityPanel from "./SecurityPanel";
import WeddingList from "./WeddingList";

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
    <Show when={session()} fallback={<Loading label="Checking session…" />}>
      {props.children}
    </Show>
  );
}

/** The chosen wedding's dashboard — the context header, the Getting-started
 *  checklist, the spreadsheet import, and the tabbed events/guests/invite view,
 *  scoped to whichever wedding the organiser opened. Co-hosts are trusted
 *  co-organisers: they get the full read/edit dashboard, including the
 *  spreadsheet import (the API gates it with weddingMember). Only the owner-only
 *  management actions (managing co-hosts, re-minting codes) stay gated on
 *  `isOwner` — passed down via `canManage`.
 *
 *  The active tab is fully controlled by the parent (URL-hash driven) so a deep
 *  link / hard refresh restores the exact tab; the dashboard reports tab changes
 *  back up via `onTab`, and offers a checklist jump that switches tab + scrolls. */
function WeddingDashboard(props: {
  wedding: WeddingSummary;
  /** Active tab as an accessor so it stays reactive across hash changes even
   *  while the same wedding object stays selected. */
  tab: () => DashboardTab;
  onTab: (tab: DashboardTab) => void;
  onBack: () => void;
}) {
  const isOwner = () => props.wedding.role === "owner";

  /** Move to a tab from the Getting-started checklist: switch the panel (via the
   *  parent's hash update) and scroll the tab strip into view. */
  function jumpToTab(tab: string) {
    if (!isDashboardTab(tab)) return;
    props.onTab(tab);
    if (typeof document !== "undefined") {
      document
        .getElementById("wedding-tabs")
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }

  return (
    <div class="flex flex-col gap-10">
      {/* ── Wedding context header — "which wedding am I editing" + the two
          things every organiser wants up top: preview it, share it. ───────── */}
      <header class="flex flex-col gap-4">
        <button
          type="button"
          onClick={() => props.onBack()}
          class="font-body text-text-muted hover:text-gold self-start text-[0.78rem] tracking-[0.1em] uppercase underline-offset-4 transition hover:underline"
        >
          ← All weddings
        </button>
        <div class="flex flex-wrap items-end justify-between gap-4">
          <div class="flex flex-col gap-1">
            <span class="font-body text-gold text-[0.72rem] tracking-[0.2em] uppercase">
              {props.wedding.slug}
            </span>
            <div class="flex flex-wrap items-center gap-3">
              <h1 class="font-display text-text text-[1.8rem] leading-none font-light italic">
                {props.wedding.displayName}
              </h1>
              <span
                class="border-gold/40 text-gold font-body rounded-sm border px-2 py-0.5 text-[0.62rem] tracking-[0.16em] uppercase"
                title={
                  isOwner()
                    ? "You created this wedding and manage who hosts it"
                    : "You can view and edit this wedding"
                }
              >
                {isOwner() ? "Owner" : "Co-host"}
              </span>
            </div>
          </div>
          <PreviewInviteButton weddingId={props.wedding.id} />
        </div>
      </header>

      {/* The progress checklist — the dashboard's "what next". Reflects real
          state and links straight to the relevant tab. */}
      <GettingStarted weddingId={props.wedding.id} onJump={jumpToTab} />

      {/* Import is available to every member (owner or co-host) — the API
          authorises it with weddingMember(). Tucked in a collapsible so it's
          front-and-centre for a new wedding (open it from a checklist nudge) but
          doesn't crowd the dashboard once the list is populated. */}
      <ImportPanel weddingId={props.wedding.id} />

      <div id="wedding-tabs" class="scroll-mt-6">
        <DashboardTabs
          weddingId={props.wedding.id}
          weddingName={props.wedding.displayName}
          weddingSlug={props.wedding.slug}
          canManage={isOwner()}
          tab={props.tab()}
          onTab={props.onTab}
        />
      </div>
    </div>
  );
}

const navClass = (active: boolean) =>
  `font-body text-[0.82rem] tracking-[0.1em] uppercase underline-offset-4 transition ${
    active ? "text-gold" : "text-text-muted hover:text-gold hover:underline"
  }`;

function initialRoute(): DashboardRoute {
  if (typeof window === "undefined") return LIST_ROUTE;
  return parseRoute(window.location.hash);
}

function Dashboard() {
  const { authFetch, logout } = useAuth();
  // Locally-tracked weddings so a freshly-created one shows up without a
  // refetch. Seeded from the initial load.
  const [weddings, setWeddings] = createSignal<WeddingSummary[] | null>(null);

  // The single source of navigable state: top-level view + selected wedding +
  // active tab, mirrored into the URL hash so a hard refresh restores it and a
  // shared link reopens it. Seeded from the hash on first paint.
  const [route, setRouteSignal] = createSignal<DashboardRoute>(initialRoute());

  // Write the hash with replaceState by default (tab switches) so they don't
  // pile up history entries; explicit navigations (open a wedding, go back to
  // the list, switch view) push so Back/Forward walks them. Either way the URL
  // stays the source of truth and a manual edit or browser Back/Forward
  // re-syncs via the hashchange listener below.
  function setRoute(next: DashboardRoute, mode: "push" | "replace" = "replace") {
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
    if (next === "security") setRoute({ view: "security", weddingId: null, tab: "events" }, "push");
    else setRoute(LIST_ROUTE, "push");
  }

  function selectWedding(wedding: WeddingSummary) {
    setRoute({ view: "weddings", weddingId: wedding.id, tab: "events" }, "push");
  }

  function backToList() {
    setRoute(LIST_ROUTE, "push");
  }

  function selectTab(tab: DashboardTab) {
    const r = route();
    if (r.view !== "weddings" || r.weddingId === null) return;
    setRoute({ view: "weddings", weddingId: r.weddingId, tab }, "replace");
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

  return (
    <div class="flex flex-col gap-8">
      <div class="flex flex-wrap items-center justify-between gap-4">
        <nav class="flex items-center gap-5" aria-label="Portal sections">
          <button
            type="button"
            onClick={() => selectView("weddings")}
            aria-current={view() === "weddings" ? "page" : undefined}
            class={navClass(view() === "weddings")}
          >
            Weddings
          </button>
          <button
            type="button"
            onClick={() => selectView("security")}
            aria-current={view() === "security" ? "page" : undefined}
            class={navClass(view() === "security")}
          >
            Security
          </button>
        </nav>
        <button
          type="button"
          onClick={() => void signOut()}
          class="font-body text-text-muted hover:text-gold text-[0.82rem] tracking-[0.1em] uppercase underline-offset-4 transition hover:underline"
        >
          Sign out
        </button>
      </div>

      <Show when={view() === "security"}>
        <SecurityPanel />
      </Show>

      <Show when={view() === "weddings"}>
        <Show when={loaded()} fallback={<Loading label="Loading weddings…" />}>
          <Show when={loadError()}>
            {(message) => (
              <p class="border-error/20 bg-error/5 text-error rounded-sm border p-4 text-[0.88rem]">
                {message()}
              </p>
            )}
          </Show>

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
                    tab={() => {
                      const r = route();
                      return r.view === "weddings" ? r.tab : "events";
                    }}
                    onTab={selectTab}
                    onBack={backToList}
                  />
                )}
              </Show>
            )}
          </Show>
        </Show>
      </Show>
    </div>
  );
}

/**
 * Single root island for the dashboard page. Astro pages cannot share a
 * SolidJS context across islands, so AuthProvider wraps everything here.
 */
export default function OrganiserApp() {
  return (
    <AuthProvider config={{ issuerUrl: OSN_ISSUER_URL }}>
      <RequireAuth>
        <Dashboard />
      </RequireAuth>
      <Toaster position="bottom-right" />
    </AuthProvider>
  );
}
