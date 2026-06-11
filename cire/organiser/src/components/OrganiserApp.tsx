import { AuthProvider, useAuth } from "@osn/client/solid";
import { createEffect, createResource, Show, type ParentProps } from "solid-js";
import { Toaster } from "solid-toast";

import { apiUrl, isAuthExpired, redirectToLogin } from "../lib/api";
import { OSN_ISSUER_URL } from "../lib/osn";
import DashboardTabs from "./DashboardTabs";
import ImportPanel from "./ImportPanel";

interface WeddingSummary {
  id: string;
  slug: string;
  displayName: string;
}

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

function Dashboard() {
  const { authFetch, logout } = useAuth();

  const [weddings] = createResource<WeddingsState>(async () => {
    try {
      const res = await authFetch(apiUrl("/api/organiser/weddings"));
      if (res.status === 401) {
        redirectToLogin();
        return { kind: "ready", weddings: [] };
      }
      if (!res.ok) return { kind: "error", message: `Could not load weddings (${res.status}).` };
      const body = (await res.json()) as { weddings: WeddingSummary[] };
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
    const state = weddings();
    return state?.kind === "error" ? state.message : null;
  };
  const wedding = () => {
    const state = weddings();
    return state?.kind === "ready" ? state.weddings[0] : undefined;
  };
  const empty = () => {
    const state = weddings();
    return state?.kind === "ready" && state.weddings.length === 0;
  };

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

      <Show when={weddings()} fallback={<Loading label="Loading weddings…" />}>
        <Show when={loadError()}>
          {(message) => (
            <p class="border-error/20 bg-error/5 text-error rounded-sm border p-4 text-[0.88rem]">
              {message()}
            </p>
          )}
        </Show>

        <Show when={empty()}>
          <p class="border-border bg-surface/30 text-text-muted rounded-sm border p-6 text-[0.88rem]">
            No weddings are linked to your account yet. Contact support to get set up.
          </p>
        </Show>

        <Show when={wedding()}>
          {(w) => (
            <div class="flex flex-col gap-12">
              <p class="font-display text-gold-dim text-[1.2rem] italic">{w().displayName}</p>
              <ImportPanel />
              <DashboardTabs weddingId={w().id} />
            </div>
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
