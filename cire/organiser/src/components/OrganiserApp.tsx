import { AuthProvider, useAuth } from "@osn/client/solid";
import { createEffect, createResource, createSignal, Show, type ParentProps } from "solid-js";
import { Toaster } from "solid-toast";

import { apiUrl, isAuthExpired, redirectToLogin } from "../lib/api";
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

/** Move the tabs to `tab` — the tabs listen for `hashchange`, so updating the
 *  hash (and dispatching the event for same-value jumps) switches the panel and
 *  scrolls it into view. Used by the Getting-started checklist's step buttons. */
function jumpToTab(tab: string) {
  if (typeof window === "undefined") return;
  window.location.hash = tab;
  window.dispatchEvent(new HashChangeEvent("hashchange"));
  document.getElementById("wedding-tabs")?.scrollIntoView({ behavior: "smooth", block: "start" });
}

/** The chosen wedding's dashboard — the context header, the Getting-started
 *  checklist, the spreadsheet import, and the tabbed events/guests/invite view,
 *  scoped to whichever wedding the organiser opened. Co-hosts are trusted
 *  co-organisers: they get the full read/edit dashboard, including the
 *  spreadsheet import (the API gates it with weddingMember). Only the owner-only
 *  management actions (managing co-hosts, re-minting codes) stay gated on
 *  `isOwner` — passed down via `canManage`. */
function WeddingDashboard(props: { wedding: WeddingSummary; onBack: () => void }) {
  const isOwner = () => props.wedding.role === "owner";

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
        />
      </div>
    </div>
  );
}

type DashboardView = "weddings" | "security";

const navClass = (active: boolean) =>
  `font-body text-[0.82rem] tracking-[0.1em] uppercase underline-offset-4 transition ${
    active ? "text-gold" : "text-text-muted hover:text-gold hover:underline"
  }`;

function initialView(): DashboardView {
  if (typeof window === "undefined") return "weddings";
  return window.location.hash.replace("#", "") === "security" ? "security" : "weddings";
}

function Dashboard() {
  const { authFetch, logout } = useAuth();
  // Locally-tracked weddings so a freshly-created one shows up without a
  // refetch. Seeded from the initial load.
  const [weddings, setWeddings] = createSignal<WeddingSummary[] | null>(null);
  const [selectedId, setSelectedId] = createSignal<string | null>(null);
  // Top-level view: the wedding list/dashboard, or the account security
  // (devices / passkeys) panel. Security is reachable whenever signed in,
  // independent of any wedding selection.
  const [view, setView] = createSignal<DashboardView>(initialView());

  function selectView(next: DashboardView) {
    setView(next);
    if (typeof window !== "undefined") {
      history.replaceState(null, "", next === "security" ? "#security" : "#");
    }
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

  const selected = () => {
    const id = selectedId();
    return weddings()?.find((w) => w.id === id) ?? null;
  };

  function handleCreated(wedding: WeddingSummary) {
    setWeddings((prev) => [...(prev ?? []), wedding]);
    // Open the new wedding straight away — the organiser just made it to fill
    // it in.
    setSelectedId(wedding.id);
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
                    onSelect={(w) => setSelectedId(w.id)}
                    onCreated={handleCreated}
                  />
                }
              >
                {(wedding) => (
                  <WeddingDashboard wedding={wedding()} onBack={() => setSelectedId(null)} />
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
