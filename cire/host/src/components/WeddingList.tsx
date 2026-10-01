import Button from "@cire/ui/button";
import { useAuth } from "@shared/rp-auth/solid";
import { Notice } from "@shared/ui/ui/notice";
import { createSignal, For, Show } from "solid-js";

import { isAuthExpired, redirectToLogin } from "../lib/api";
import { restoreUntilLabel, restoreWedding } from "../lib/wedding-lifecycle";
import CreateWeddingForm, {
  type DeletedWeddingSummary,
  type WeddingSummary,
} from "./CreateWeddingForm";

/**
 * Landing view for the organiser portal: lists every wedding the signed-in
 * organiser hosts and lets them open one or create a new one. Selecting a
 * wedding is client-side island state (the parent renders the dashboard for the
 * chosen id) — no page navigation, so the auth context survives.
 */
export default function WeddingList(props: {
  weddings: WeddingSummary[];
  /** The organiser's own deleted weddings that can still be restored. */
  deleted?: DeletedWeddingSummary[];
  onSelect: (wedding: WeddingSummary) => void;
  onCreated: (wedding: WeddingSummary) => void;
  /** A restore went through. */
  onRestored?: (weddingId: string) => void;
  /** The wedding can no longer be restored; drop it from the list. */
  onRestoreExpired?: (weddingId: string) => void;
}) {
  const [creating, setCreating] = createSignal(false);

  const isEmpty = () => props.weddings.length === 0;

  function handleCreated(wedding: WeddingSummary) {
    setCreating(false);
    props.onCreated(wedding);
  }

  return (
    <div class="flex flex-col gap-8">
      <Show when={isEmpty()}>
        <p class="border-border bg-surface/30 text-text-muted text-ui-base rounded-sm border p-6">
          You don&apos;t host any weddings yet. Create your first one to start adding guests,
          events, and the invite.
        </p>
      </Show>

      <Show when={!isEmpty()}>
        {/* Intrinsic columns rather than a `@lg/page` step: an organiser with
            six weddings gets three or four per row on a widescreen, and one on
            a phone, with no breakpoint list to keep in sync. */}
        <ul class="auto-grid [--auto-grid-min:20rem]">
          <For each={props.weddings}>
            {(wedding) => (
              <li class="flex">
                <Button
                  variant="tile"
                  size="lg"
                  type="button"
                  onClick={() => props.onSelect(wedding)}
                  class="group relative flex w-full flex-col overflow-hidden text-left"
                >
                  {/* A gold rule that draws down the left edge on hover — the
                      same marker vocabulary the module rail uses for "you are
                      here", reused here for "this is the one you're reaching
                      for". Scale, so it costs no layout. */}
                  <span
                    aria-hidden="true"
                    class="bg-gold absolute inset-y-0 left-0 w-0.5 origin-top scale-y-0 transition-transform duration-(--dur-base) ease-(--ease-out) group-hover:scale-y-100"
                  />
                  <span class="font-body text-gold text-ui-xs tracking-ui-ultra uppercase">
                    {wedding.slug}
                  </span>
                  <span class="font-display text-text text-ui-lg leading-tight font-light">
                    {wedding.displayName}
                  </span>
                  <span class="font-body text-text-muted group-hover:text-gold text-ui-xs tracking-ui-widest mt-2 flex items-center gap-2 uppercase transition-colors duration-(--dur-base)">
                    Open dashboard
                    <span
                      aria-hidden="true"
                      class="transition-transform duration-(--dur-base) ease-(--ease-out) group-hover:translate-x-1"
                    >
                      →
                    </span>
                  </span>
                </Button>
              </li>
            )}
          </For>
        </ul>
      </Show>

      <Show when={(props.deleted ?? []).length > 0}>
        <RecentlyDeleted
          deleted={props.deleted ?? []}
          onRestored={(id) => props.onRestored?.(id)}
          onRestoreExpired={(id) => props.onRestoreExpired?.(id)}
        />
      </Show>

      <Show
        when={creating() || isEmpty()}
        fallback={<CreateAffordance onClick={() => setCreating(true)} />}
      >
        <CreateWeddingForm
          onCreated={handleCreated}
          onCancel={isEmpty() ? undefined : () => setCreating(false)}
        />
      </Show>
    </div>
  );
}

/**
 * Weddings this organiser deleted as an owner, each restorable until its date.
 * Restoring puts everything back as it was, guests' links and codes included.
 */
function RecentlyDeleted(props: {
  deleted: DeletedWeddingSummary[];
  onRestored: (weddingId: string) => void;
  onRestoreExpired: (weddingId: string) => void;
}) {
  const { authFetch } = useAuth();
  const [busyId, setBusyId] = createSignal<string | null>(null);
  const [error, setError] = createSignal<string | null>(null);

  async function restore(wedding: DeletedWeddingSummary) {
    if (busyId()) return;
    setBusyId(wedding.id);
    setError(null);
    try {
      const outcome = await restoreWedding(authFetch, wedding.id);
      if (outcome.ok) {
        props.onRestored(wedding.id);
        return;
      }
      setError(outcome.message);
      if (outcome.gone) props.onRestoreExpired(wedding.id);
    } catch (err) {
      if (isAuthExpired(err)) {
        redirectToLogin();
        return;
      }
      setError("Could not restore the wedding. Check your connection and try again.");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section aria-labelledby="recently-deleted-title" class="flex flex-col gap-3">
      <h2
        id="recently-deleted-title"
        class="font-body text-text-muted text-ui-xs tracking-ui-wider uppercase"
      >
        Recently deleted
      </h2>
      <Show when={error()}>
        {(message) => (
          <Notice tone="danger" alert>
            {message()}
          </Notice>
        )}
      </Show>
      <ul class="flex flex-col gap-2">
        <For each={props.deleted}>
          {(wedding) => (
            <li class="border-border flex flex-wrap items-center justify-between gap-3 rounded-sm border px-4 py-3">
              <span class="flex flex-col">
                <span class="font-display text-text text-ui-md font-light">
                  {wedding.displayName}
                </span>
                <span class="font-body text-text-muted text-ui-sm">
                  Deleted — you can restore it until {restoreUntilLabel(wedding.restoreUntil)}.
                </span>
              </span>
              <Button
                variant="outline"
                type="button"
                disabled={busyId() !== null}
                onClick={() => void restore(wedding)}
              >
                {busyId() === wedding.id ? "Restoring…" : "Restore"}
              </Button>
            </li>
          )}
        </For>
      </ul>
    </section>
  );
}

function CreateAffordance(props: { onClick: () => void }) {
  return (
    <Button variant="dashed" type="button" onClick={props.onClick} class="self-start">
      + Create a wedding
    </Button>
  );
}
