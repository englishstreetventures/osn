import { useAuth } from "@osn/client/solid";
import { createMemo, createResource, createSignal, For, Show } from "solid-js";

import { CreateEventForm } from "../components/CreateEventForm";
import { api } from "../lib/api";
import { showCreateForm, setShowCreateForm } from "../lib/createEventSignal";
import type { EventItem } from "../lib/types";
import { ExploreCard } from "./ExploreCard";
import { ExploreMap } from "./ExploreMap";
import { ExploreNav } from "./ExploreNav";
import { FilterRail } from "./FilterRail";
import { Icon } from "./icons";

import "./explore.css";

async function fetchEvents(accessToken: string | null): Promise<EventItem[]> {
  const headers: Record<string, string> = {};
  if (accessToken) headers["Authorization"] = `Bearer ${accessToken}`;
  const { data, error } = await api.events.get({ headers });
  if (error) throw error;
  return data!.events;
}

export function ExplorePage() {
  const { session } = useAuth();
  const accessToken = () => session()?.accessToken ?? null;
  const tokenSource = createMemo(() => ({ token: accessToken() }));
  const [events, { refetch }] = createResource(tokenSource, ({ token }) => fetchEvents(token));

  const [query, setQuery] = createSignal("");
  const [filter, setFilter] = createSignal("all");
  const [hoveredId, setHoveredId] = createSignal<string | null>(null);

  const filtered = createMemo(() => {
    let list = events() ?? [];
    const cat = filter();
    if (cat !== "all") {
      if (cat === "tonight") {
        const now = new Date();
        list = list.filter((e) => {
          const d = new Date(e.startTime);
          return d.getDate() === now.getDate() && d.getHours() >= 17;
        });
      } else if (cat === "free") {
        // Price not in API yet — show all for now
      } else {
        list = list.filter((e) => e.category === cat);
      }
    }
    const q = query().toLowerCase().trim();
    if (q) {
      list = list.filter(
        (e) =>
          e.title.toLowerCase().includes(q) ||
          (e.venue ?? "").toLowerCase().includes(q) ||
          (e.location ?? "").toLowerCase().includes(q) ||
          (e.createdByName ?? "").toLowerCase().includes(q),
      );
    }
    return list;
  });

  const liveEvents = createMemo(() => filtered().filter((e) => e.status === "ongoing"));
  const featured = createMemo(() => filtered().find((e) => e.status !== "ongoing") ?? null);
  const rest = createMemo(() => {
    const featId = featured()?.id;
    const liveIds = new Set(liveEvents().map((e) => e.id));
    return filtered().filter((e) => e.id !== featId && !liveIds.has(e.id));
  });

  function handleFormSuccess() {
    setShowCreateForm(false);
    refetch();
  }

  return (
    <div class="min-h-screen">
      <ExploreNav
        query={query()}
        onQueryChange={setQuery}
        eventCount={filtered().length || undefined}
        liveCount={liveEvents().length || undefined}
      />

      <Show when={showCreateForm()}>
        <div class="mx-auto max-w-3xl px-8 pt-6">
          <CreateEventForm
            accessToken={accessToken()}
            onSuccess={handleFormSuccess}
            onCancel={() => setShowCreateForm(false)}
          />
        </div>
      </Show>

      <div
        class="explore-body grid min-h-[60vh] gap-0"
        style={{ "grid-template-columns": "minmax(0, 1fr) 44%" }}
      >
        {/* Events pane */}
        <div class="min-w-0 px-8 pb-20 pt-6">
          <FilterRail active={filter()} onSelect={setFilter} />

          <Show when={events.loading}>
            <p class="py-16 text-center text-muted-foreground">Loading events…</p>
          </Show>

          <Show when={events.error}>
            <p class="py-16 text-center text-destructive">Failed to load events.</p>
          </Show>

          <Show when={!events.loading && !events.error}>
            {/* Happening now */}
            <Show when={liveEvents().length > 0}>
              <div class="mb-2.5 mt-6 flex items-baseline justify-between">
                <h2
                  class="m-0 text-[22px] font-normal"
                  style={{ "font-family": "var(--font-serif)", "letter-spacing": "-0.01em" }}
                >
                  Happening now
                </h2>
                <span
                  class="text-xs text-muted-foreground"
                  style={{ "font-family": "var(--font-mono)" }}
                >
                  {liveEvents().length} LIVE
                </span>
              </div>
              <div class="flex flex-col gap-3.5">
                <For each={liveEvents()}>
                  {(e) => (
                    <ExploreCard
                      event={e}
                      hovered={hoveredId() === e.id}
                      onMouseEnter={() => setHoveredId(e.id)}
                      onMouseLeave={() => setHoveredId(null)}
                    />
                  )}
                </For>
              </div>
            </Show>

            {/* On your radar (featured) */}
            <Show when={featured()}>
              {(feat) => (
                <>
                  <div class="mb-2.5 mt-6 flex items-baseline justify-between">
                    <h2
                      class="m-0 text-[22px] font-normal"
                      style={{ "font-family": "var(--font-serif)", "letter-spacing": "-0.01em" }}
                    >
                      On your radar
                    </h2>
                    <span class="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
                      View all <Icon name="chevron-right" size={11} />
                    </span>
                  </div>
                  <div class="flex flex-col gap-3.5">
                    <ExploreCard
                      event={feat()}
                      featured
                      hovered={hoveredId() === feat().id}
                      onMouseEnter={() => setHoveredId(feat().id)}
                      onMouseLeave={() => setHoveredId(null)}
                    />
                  </div>
                </>
              )}
            </Show>

            {/* More this week */}
            <Show when={rest().length > 0}>
              <div class="mb-2.5 mt-6 flex items-baseline justify-between">
                <h2
                  class="m-0 text-[22px] font-normal"
                  style={{ "font-family": "var(--font-serif)", "letter-spacing": "-0.01em" }}
                >
                  More this week
                </h2>
                <span
                  class="text-xs text-muted-foreground"
                  style={{ "font-family": "var(--font-mono)" }}
                >
                  {rest().length} events
                </span>
              </div>
              <div class="flex flex-col gap-3.5">
                <For each={rest()}>
                  {(e) => (
                    <ExploreCard
                      event={e}
                      hovered={hoveredId() === e.id}
                      onMouseEnter={() => setHoveredId(e.id)}
                      onMouseLeave={() => setHoveredId(null)}
                    />
                  )}
                </For>
              </div>
            </Show>

            {/* Empty state */}
            <Show when={filtered().length === 0 && !events.loading}>
              <div class="py-16 text-center text-muted-foreground">
                <div class="mb-1.5 text-[28px]" style={{ "font-family": "var(--font-serif)" }}>
                  Nothing here yet.
                </div>
                <div>Try a different filter or broaden your search.</div>
              </div>
            </Show>
          </Show>
        </div>

        {/* Map pane */}
        <aside class="explore-map-pane sticky top-0 h-screen border-l border-border bg-background">
          <ExploreMap events={filtered()} hoveredId={hoveredId()} onHoverEvent={setHoveredId} />
        </aside>
      </div>
    </div>
  );
}
