import { useAuth } from "@osn/client/solid";
import { createMemo, createResource, createSignal, For, Show } from "solid-js";

import { CreateEventForm } from "../components/CreateEventForm";
import { api } from "../lib/api";
import { showCreateForm, setShowCreateForm } from "../lib/createEventSignal";
import type { EventItem } from "../lib/types";
import {
  DiscoveryFilters,
  emptyFilters,
  hasActiveFilters,
  type DiscoveryFilterValues,
} from "./DiscoveryFilters";
import { ExploreCard } from "./ExploreCard";
import { ExploreMap } from "./ExploreMap";
import { ExploreNav } from "./ExploreNav";
import { FilterRail } from "./FilterRail";
import { Icon } from "./icons";

import "./explore.css";

// Default currency for the "Free" filter / price bounds until the Pulse
// user currency preference ships. Free-events filter uses `priceMax=0`
// which matches null-priced rows regardless of currency, so this default
// only ever matters when the user sets an explicit non-zero bound in
// the More filters drawer.
const DEFAULT_CURRENCY = "USD";

interface DiscoveryQuery {
  category?: string;
  from?: string;
  to?: string;
  lat?: number;
  lng?: number;
  radiusKm?: number;
  priceMin?: number;
  priceMax?: number;
  currency?: string;
  friendsOnly?: boolean;
}

interface DiscoveryResponse {
  events: EventItem[];
  nextCursor: { startTime: string; id: string } | null;
  series: Record<string, { id: string; title: string }>;
}

// Translate the filter chip selection into a discovery query fragment.
// The drawer's advanced filters are merged on top and overwrite any
// overlaps (e.g. explicit `from`/`to` replace "tonight").
function chipToQuery(chip: string): DiscoveryQuery {
  if (chip === "all") return {};
  if (chip === "tonight") {
    const now = new Date();
    const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0);
    return { to: endOfDay.toISOString() };
  }
  if (chip === "free") {
    return { priceMax: 0, currency: DEFAULT_CURRENCY };
  }
  return { category: chip };
}

function mergeAdvanced(base: DiscoveryQuery, v: DiscoveryFilterValues): DiscoveryQuery {
  const merged: DiscoveryQuery = { ...base };
  if (v.from) merged.from = new Date(v.from).toISOString();
  if (v.to) merged.to = new Date(v.to).toISOString();
  if (v.priceMin != null) {
    merged.priceMin = v.priceMin;
    merged.currency ??= DEFAULT_CURRENCY;
  }
  if (v.priceMax != null) {
    merged.priceMax = v.priceMax;
    merged.currency ??= DEFAULT_CURRENCY;
  }
  if (v.friendsOnly) merged.friendsOnly = true;
  // Radius requires a centre point; the user resolves coords explicitly
  // via the "Use my location" button in the drawer (S-L2/P-W2 — never
  // implicit). Without coords we drop the radius silently — the drawer
  // copy makes the requirement clear.
  if (v.radiusKm != null && v.coords) {
    merged.radiusKm = v.radiusKm;
    merged.lat = v.coords.lat;
    merged.lng = v.coords.lng;
  }
  return merged;
}

async function fetchDiscovery(
  accessToken: string | null,
  q: DiscoveryQuery,
): Promise<DiscoveryResponse> {
  const query: Record<string, string> = {};
  if (q.category) query.category = q.category;
  if (q.from) query.from = q.from;
  if (q.to) query.to = q.to;
  if (q.priceMin != null) query.priceMin = String(q.priceMin);
  if (q.priceMax != null) query.priceMax = String(q.priceMax);
  if (q.currency) query.currency = q.currency;
  if (q.friendsOnly) query.friendsOnly = "true";
  if (q.radiusKm != null && q.lat != null && q.lng != null) {
    query.lat = String(q.lat);
    query.lng = String(q.lng);
    query.radiusKm = String(q.radiusKm);
  }
  const headers: Record<string, string> = {};
  if (accessToken) headers["Authorization"] = `Bearer ${accessToken}`;
  const { data, error } = await api.events.discover.get({ query, headers });
  if (error) throw error;
  const body = data;
  // The Eden client types the response as a union of success / error
  // shapes. Success shape has `events`; error shapes have `error` or
  // `message`. Treat the narrowed error shapes as a thrown failure so
  // the resource goes into its error state.
  if (!body || !("events" in body) || !Array.isArray(body.events)) {
    const reason =
      body && "error" in body
        ? body.error
        : body && "message" in body
          ? body.message
          : "Unknown discovery error";
    throw new Error(String(reason));
  }
  return {
    events: body.events as EventItem[],
    nextCursor: body.nextCursor ?? null,
    series: body.series ?? {},
  };
}

export function ExplorePage() {
  const { session } = useAuth();
  const accessToken = () => session()?.accessToken ?? null;

  const [chip, setChip] = createSignal("all");
  const [advanced, setAdvanced] = createSignal<DiscoveryFilterValues>(emptyFilters());
  const [moreFiltersOpen, setMoreFiltersOpen] = createSignal(false);

  const query = createMemo(() => mergeAdvanced(chipToQuery(chip()), advanced()));

  const fetchSource = createMemo(() => ({ token: accessToken(), q: query() }));
  const [discovery, { refetch }] = createResource(fetchSource, ({ token, q }) =>
    fetchDiscovery(token, q),
  );

  const [searchQuery, setSearchQuery] = createSignal("");
  const [hoveredId, setHoveredId] = createSignal<string | null>(null);

  // Free-text search stays client-side for now — it runs over the page
  // returned by the server, not the whole catalogue. Server-side search
  // is a separate TODO (see wiki/TODO.md → Pulse).
  const filtered = createMemo(() => {
    const list = discovery()?.events ?? [];
    const q = searchQuery().toLowerCase().trim();
    if (!q) return list;
    return list.filter(
      (e) =>
        e.title.toLowerCase().includes(q) ||
        (e.venue ?? "").toLowerCase().includes(q) ||
        (e.location ?? "").toLowerCase().includes(q) ||
        (e.createdByName ?? "").toLowerCase().includes(q),
    );
  });

  const liveEvents = createMemo(() => filtered().filter((e) => e.status === "ongoing"));
  const featured = createMemo(() => filtered().find((e) => e.status !== "ongoing") ?? null);
  const rest = createMemo(() => {
    const featId = featured()?.id;
    const liveIds = new Set(liveEvents().map((e) => e.id));
    return filtered().filter((e) => e.id !== featId && !liveIds.has(e.id));
  });
  const seriesMap = createMemo(() => discovery()?.series ?? {});

  function handleFormSuccess() {
    setShowCreateForm(false);
    refetch();
  }

  return (
    <div class="min-h-screen">
      <ExploreNav
        query={searchQuery()}
        onQueryChange={setSearchQuery}
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

      <DiscoveryFilters
        open={moreFiltersOpen()}
        onOpenChange={setMoreFiltersOpen}
        signedIn={!!session()}
        value={advanced()}
        onApply={setAdvanced}
      />

      <div
        class="explore-body grid min-h-[60vh] gap-0"
        style={{ "grid-template-columns": "minmax(0, 1fr) 44%" }}
      >
        {/* Events pane */}
        <div class="min-w-0 px-8 pt-6 pb-20">
          <FilterRail
            active={chip()}
            onSelect={setChip}
            onOpenMoreFilters={() => setMoreFiltersOpen(true)}
            moreFiltersActive={hasActiveFilters(advanced())}
          />

          <Show when={discovery.loading}>
            <p class="text-muted-foreground py-16 text-center">Loading events…</p>
          </Show>

          <Show when={discovery.error}>
            <p class="text-destructive py-16 text-center">Failed to load events.</p>
          </Show>

          <Show when={!discovery.loading && !discovery.error}>
            {/* Happening now */}
            <Show when={liveEvents().length > 0}>
              <div class="mt-6 mb-2.5 flex items-baseline justify-between">
                <h2
                  class="m-0 text-[22px] font-normal"
                  style={{ "font-family": "var(--font-serif)", "letter-spacing": "-0.01em" }}
                >
                  Happening now
                </h2>
                <span
                  class="text-muted-foreground text-xs"
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
                      series={e.seriesId ? (seriesMap()[e.seriesId] ?? null) : null}
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
                  <div class="mt-6 mb-2.5 flex items-baseline justify-between">
                    <h2
                      class="m-0 text-[22px] font-normal"
                      style={{ "font-family": "var(--font-serif)", "letter-spacing": "-0.01em" }}
                    >
                      On your radar
                    </h2>
                    <span class="text-muted-foreground hover:text-foreground cursor-pointer text-xs">
                      View all <Icon name="chevron-right" size={11} />
                    </span>
                  </div>
                  <div class="flex flex-col gap-3.5">
                    <ExploreCard
                      event={feat()}
                      series={feat().seriesId ? (seriesMap()[feat().seriesId!] ?? null) : null}
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
              <div class="mt-6 mb-2.5 flex items-baseline justify-between">
                <h2
                  class="m-0 text-[22px] font-normal"
                  style={{ "font-family": "var(--font-serif)", "letter-spacing": "-0.01em" }}
                >
                  More this week
                </h2>
                <span
                  class="text-muted-foreground text-xs"
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
                      series={e.seriesId ? (seriesMap()[e.seriesId] ?? null) : null}
                      hovered={hoveredId() === e.id}
                      onMouseEnter={() => setHoveredId(e.id)}
                      onMouseLeave={() => setHoveredId(null)}
                    />
                  )}
                </For>
              </div>
            </Show>

            {/* Empty state */}
            <Show when={filtered().length === 0 && !discovery.loading}>
              <div class="text-muted-foreground py-16 text-center">
                <div class="mb-1.5 text-[28px]" style={{ "font-family": "var(--font-serif)" }}>
                  Nothing here yet.
                </div>
                <div>Try a different filter or broaden your search.</div>
              </div>
            </Show>
          </Show>
        </div>

        {/* Map pane */}
        <aside class="explore-map-pane border-border bg-background sticky top-0 h-screen border-l">
          <ExploreMap events={filtered()} hoveredId={hoveredId()} onHoverEvent={setHoveredId} />
        </aside>
      </div>
    </div>
  );
}
