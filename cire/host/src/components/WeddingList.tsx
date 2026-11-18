import Button, { buttonClass } from "@cire/ui/button";
import { cardClass } from "@cire/ui/card";
import Eyebrow from "@cire/ui/eyebrow";
import { useAuth } from "@shared/rp-auth/solid";
import { Notice } from "@shared/ui/ui/notice";
import Plus from "lucide-solid/icons/plus";
import { createSignal, For, onMount, Show } from "solid-js";

import { isAuthExpired, redirectToLogin } from "../lib/api";
import { clearNamePrefill, readNamePrefill } from "../lib/name-prefill";
import { restoreUntilLabel, restoreWedding } from "../lib/wedding-lifecycle";
import CreateWeddingForm, {
  type DeletedWeddingSummary,
  MAX_DISPLAY_NAME,
  type WeddingSummary,
} from "./CreateWeddingForm";

const DELETED_ROW_CLASS = `${cardClass({ padding: "sm", fill: "none" })} flex-row flex-wrap items-center justify-between`;

/**
 * Landing view for the organiser portal: lists every wedding the signed-in
 * organiser hosts and lets them open one or create a new one. Selecting a
 * wedding is client-side island state (the parent renders the dashboard for the
 * chosen id) — no page navigation, so the auth context survives.
 *
 * A couple arriving from the marketing site's closing field come as
 * `/?name=<their names>`: the create form opens with the names in its field,
 * and the parameter leaves the address at once (`lib/name-prefill`).
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
  // The portal renders client-only (`client:only` in pages/index.astro), so
  // the address is always there to read.
  const arrivedWith = readNamePrefill(window.location.search, MAX_DISPLAY_NAME);
  // Spent by the first form it fills: a second "Create a wedding" opens empty.
  const [prefill, setPrefill] = createSignal(arrivedWith);
  const [creating, setCreating] = createSignal(arrivedWith !== null);

  onMount(() => {
    if (arrivedWith === null) return;
    history.replaceState(history.state, "", clearNamePrefill(new URL(window.location.href)));
  });

  const isEmpty = () => props.weddings.length === 0;

  function closeForm() {
    setPrefill(null);
    setCreating(false);
  }

  function handleCreated(wedding: WeddingSummary) {
    closeForm();
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
        <div class="auto-grid auto-rows-fr [--auto-grid-min:20rem]">
          {/* The list's box steps aside so its items are the grid's cells,
              and the empty slot after it is the next cell without being
              counted as a wedding. */}
          <ul class="contents">
            <For each={props.weddings}>
              {(wedding) => (
                <li class="flex">
                  <Button
                    variant="tile"
                    size="lg"
                    type="button"
                    onClick={() => props.onSelect(wedding)}
                    // A long wedding name wraps inside the tile rather than
                    // being cut off: `Button` holds a label to one line.
                    class="group relative flex w-full flex-col overflow-hidden text-left whitespace-normal"
                  >
                    {/* A gold rule that draws down the left edge on hover — the
                        same marker vocabulary the module rail uses for "you are
                        here", reused here for "this is the one you're reaching
                        for". Scale, so it costs no layout. */}
                    <span
                      aria-hidden="true"
                      class="bg-gold absolute inset-y-0 left-0 w-0.5 origin-top scale-y-0 transition-transform duration-(--dur-fast) ease-(--ease-out) group-hover:scale-y-100"
                    />
                    <span class="font-display text-text text-ui-lg leading-ui-tight font-light">
                      {wedding.displayName}
                    </span>
                    {/* The slug under the name, as the wedding switcher prints
                        it: the guest link's path, and what tells two weddings
                        of one name apart. Under the name, not over it, so it
                        reads as the name's detail rather than its label. */}
                    <span class="text-text-muted text-ui-xs tracking-ui-widest mt-1 uppercase">
                      {wedding.slug}
                    </span>
                    <span class="font-body text-text-muted group-hover:text-gold-ink text-ui-sm transition-ui-colors mt-2 flex items-center gap-2 duration-(--dur-fast) ease-(--ease-out)">
                      Open dashboard
                      <span
                        aria-hidden="true"
                        class="transition-transform duration-(--dur-fast) ease-(--ease-out) group-hover:translate-x-1"
                      >
                        →
                      </span>
                    </span>
                  </Button>
                </li>
              )}
            </For>
          </ul>
          {/* The empty slot stands in the grid's next cell, a tile the size of
              a wedding's (every row the height of the tallest), dashed because
              something appears there. */}
          <Show when={!creating()}>
            <div class="flex">
              <CreateAffordance onClick={() => setCreating(true)} />
            </div>
          </Show>
        </div>
      </Show>

      <Show when={(props.deleted ?? []).length > 0}>
        <RecentlyDeleted
          deleted={props.deleted ?? []}
          onRestored={(id) => props.onRestored?.(id)}
          onRestoreExpired={(id) => props.onRestoreExpired?.(id)}
        />
      </Show>

      <Show when={creating() || isEmpty()}>
        <CreateWeddingForm
          onCreated={handleCreated}
          onCancel={isEmpty() ? undefined : closeForm}
          initialName={prefill() ?? undefined}
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
      <Eyebrow as="h2" id="recently-deleted-title" tone="muted">
        Recently deleted
      </Eyebrow>
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
            <li class={DELETED_ROW_CLASS}>
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

/**
 * The empty slot: `dashed` drawn as a tile, the 14px field corner and a
 * wedding tile's size, its plus over its words in the secondary ink, which
 * turn readable gold under the pointer with the edge (DESIGN.md §4, One pill
 * language).
 */
function CreateAffordance(props: { onClick: () => void }) {
  // `buttonClass` on a native button rather than `Button`, because the tile
  // sets its own corner and room and `Button` owns both.
  return (
    <button
      type="button"
      onClick={() => props.onClick()}
      class={`${buttonClass({ variant: "dashed", size: "lg" })} rounded-ui-field w-full flex-col gap-2 py-6`}
    >
      <Plus aria-hidden="true" strokeWidth={1.75} class="size-4.5" />
      Create a wedding
    </button>
  );
}
