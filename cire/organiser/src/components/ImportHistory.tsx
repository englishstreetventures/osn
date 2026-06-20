import { useAuth } from "@osn/client/solid";
import { createSignal, For, Show } from "solid-js";

import { apiUrl, isAuthExpired, redirectToLogin } from "../lib/api";
import { invalidateEvents } from "../lib/events-store";

/**
 * One row of the import list as returned by
 * `GET /api/organiser/weddings/:weddingId/import/list`. `summary` mirrors the
 * counts the API stores at preview time (see organiser-import.ts `/preview`);
 * an older row whose summary failed to parse comes back as `{}`, so every field
 * is optional and defaulted to 0 when we render.
 */
interface ImportSummaryCounts {
  eventCreates?: number;
  eventUpdates?: number;
  eventRemoves?: number;
  familyCreates?: number;
  familyRemoves?: number;
  guestCreates?: number;
  guestUpdates?: number;
  guestRemoves?: number;
}

type ImportStatus = "preview" | "applied" | "reverted";

interface ImportEntry {
  id: string;
  uploadedAt: number;
  format: string;
  status: ImportStatus;
  appliedAt: number | null;
  revertedAt: number | null;
  summary: ImportSummaryCounts;
}

interface ListResponse {
  imports: ImportEntry[];
  nextCursor: number | null;
}

const STATUS_LABEL: Record<ImportStatus, string> = {
  preview: "Preview only",
  applied: "Applied",
  reverted: "Reverted",
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
function summarise(s: ImportSummaryCounts): string {
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
 * The past-imports list with a per-entry one-click revert. Lives behind a native
 * <details> that lazy-loads the list the first time it's opened (and on demand
 * after a revert). Revert is offered only for `applied` entries; a successful
 * revert re-applies the predecessor import server-side, so we mirror Apply's
 * post-mutation refresh — drop the events cache + full reload — and re-fetch the
 * list so the row flips to "Reverted".
 *
 * Authorised exactly like the rest of the import surface (OSN access JWT +
 * wedding membership) — co-hosts get history + revert too, matching the
 * weddingMember()-gated backend routes.
 */
export default function ImportHistory(props: { weddingId: string }) {
  const { authFetch } = useAuth();
  const listUrl = () => apiUrl(`/api/organiser/weddings/${props.weddingId}/import/list`);
  const revertUrl = () => apiUrl(`/api/organiser/weddings/${props.weddingId}/import/revert`);

  const [entries, setEntries] = createSignal<ImportEntry[] | null>(null);
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
        throw new Error(body.error ?? `Could not load import history (${res.status})`);
      }
      const data = (await res.json()) as ListResponse;
      setEntries(data.imports);
      setLoaded(true);
    } catch (err) {
      if (isAuthExpired(err)) return redirectToLogin();
      setError(err instanceof Error ? err.message : "Could not load import history.");
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

  async function handleRevert(entry: ImportEntry) {
    if (entry.status !== "applied") return;
    const ok = window.confirm(
      "Revert this import? This re-applies the previous import — guests, families and events will be rolled back to that state.",
    );
    if (!ok) return;

    setRevertingId(entry.id);
    setError(null);
    try {
      const res = await authFetch(revertUrl(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ importId: entry.id }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `Revert failed (${res.status})`);
      }
      // Revert re-applies the predecessor import, so this wedding's events list
      // is now stale — drop the cache (mirrors Apply) so the Events tab refetches
      // …and a full reload re-pulls the (uncached) guest table too. We refresh
      // the list first so, if the reload is ever a no-op, the row still flips to
      // "Reverted".
      invalidateEvents(props.weddingId);
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
        Import history
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
          <p class="text-text-muted text-[0.85rem]">No imports yet.</p>
        </Show>

        <Show when={(entries()?.length ?? 0) > 0}>
          <ul class="flex flex-col gap-3">
            <For each={entries() ?? []}>
              {(entry) => {
                const reverting = () => revertingId() === entry.id;
                return (
                  <li class="border-border bg-surface/30 flex flex-col gap-2 rounded-sm border p-4 sm:flex-row sm:items-center sm:justify-between">
                    <div class="flex flex-col gap-1">
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

                    <Show when={entry.status === "applied"}>
                      <button
                        type="button"
                        onClick={() => void handleRevert(entry)}
                        disabled={revertingId() !== null}
                        aria-busy={reverting()}
                        class="border-gold/40 font-body text-gold hover:border-gold hover:bg-gold/10 shrink-0 self-start rounded-sm border px-4 py-2 text-[0.78rem] tracking-[0.1em] uppercase transition disabled:opacity-40 sm:self-auto"
                      >
                        {reverting() ? "Reverting…" : "Revert"}
                      </button>
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
