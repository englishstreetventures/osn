import { createSignal, onMount, Show, For } from "solid-js";

interface DressSwatch {
  name: string;
  color: string;
}

interface EventRow {
  id: string;
  name: string;
  slug: string;
  sortOrder: number;
  date: string;
  startAt: string;
  endAt: string;
  timezone: string;
  location: string;
  address: string | null;
  description: string;
  dressCodeDescription: string | null;
  dressCodePalette: DressSwatch[] | null;
  pinterestUrl: string | null;
  mapsUrl: string | null;
}

interface EventTableProps {
  apiUrl: string;
}

function formatRange(startAt: string, endAt: string, timezone: string): string {
  try {
    const start = new Date(startAt);
    const end = new Date(endAt);
    const dateFmt = new Intl.DateTimeFormat("en-AU", {
      weekday: "short",
      day: "numeric",
      month: "short",
      year: "numeric",
      timeZone: timezone,
    });
    const timeFmt = new Intl.DateTimeFormat("en-AU", {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
      timeZone: timezone,
    });
    return `${dateFmt.format(start)} · ${timeFmt.format(start)} – ${timeFmt.format(end)}`;
  } catch {
    return `${startAt} – ${endAt}`;
  }
}

export default function EventTable(props: EventTableProps) {
  const [events, setEvents] = createSignal<EventRow[]>([]);
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal<string | null>(null);

  onMount(async () => {
    try {
      const res = await fetch(`${props.apiUrl}/api/organiser/events`);
      if (!res.ok) throw new Error("Failed to load");
      setEvents((await res.json()) as EventRow[]);
    } catch {
      setError("Could not load events. Is the API running?");
    } finally {
      setLoading(false);
    }
  });

  return (
    <div class="flex flex-col gap-6">
      <Show when={loading()}>
        <div class="flex flex-col gap-3">
          <For each={[1, 2, 3, 4]}>
            {() => <div class="h-[140px] animate-pulse rounded-sm bg-surface" />}
          </For>
        </div>
      </Show>

      <Show when={error()}>
        <p class="rounded-sm border border-error/20 bg-error/5 p-4 text-[0.88rem] text-error">
          {error()}
        </p>
      </Show>

      <Show when={!loading() && !error()}>
        <p class="font-body text-[0.82rem] text-text-muted">{events().length} events</p>

        <ul class="flex flex-col gap-4">
          <For each={events()}>
            {(event) => (
              <li class="flex flex-col gap-3 rounded-sm border border-border bg-surface/30 p-5">
                <header class="flex flex-col gap-1">
                  <span class="font-body text-[0.72rem] uppercase tracking-[0.2em] text-gold">
                    {event.slug}
                  </span>
                  <h3 class="font-display text-[1.5rem] font-light italic text-text">
                    {event.name}
                  </h3>
                  <p class="font-body text-[0.82rem] text-text-muted">
                    {formatRange(event.startAt, event.endAt, event.timezone)} · {event.timezone}
                  </p>
                </header>

                <dl class="grid grid-cols-1 gap-x-6 gap-y-2 font-body text-[0.88rem] md:grid-cols-2">
                  <Show when={event.location}>
                    <Detail label="Location" value={event.location} />
                  </Show>
                  <Show when={event.address}>
                    <Detail label="Address" value={event.address!} />
                  </Show>
                  <Show when={event.description}>
                    <Detail label="Notes" value={event.description} span />
                  </Show>
                  <Show when={event.dressCodeDescription}>
                    <Detail label="Dress code" value={event.dressCodeDescription!} span />
                  </Show>
                </dl>

                <Show when={event.dressCodePalette && event.dressCodePalette.length > 0}>
                  <div class="flex flex-wrap gap-2">
                    <For each={event.dressCodePalette!}>
                      {(swatch) => (
                        <span
                          class="inline-flex items-center gap-2 rounded-sm border border-border bg-bg px-2 py-1 font-body text-[0.72rem] uppercase tracking-[0.06em] text-text-muted"
                          title={swatch.color}
                        >
                          <span
                            class="inline-block h-3 w-3 rounded-sm border border-border"
                            style={{ background: swatch.color }}
                          />
                          {swatch.name}
                        </span>
                      )}
                    </For>
                  </div>
                </Show>

                <Show when={event.pinterestUrl || event.mapsUrl}>
                  <div class="flex flex-wrap gap-4 pt-1 font-body text-[0.82rem]">
                    <Show when={event.mapsUrl}>
                      <a
                        href={event.mapsUrl!}
                        target="_blank"
                        rel="noreferrer"
                        class="text-gold underline-offset-4 hover:underline"
                      >
                        Maps ↗
                      </a>
                    </Show>
                    <Show when={event.pinterestUrl}>
                      <a
                        href={event.pinterestUrl!}
                        target="_blank"
                        rel="noreferrer"
                        class="text-gold underline-offset-4 hover:underline"
                      >
                        Pinterest ↗
                      </a>
                    </Show>
                  </div>
                </Show>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </div>
  );
}

function Detail(props: { label: string; value: string; span?: boolean }) {
  return (
    <div class={props.span ? "md:col-span-2" : ""}>
      <dt class="font-body text-[0.72rem] uppercase tracking-[0.1em] text-text-muted">
        {props.label}
      </dt>
      <dd class="text-text">{props.value}</dd>
    </div>
  );
}
