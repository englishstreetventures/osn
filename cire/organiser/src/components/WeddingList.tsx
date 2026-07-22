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
        <p class="border-border bg-surface/30 text-text-muted rounded-sm border p-6 text-[0.88rem]">
          You don&apos;t host any weddings yet. Create your first one to start adding guests,
          events, and the invite.
        </p>
      </Show>

      <Show when={!isEmpty()}>
        <ul class="grid grid-cols-1 gap-4 @lg/page:grid-cols-2">
          <For each={props.weddings}>
            {(wedding) => (
              <li class="flex">
                <button
                  type="button"
                  onClick={() => props.onSelect(wedding)}
                  class="border-border bg-surface/30 hover:border-gold-dim hover:bg-surface/60 group relative flex w-full flex-col gap-2 overflow-hidden rounded-sm border p-6 text-left transition-colors duration-(--dur-base) ease-(--ease-out)"
                >
                  {/* A gold rule that draws down the left edge on hover — the
                      same marker vocabulary the module rail uses for "you are
                      here", reused here for "this is the one you're reaching
                      for". Scale, so it costs no layout. */}
                  <span
                    aria-hidden="true"
                    class="bg-gold absolute inset-y-0 left-0 w-[2px] origin-top scale-y-0 transition-transform duration-(--dur-base) ease-(--ease-out) group-hover:scale-y-100"
                  />
                  <span class="font-body text-gold text-[0.7rem] tracking-[0.22em] uppercase">
                    {wedding.slug}
                  </span>
                  <span class="font-display text-text text-[1.5rem] leading-tight font-light">
                    {wedding.displayName}
                  </span>
                  <span class="font-body text-text-muted group-hover:text-gold mt-2 flex items-center gap-2 text-[0.72rem] tracking-[0.16em] uppercase transition-colors duration-(--dur-base)">
                    Open dashboard
                    <span
                      aria-hidden="true"
                      class="transition-transform duration-(--dur-base) ease-(--ease-out) group-hover:translate-x-1"
                    >
                      →
                    </span>
                  </span>
                </button>
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
    <button
      type="button"
      onClick={props.onClick}
      class="border-border text-text-muted hover:border-gold hover:text-gold font-body self-start rounded-sm border border-dashed px-4 py-2 text-[0.82rem] tracking-[0.1em] uppercase transition-colors"
    >
      + Create a wedding
    </button>
  );
}
