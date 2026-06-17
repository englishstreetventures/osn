import { useAuth } from "@osn/client/solid";
import { createSignal, Show } from "solid-js";

import { apiUrl, isAuthExpired, redirectToLogin } from "../lib/api";

export interface WeddingSummary {
  id: string;
  slug: string;
  displayName: string;
  /** Whether the signed-in organiser owns this wedding or only co-hosts it.
   *  Owners can manage hosts + destructive actions; co-hosts get read access. */
  role: "owner" | "host";
}

const MAX_DISPLAY_NAME = 120;

/**
 * Inline form to create a new wedding. POSTs the display name to
 * /api/organiser/weddings (owner = the signed-in organiser, derived server-side
 * from the OSN token) and hands the created wedding back to the parent so it can
 * update the list without a round-trip.
 */
export default function CreateWeddingForm(props: {
  onCreated: (wedding: WeddingSummary) => void;
  onCancel?: () => void;
}) {
  const { authFetch } = useAuth();
  const [name, setName] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  async function submit(e: Event) {
    e.preventDefault();
    const displayName = name().trim();
    if (!displayName) {
      setError("Give the wedding a name.");
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const res = await authFetch(apiUrl("/api/organiser/weddings"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ displayName }),
      });
      if (res.status === 401) {
        redirectToLogin();
        return;
      }
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `Could not create the wedding (${res.status}).`);
      }
      const body = (await res.json()) as { wedding: WeddingSummary };
      setName("");
      props.onCreated(body.wedding);
    } catch (err) {
      if (isAuthExpired(err)) {
        redirectToLogin();
        return;
      }
      setError(err instanceof Error ? err.message : "Could not create the wedding.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      class="border-border bg-surface/30 flex flex-col gap-4 rounded-sm border p-6"
      onSubmit={submit}
    >
      <div class="flex flex-col gap-1">
        <p class="font-body text-gold text-[0.72rem] tracking-[0.2em] uppercase">New wedding</p>
        <h2 class="font-display text-text text-[1.4rem] font-light italic">
          Start a new celebration
        </h2>
      </div>

      <label class="flex flex-col gap-1.5">
        <span class="font-body text-text-muted text-[0.72rem] tracking-[0.1em] uppercase">
          Wedding name
        </span>
        <input
          type="text"
          value={name()}
          maxLength={MAX_DISPLAY_NAME}
          placeholder="e.g. Nadia &amp; Sam"
          autocomplete="off"
          onInput={(e) => setName(e.currentTarget.value)}
          disabled={busy()}
          class="border-border bg-bg font-body text-text focus:border-gold rounded-sm border px-3 py-2 text-[0.95rem] transition-colors outline-none placeholder:opacity-40 disabled:opacity-40"
        />
      </label>

      <div class="flex flex-wrap items-center gap-3">
        <button
          type="submit"
          disabled={busy()}
          class="border-gold bg-gold font-body text-bg hover:bg-gold-dim rounded-sm border px-4 py-2 text-[0.82rem] tracking-[0.1em] uppercase transition disabled:opacity-40"
        >
          {busy() ? "Creating…" : "Create wedding"}
        </button>
        <Show when={props.onCancel}>
          <button
            type="button"
            onClick={() => props.onCancel?.()}
            disabled={busy()}
            class="font-body text-text-muted text-[0.82rem] underline-offset-4 hover:underline disabled:opacity-40"
          >
            Cancel
          </button>
        </Show>
      </div>

      <Show when={error()}>
        <p class="border-error/20 bg-error/5 text-error rounded-sm border p-4 text-[0.88rem]">
          {error()}
        </p>
      </Show>
    </form>
  );
}
