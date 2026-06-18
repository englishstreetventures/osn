import { AuthProvider, useAuth } from "@osn/client/solid";
import { createEffect, createResource, createSignal, Show, type ParentProps } from "solid-js";
import { Toaster } from "solid-toast";

import { apiUrl, isAuthExpired, redirectToLogin } from "../lib/api";
import { OSN_ISSUER_URL } from "../lib/osn";
import type { WeddingSummary } from "./CreateWeddingForm";
import DashboardTabs from "./DashboardTabs";
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

/** The chosen wedding's dashboard — the existing tabbed guests/events/invite
 *  view, now scoped to whichever wedding the organiser opened. Owner-only
 *  surfaces (spreadsheet import, the host-management actions) are gated on
 *  `isOwner`; a co-host gets the read/edit dashboard without them. */
function WeddingDashboard(props: { wedding: WeddingSummary; onBack: () => void }) {
  const isOwner = () => props.wedding.role === "owner";
  return (
    <div class="flex flex-col gap-12">
      <div class="flex flex-col gap-4">
        <button
          type="button"
          onClick={() => props.onBack()}
          class="font-body text-text-muted hover:text-gold self-start text-[0.78rem] tracking-[0.1em] uppercase underline-offset-4 transition hover:underline"
        >
          ← All weddings
        </button>
        <div class="flex flex-wrap items-center justify-between gap-4">
          <div class="flex items-center gap-3">
            <p class="font-display text-gold-dim text-[1.2rem] italic">
              {props.wedding.displayName}
            </p>
            <Show when={!isOwner()}>
              <span class="border-gold/40 text-gold font-body rounded-sm border px-2 py-0.5 text-[0.62rem] tracking-[0.16em] uppercase">
                Co-host
              </span>
            </Show>
          </div>
          <PreviewInviteButton weddingId={props.wedding.id} />
        </div>
      </div>
      <Show when={isOwner()}>
        <ImportPanel weddingId={props.wedding.id} />
      </Show>
      <DashboardTabs
        weddingId={props.wedding.id}
        weddingName={props.wedding.displayName}
        canManage={isOwner()}
      />
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
