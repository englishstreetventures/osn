import { AuthProvider, useAuth } from "@osn/client/solid";
import { createEffect, createResource, createSignal, Show, type ParentProps } from "solid-js";
import { Toaster } from "solid-toast";

import { apiUrl, isAuthExpired, redirectToLogin } from "../lib/api";
import { OSN_ISSUER_URL } from "../lib/osn";
import type { WeddingSummary } from "./CreateWeddingForm";
import DashboardTabs from "./DashboardTabs";
import ImportPanel from "./ImportPanel";
import PreviewInviteButton from "./PreviewInviteButton";
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
 *  view, now scoped to whichever wedding the organiser opened. */
function WeddingDashboard(props: { wedding: WeddingSummary; onBack: () => void }) {
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
          <p class="font-display text-gold-dim text-[1.2rem] italic">{props.wedding.displayName}</p>
          <PreviewInviteButton weddingId={props.wedding.id} />
        </div>
      </div>
      <ImportPanel weddingId={props.wedding.id} />
      <DashboardTabs weddingId={props.wedding.id} />
    </div>
  );
}

function Dashboard() {
  const { authFetch, logout } = useAuth();
  // Locally-tracked weddings so a freshly-created one shows up without a
  // refetch. Seeded from the initial load.
  const [weddings, setWeddings] = createSignal<WeddingSummary[] | null>(null);
  const [selectedId, setSelectedId] = createSignal<string | null>(null);

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
      <div class="flex justify-end">
        <button
          type="button"
          onClick={() => void signOut()}
          class="font-body text-text-muted hover:text-gold text-[0.82rem] tracking-[0.1em] uppercase underline-offset-4 transition hover:underline"
        >
          Sign out
        </button>
      </div>

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
