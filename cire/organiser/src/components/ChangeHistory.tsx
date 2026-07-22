import { useAuth } from "@osn/client/solid";
import { createSignal, For, Show } from "solid-js";

import { apiUrl, isAuthExpired, redirectToLogin } from "../lib/api";
import { invalidateEvents } from "../lib/events-store";
import { invalidateGuests } from "../lib/guests-store";

/**
 * One row of the change list as returned by
 * `GET /api/organiser/weddings/:weddingId/changes/list` (the E4 endpoint, still
 * mounted at the `/import` alias for one release). `summary` mirrors the counts
 * stored at preview time; an older row whose summary failed to parse comes back
 * as `{}`, so every count field is optional and defaulted to 0 when rendered.
 */
interface ChangeSummaryCounts {
  eventCreates?: number;
  eventUpdates?: number;
  eventRemoves?: number;
  familyCreates?: number;
  familyRemoves?: number;
  guestCreates?: number;
  guestUpdates?: number;
  guestRemoves?: number;
}

type ChangeStatus = "preview" | "applied" | "reverted";
type ChangeKind = "import" | "editor";

interface ChangeEntry {
  id: string;
  uploadedAt: number;
  format: string;
  status: ChangeStatus;
  /** `'import'` = spreadsheet upload, `'editor'` = in-app edit (E3/E4). */
  kind: ChangeKind;
  appliedAt: number | null;
  revertedAt: number | null;
  /** True when the change still has a usable before-image (E3). A row whose
   *  before-image aged out (prune-beyond-10) comes back false and is shown as
   *  non-revertable with a note. Legacy `undefined` ⇒ treated as false. */
  revertable?: boolean;
  summary: ChangeSummaryCounts;
}

interface ListResponse {
  imports: ChangeEntry[];
  nextCursor: number | null;
}

const STATUS_LABEL: Record<ChangeStatus, string> = {
  preview: "Preview only",
  applied: "Applied",
  reverted: "Reverted",
};

/** The change kind, labelled for the organiser — "Spreadsheet import" vs
 *  "In-app edit" (§8). */
const KIND_LABEL: Record<ChangeKind, string> = {
  import: "Spreadsheet import",
  editor: "In-app edit",
};

function formatDate(ms: number): string {
  try {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(ms));
  } catch {
    return new Date(ms).toISOString();
  }
}

/**
 * A compact human summary of a diff, e.g. "+12 guests, −2, 3 events updated".
 * Only non-zero buckets are mentioned; an empty diff reads "No changes".
 */
function summarise(s: ChangeSummaryCounts): string {
  const parts: string[] = [];
  const guestAdds = s.guestCreates ?? 0;
  const guestRemoves = s.guestRemoves ?? 0;
  const guestUpdates = s.guestUpdates ?? 0;
  const eventAdds = s.eventCreates ?? 0;
  const eventUpdates = s.eventUpdates ?? 0;
  const eventRemoves = s.eventRemoves ?? 0;
  const familyAdds = s.familyCreates ?? 0;
  const familyRemoves = s.familyRemoves ?? 0;

  if (guestAdds) parts.push(`+${guestAdds} guests`);
  if (guestRemoves) parts.push(`−${guestRemoves} guests`);
  if (guestUpdates) parts.push(`${guestUpdates} guests updated`);
  if (familyAdds) parts.push(`+${familyAdds} families`);
  if (familyRemoves) parts.push(`−${familyRemoves} families`);
  if (eventAdds) parts.push(`+${eventAdds} events`);
  if (eventUpdates) parts.push(`${eventUpdates} events updated`);
  if (eventRemoves) parts.push(`−${eventRemoves} events`);

  return parts.length > 0 ? parts.join(", ") : "No changes";
}

/**
 * The change-history list (E6 rebrand of the old ImportHistory) with a per-entry
 * one-click revert. Lists BOTH spreadsheet imports and in-app edits (labelled by
 * `kind`) behind a native <details> that lazy-loads the list the first time it's
 * opened (and on demand after a revert). Revert is offered only for `applied`
 * entries that still have a usable before-image (`revertable`); an applied entry
 * whose before-image aged out (prune-beyond-10) is shown non-revertable with a
 * note. A successful revert restores the before-image server-side, so we drop
 * the events + guests caches, reload, and re-fetch the list so the row flips to
 * "Reverted".
 *
 * Authorised exactly like the rest of the changes surface (OSN access JWT +
 * wedding editor role) — the backend gates `changes/*` with `weddingEditor()`.
 */
export default function ChangeHistory(props: { weddingId: string }) {
  const { authFetch } = useAuth();
  const listUrl = () => apiUrl(`/api/organiser/weddings/${props.weddingId}/changes/list`);
  const revertUrl = () => apiUrl(`/api/organiser/weddings/${props.weddingId}/changes/revert`);

  const [entries, setEntries] = createSignal<ChangeEntry[] | null>(null);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [revertingId, setRevertingId] = createSignal<string | null>(null);
  const [loaded, setLoaded] = createSignal(false);

  async function loadList() {
    setLoading(true);
    setError(null);
    try {
      const res = await authFetch(listUrl());
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `Could not load change history (${res.status})`);
      }
      const data = (await res.json()) as ListResponse;
      setEntries(data.imports);
      setLoaded(true);
    } catch (err) {
      if (isAuthExpired(err)) return redirectToLogin();
      setError(err instanceof Error ? err.message : "Could not load change history.");
    } finally {
      setLoading(false);
    }
  }

  function onToggle(e: Event) {
    // Lazy-load the first time the disclosure is opened.
    if ((e.currentTarget as HTMLDetailsElement).open && !loaded() && !loading()) {
      void loadList();
    }
  }

  async function handleRevert(entry: ChangeEntry) {
    if (entry.status !== "applied" || !entry.revertable) return;
    const ok = window.confirm(
      "Revert this change? Guests, households and events are restored to exactly the state before it was applied. RSVPs discarded by the change are not restored.",
    );
    if (!ok) return;

    setRevertingId(entry.id);
    setError(null);
    try {
      const res = await authFetch(revertUrl(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ changeId: entry.id, importId: entry.id }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `Revert failed (${res.status})`);
      }
      // Revert restores the before-image, so this wedding's caches are stale —
      // drop both, then a full reload re-pulls every module fresh. We refresh
      // the list first so the row flips to "Reverted" even if the reload no-ops.
      invalidateEvents(props.weddingId);
      invalidateGuests(props.weddingId);
      await loadList();
      window.location.reload();
    } catch (err) {
      if (isAuthExpired(err)) return redirectToLogin();
      setError(err instanceof Error ? err.message : "Revert failed.");
    } finally {
      setRevertingId(null);
    }
  }

  return (
    <details class="border-border bg-bg/30 group/history rounded-sm border" onToggle={onToggle}>
      <summary class="font-body text-text hover:text-gold flex cursor-pointer items-center gap-2 px-4 py-3 text-[0.88rem] transition select-none [&::-webkit-details-marker]:hidden">
        <span
          class="text-gold inline-block transition-transform group-open/history:rotate-90"
          aria-hidden
        >
          ›
        </span>
        Change history
      </summary>

      <div class="border-border/60 flex flex-col gap-4 border-t px-4 py-5">
        <Show when={error()}>
          <p class="border-error/20 bg-error/5 text-error rounded-sm border p-4 text-[0.88rem]">
            {error()}
          </p>
        </Show>

        <Show when={loading() && entries() === null}>
          <p class="text-text-muted text-[0.85rem]" aria-busy="true">
            Loading…
          </p>
        </Show>

        <Show when={loaded() && (entries()?.length ?? 0) === 0}>
          <p class="text-text-muted text-[0.85rem]">No changes yet.</p>
        </Show>

        <Show when={(entries()?.length ?? 0) > 0}>
          <ul class="flex flex-col gap-3">
            <For each={entries() ?? []}>
              {(entry) => {
                const reverting = () => revertingId() === entry.id;
                // An applied change that can no longer be reverted (before-image
                // pruned) shows an explanatory note instead of the button.
                const agedOut = () => entry.status === "applied" && !entry.revertable;
                return (
                  <li class="border-border bg-surface/30 flex flex-col gap-2 rounded-sm border p-4 @lg/panel:flex-row @lg/panel:items-center @lg/panel:justify-between">
                    <div class="flex flex-col gap-1">
                      <span class="font-body text-gold text-[0.62rem] tracking-[0.18em] uppercase">
                        {KIND_LABEL[entry.kind] ?? "Change"}
                      </span>
                      <span class="font-body text-text text-[0.88rem]">
                        {formatDate(entry.uploadedAt)}
                      </span>
                      <span class="text-text-muted text-[0.82rem]">{summarise(entry.summary)}</span>
                      <span
                        class="font-body text-[0.66rem] tracking-[0.18em] uppercase"
                        classList={{
                          "text-gold": entry.status === "applied",
                          "text-text-muted": entry.status !== "applied",
                        }}
                      >
                        {STATUS_LABEL[entry.status]}
                      </span>
                    </div>

                    <Show when={entry.status === "applied" && entry.revertable}>
                      <button
                        type="button"
                        onClick={() => void handleRevert(entry)}
                        disabled={revertingId() !== null}
                        aria-busy={reverting()}
                        class="border-gold/40 font-body text-gold hover:border-gold hover:bg-gold/10 shrink-0 self-start rounded-sm border px-4 py-2 text-[0.78rem] tracking-[0.1em] uppercase transition disabled:opacity-40 @lg/panel:self-auto"
                      >
                        {reverting() ? "Reverting…" : "Revert"}
                      </button>
                    </Show>

                    <Show when={agedOut()}>
                      <span
                        class="font-body text-text-muted shrink-0 self-start text-[0.72rem] italic @lg/panel:max-w-[12rem] @lg/panel:self-auto @lg/panel:text-right"
                        title="Only the ten most recent changes keep a restore point."
                      >
                        Restore point no longer available
                      </span>
                    </Show>
                  </li>
                );
              }}
            </For>
          </ul>
        </Show>
      </div>
    </details>
  );
}
