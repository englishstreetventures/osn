import { Badge } from "@osn/ui/ui/badge";
import { Card } from "@osn/ui/ui/card";
import { A } from "@solidjs/router";
import { createSignal, For, onCleanup, onMount, Show } from "solid-js";

import { formatPrice } from "../lib/formatPrice";
import type { VenueEvent } from "../lib/venues";

interface Props {
  events: VenueEvent[];
  heading?: string;
}

/**
 * Format a date as "Fri 7 Jun · 22:00" in the user's local time. The
 * carousel is more about scanning than timezone fidelity — the
 * detailed page handles the canonical venue time.
 */
function formatCardDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Horizontal carousel of upcoming events at the venue.
 *
 * Implementation notes:
 * - Native CSS scroll-snap drives the snap behaviour; no JS for momentum
 *   or touch handling.
 * - The prev/next chevrons scroll by the visible width using
 *   `scrollBy({ left: ±el.clientWidth, behavior: "smooth" })` — the
 *   minimum JS needed to make the buttons functional. The buttons hide
 *   when there are too few cards to scroll.
 * - Buttons are rendered for pointer users; keyboard + touch users
 *   reach the same content via tab + native scroll.
 */
export function VenueEventCarousel(props: Props) {
  let scrollerEl: HTMLDivElement | undefined;
  const [needsScroll, setNeedsScroll] = createSignal(false);

  const recomputeNeedsScroll = () => {
    if (!scrollerEl) return;
    setNeedsScroll(scrollerEl.scrollWidth > scrollerEl.clientWidth + 1);
  };

  onMount(() => {
    recomputeNeedsScroll();
    if (typeof ResizeObserver !== "undefined" && scrollerEl) {
      const ro = new ResizeObserver(recomputeNeedsScroll);
      ro.observe(scrollerEl);
      onCleanup(() => ro.disconnect());
    }
  });

  const scrollByPage = (dir: 1 | -1) => {
    if (!scrollerEl) return;
    scrollerEl.scrollBy({ left: dir * scrollerEl.clientWidth, behavior: "smooth" });
  };

  return (
    <section class="flex flex-col gap-3">
      <Show when={props.heading}>
        {(h) => (
          <div class="flex items-center justify-between">
            <h2 class="text-xl">{h()}</h2>
            <Show when={needsScroll()}>
              <div class="flex gap-1.5">
                <button
                  type="button"
                  aria-label="Scroll programme left"
                  onClick={() => scrollByPage(-1)}
                  class="border-border/60 hover:bg-accent inline-flex h-8 w-8 items-center justify-center rounded-full border"
                >
                  <Chevron direction="left" />
                </button>
                <button
                  type="button"
                  aria-label="Scroll programme right"
                  onClick={() => scrollByPage(1)}
                  class="border-border/60 hover:bg-accent inline-flex h-8 w-8 items-center justify-center rounded-full border"
                >
                  <Chevron direction="right" />
                </button>
              </div>
            </Show>
          </div>
        )}
      </Show>
      <div
        ref={scrollerEl}
        class="venue-carousel flex snap-x snap-mandatory gap-3 overflow-x-auto pb-2"
      >
        <For
          each={props.events}
          fallback={
            <p class="text-muted-foreground py-8 text-sm">No upcoming events programmed yet.</p>
          }
        >
          {(event) => (
            <A href={`/events/${event.id}`} class="block w-64 shrink-0 snap-start hover:opacity-95">
              <Card class="overflow-hidden">
                <Show when={event.imageUrl}>
                  <img class="h-32 w-full object-cover" src={event.imageUrl!} alt={event.title} />
                </Show>
                <div class="p-3">
                  <div class="mb-1 flex items-center gap-2">
                    <Show when={event.category}>
                      <Badge variant="secondary" class="tracking-wide uppercase">
                        {event.category}
                      </Badge>
                    </Show>
                    <Badge variant="outline">
                      {formatPrice(event.priceAmount, event.priceCurrency)}
                    </Badge>
                  </div>
                  <p class="line-clamp-2 text-sm font-semibold">{event.title}</p>
                  <p class="text-muted-foreground mt-1 font-mono text-[11px] tracking-wide">
                    {formatCardDate(event.startTime)}
                  </p>
                </div>
              </Card>
            </A>
          )}
        </For>
      </div>
    </section>
  );
}

function Chevron(props: { direction: "left" | "right" }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d={props.direction === "left" ? "M15 18l-6-6 6-6" : "M9 6l6 6-6 6"} />
    </svg>
  );
}
