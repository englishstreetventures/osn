import { Card } from "@osn/ui/ui/card";
import { A, useParams } from "@solidjs/router";
import { createMemo, createResource, For, Show } from "solid-js";

import { Icon } from "../components/Icon";
import { VenueEventCarousel } from "../components/VenueEventCarousel";
import { VenueLineupTimeline } from "../components/VenueLineupTimeline";
import {
  computeOpenStatus,
  fetchEventLineup,
  fetchVenue,
  fetchVenueEvents,
  parseVenueHours,
  safeHttpUrl,
  venueMapsUrl,
  type VenueEvent,
} from "../lib/venues";

import "./venue.css";

const WEEKDAY_LABEL: Record<string, string> = {
  "1": "Mon",
  "2": "Tue",
  "3": "Wed",
  "4": "Thu",
  "5": "Fri",
  "6": "Sat",
  "7": "Sun",
};

const WEEKDAY_ORDER = ["1", "2", "3", "4", "5", "6", "7"] as const;

/**
 * Picks the next club night to feature in the timeline. Prefers
 * "ongoing", then the soonest "upcoming", then the most-recent
 * "finished" so the page never goes blank when the next night isn't
 * announced yet.
 */
function pickFeaturedEvent(events: VenueEvent[]): VenueEvent | null {
  if (events.length === 0) return null;
  const ongoing = events.find((e) => e.status === "ongoing");
  if (ongoing) return ongoing;
  const upcoming = events
    .filter((e) => e.status === "upcoming")
    .toSorted((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime());
  if (upcoming.length > 0) return upcoming[0]!;
  return (
    events
      .filter((e) => e.status === "finished")
      .toSorted((a, b) => new Date(b.startTime).getTime() - new Date(a.startTime).getTime())[0] ??
    events[0]!
  );
}

function formatNightDate(iso: string, timezone: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    timeZone: timezone,
    weekday: "long",
    day: "numeric",
    month: "long",
  });
}

export function VenueDetailPage() {
  const params = useParams<{ orgHandle: string; venueHandle: string }>();

  const handles = () => ({ orgHandle: params.orgHandle, venueHandle: params.venueHandle });

  const [venue] = createResource(handles, ({ orgHandle, venueHandle }) =>
    fetchVenue(orgHandle, venueHandle),
  );
  // Upcoming-first: the timeline + carousel only render upcoming/ongoing
  // nights, so asking for scope=all would let a long venue history crowd
  // them out of the server's LIMIT window. The single most-recent past
  // night is fetched only as a fallback so the page never goes blank
  // when the next night isn't announced yet.
  const [events] = createResource(handles, async ({ orgHandle, venueHandle }) => {
    const upcoming = await fetchVenueEvents(orgHandle, venueHandle, "upcoming");
    if (upcoming.length > 0) return upcoming;
    return fetchVenueEvents(orgHandle, venueHandle, "past", 1);
  });

  const featuredEvent = createMemo(() => {
    const all = events();
    if (!all) return null;
    // Hide the past night unless it's the only thing we have — see
    // pickFeaturedEvent.
    const upcomingPlusOngoing = all.filter(
      (e) => e.status === "upcoming" || e.status === "ongoing",
    );
    return pickFeaturedEvent(upcomingPlusOngoing.length > 0 ? upcomingPlusOngoing : all);
  });

  const upcomingEvents = createMemo(() => {
    const all = events();
    if (!all) return [];
    return all
      .filter((e) => e.status === "upcoming" || e.status === "ongoing")
      .toSorted((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime());
  });

  const lineupSource = createMemo(() => {
    const v = venue();
    const e = featuredEvent();
    if (!v || !e) return null;
    return { orgHandle: v.orgHandle, venueHandle: v.handle, eventId: e.id };
  });

  const [lineup] = createResource(lineupSource, (s) =>
    s ? fetchEventLineup(s.orgHandle, s.venueHandle, s.eventId) : Promise.resolve([]),
  );

  const hours = createMemo(() => {
    const v = venue();
    return v ? parseVenueHours(v.hours) : null;
  });

  const openStatus = createMemo(() => {
    const v = venue();
    const h = hours();
    if (!v || !h) return null;
    return computeOpenStatus(h, v.timezone);
  });

  return (
    <main class="mx-auto max-w-3xl px-4 py-6">
      <div class="mb-4">
        <A href="/" class="text-primary text-sm hover:underline">
          ← Back to events
        </A>
      </div>

      <Show when={venue.loading}>
        <p class="text-muted-foreground py-16 text-center">Loading…</p>
      </Show>

      <Show when={!venue.loading && venue() === null}>
        <p class="text-destructive py-16 text-center">Venue not found.</p>
      </Show>

      <Show when={venue()}>
        {(v) => (
          <article class="flex flex-col gap-6">
            {/* Hero — identity + location + open status + quick links */}
            <Card class="overflow-hidden">
              <Show when={safeHttpUrl(v().heroImageUrl)}>
                {(src) => <img class="h-64 w-full object-cover" src={src()} alt={v().name} />}
              </Show>
              <div class="flex flex-col gap-4 p-5">
                <div>
                  <p class="text-muted-foreground font-mono text-[11px] tracking-[0.18em] uppercase">
                    {v().kind}
                    <Show when={v().capacity}>{(c) => <> · Capacity {c()}</>}</Show>
                  </p>
                  <h1 class="mt-1 text-3xl">{v().name}</h1>
                </div>

                <Show when={[v().address, v().city, v().country].filter(Boolean).join(", ")}>
                  {(loc) => (
                    <div class="flex flex-wrap items-center justify-between gap-3">
                      <p class="text-muted-foreground text-sm">{loc()}</p>
                      <Show when={venueMapsUrl(v())}>
                        {(url) => (
                          <a
                            href={url()}
                            target="_blank"
                            rel="noopener noreferrer"
                            class="border-border bg-background hover:bg-muted inline-flex items-center gap-1 rounded-md border px-3 py-1.5 text-xs font-medium"
                          >
                            Open in Maps →
                          </a>
                        )}
                      </Show>
                    </div>
                  )}
                </Show>

                <Show when={openStatus()}>
                  {(s) => (
                    <div class="flex items-center gap-2">
                      <span
                        class="inline-block size-2 rounded-full"
                        classList={{
                          "bg-emerald-500": s().isOpen,
                          "bg-muted-foreground": !s().isOpen,
                        }}
                      />
                      <span
                        class="text-sm"
                        classList={{
                          "text-foreground font-medium": s().isOpen,
                          "text-muted-foreground": !s().isOpen,
                        }}
                      >
                        {s().label}
                      </span>
                    </div>
                  )}
                </Show>

                <Show when={safeHttpUrl(v().websiteUrl) || v().instagramHandle}>
                  <div class="flex items-center gap-2">
                    <Show when={safeHttpUrl(v().websiteUrl)}>
                      {(url) => (
                        <a
                          href={url()}
                          target="_blank"
                          rel="noopener noreferrer"
                          aria-label="Website"
                          title="Website"
                          class="border-border text-muted-foreground hover:text-foreground hover:bg-muted inline-flex size-9 items-center justify-center rounded-md border"
                        >
                          <Icon name="globe" size={16} />
                        </a>
                      )}
                    </Show>
                    <Show when={v().instagramHandle}>
                      {(handle) => (
                        <a
                          href={`https://instagram.com/${handle()}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          aria-label={`Instagram @${handle()}`}
                          title={`@${handle()}`}
                          class="border-border text-muted-foreground hover:text-foreground hover:bg-muted inline-flex size-9 items-center justify-center rounded-md border"
                        >
                          <Icon name="instagram" size={16} />
                        </a>
                      )}
                    </Show>
                  </div>
                </Show>
              </div>
            </Card>

            {/* Tonight's lineup */}
            <Show when={featuredEvent()}>
              {(e) => (
                <section class="flex flex-col gap-2">
                  <p class="text-muted-foreground text-xs">
                    {e().status === "ongoing" ? "Tonight" : "Next night"} ·{" "}
                    {formatNightDate(e().startTime, v().timezone)}
                  </p>
                  <VenueLineupTimeline
                    slots={lineup() ?? []}
                    timezone={v().timezone}
                    heading={e().title}
                  />
                </section>
              )}
            </Show>

            {/* Programme carousel */}
            <Show when={!events.loading}>
              <VenueEventCarousel events={upcomingEvents()} heading={`Upcoming at ${v().name}`} />
            </Show>

            {/* Full hours */}
            <Show when={hours()}>
              {(h) => (
                <Card class="p-5">
                  <p class="text-muted-foreground font-mono text-[11px] tracking-[0.18em] uppercase">
                    Hours
                  </p>
                  <ul class="mt-2 grid grid-cols-1 gap-y-1 text-sm sm:grid-cols-2">
                    <For each={WEEKDAY_ORDER}>
                      {(day) => {
                        const slot = h()[day];
                        return (
                          <li class="flex items-baseline gap-3">
                            <span class="text-muted-foreground w-10 font-mono text-xs uppercase">
                              {WEEKDAY_LABEL[day]}
                            </span>
                            <span class="font-mono text-xs tabular-nums">
                              {slot ? `${slot.open} – ${slot.close}` : "Closed"}
                            </span>
                          </li>
                        );
                      }}
                    </For>
                  </ul>
                </Card>
              )}
            </Show>

            {/* About */}
            <Show when={v().description}>
              <Card class="p-5">
                <p class="text-muted-foreground font-mono text-[11px] tracking-[0.18em] uppercase">
                  About
                </p>
                <p class="text-foreground mt-2 text-sm whitespace-pre-wrap">{v().description}</p>
              </Card>
            </Show>
          </article>
        )}
      </Show>
    </main>
  );
}
