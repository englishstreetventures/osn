import Button from "@cire/ui/button";
import { createSignal, For, Show } from "solid-js";

import CreateWeddingForm, { type WeddingSummary } from "./CreateWeddingForm";

/**
 * Landing view for the organiser portal: lists every wedding the signed-in
 * organiser hosts and lets them open one or create a new one. Selecting a
 * wedding is client-side island state (the parent renders the dashboard for the
 * chosen id) — no page navigation, so the auth context survives.
 */
export default function WeddingList(props: {
  weddings: WeddingSummary[];
  onSelect: (wedding: WeddingSummary) => void;
  onCreated: (wedding: WeddingSummary) => void;
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
                  variant="quiet"
                  type="button"
                  onClick={() => props.onSelect(wedding)}
                  class="bg-surface/30 hover:bg-surface/60 group relative flex w-full flex-col gap-2 overflow-hidden p-6 text-left"
                >
                  {/* A gold rule that draws down the left edge on hover — the
                      same marker vocabulary the module rail uses for "you are
                      here", reused here for "this is the one you're reaching
                      for". Scale, so it costs no layout. */}
                  <span
                    aria-hidden="true"
                    class="bg-gold absolute inset-y-0 left-0 w-[2px] origin-top scale-y-0 transition-transform duration-(--dur-base) ease-(--ease-out) group-hover:scale-y-100"
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

function CreateAffordance(props: { onClick: () => void }) {
  return (
    <Button variant="quiet" type="button" onClick={props.onClick} class="self-start border-dashed">
      + Create a wedding
    </Button>
  );
}
