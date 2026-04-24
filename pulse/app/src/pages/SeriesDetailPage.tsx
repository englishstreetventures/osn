import { useAuth } from "@osn/client/solid";
import { Badge } from "@osn/ui/ui/badge";
import { Card } from "@osn/ui/ui/card";
import { A, useParams } from "@solidjs/router";
import { createResource, createSignal, For, Show } from "solid-js";

import { fetchSeries, fetchSeriesInstances } from "../lib/series";
import type { SeriesInstance, SeriesSummary } from "../lib/series";
import { formatTime } from "../lib/utils";

/**
 * Summarises a reduced-grammar RRULE for human display.
 *
 * Supported tokens: FREQ (WEEKLY|MONTHLY), INTERVAL, BYDAY, COUNT, UNTIL.
 * Falls back to the raw string if anything's unfamiliar — we'd rather show
 * something than nothing.
 */
function summariseRRule(rrule: string): string {
  const parts: Record<string, string> = {};
  for (const seg of rrule.split(";")) {
    const [k, v] = seg.split("=");
    if (k && v != null) parts[k.toUpperCase()] = v;
  }
  const freq = parts.FREQ;
  const interval = parts.INTERVAL ? Number(parts.INTERVAL) : 1;
  const count = parts.COUNT ? Number(parts.COUNT) : null;
  const byday = parts.BYDAY?.split(",");

  let base = "";
  if (freq === "WEEKLY") {
    base = interval === 1 ? "Every week" : `Every ${interval} weeks`;
    if (byday && byday.length > 0) {
      const names: Record<string, string> = {
        SU: "Sunday",
        MO: "Monday",
        TU: "Tuesday",
        WE: "Wednesday",
        TH: "Thursday",
        FR: "Friday",
        SA: "Saturday",
      };
      base += " on " + byday.map((d) => names[d] ?? d).join(", ");
    }
  } else if (freq === "MONTHLY") {
    base = interval === 1 ? "Every month" : `Every ${interval} months`;
  } else {
    return rrule;
  }
  if (count != null) base += ` · ${count} occurrences`;
  return base;
}

function statusColour(status: SeriesInstance["status"]): string {
  if (status === "ongoing") return "font-semibold text-green-600";
  if (status === "cancelled") return "text-destructive";
  return "text-muted-foreground";
}

function InstanceRow(props: { instance: SeriesInstance }) {
  const i = props.instance;
  return (
    <A
      href={`/events/${i.id}`}
      class="hover:bg-muted/40 border-border/50 flex items-center gap-4 rounded-lg border p-3 transition"
    >
      {/* Date stamp — DESIGN.md: mixed-weight Geist, ember accent */}
      <div class="flex min-w-14 flex-col items-center">
        <span
          class="text-[10px] font-medium tracking-wider uppercase"
          style="color: var(--pulse-accent-strong, currentColor)"
        >
          {new Date(i.startTime).toLocaleString(undefined, { month: "short" })}
        </span>
        <span class="text-xl leading-none font-semibold">{new Date(i.startTime).getDate()}</span>
      </div>
      <div class="min-w-0 flex-1">
        <div class="mb-1 flex items-center gap-2">
          <span class={`text-xs ${statusColour(i.status)}`}>{i.status}</span>
          <Show when={i.instanceOverride}>
            <Badge variant="outline" class="text-[10px] tracking-wide uppercase">
              Modified
            </Badge>
          </Show>
        </div>
        <h3 class="text-foreground truncate text-sm font-semibold">{i.title}</h3>
        <p class="text-muted-foreground truncate text-xs">
          {formatTime(i.startTime)}
          <Show when={i.venue}> · {i.venue}</Show>
        </p>
      </div>
    </A>
  );
}

export function SeriesDetailPage() {
  const params = useParams<{ id: string }>();
  const { session } = useAuth();
  const accessToken = () => session()?.accessToken ?? null;
  const [scope, setScope] = createSignal<"upcoming" | "past">("upcoming");

  const [series] = createResource(
    () => ({ id: params.id, token: accessToken() }),
    ({ id, token }): Promise<SeriesSummary | null> => fetchSeries(id, token),
  );
  const [instances] = createResource(
    () => ({ id: params.id, token: accessToken(), s: scope() }),
    ({ id, token, s }) => fetchSeriesInstances(id, s, token),
  );

  return (
    <main class="mx-auto max-w-2xl px-4 py-6">
      <div class="mb-4">
        <A href="/" class="text-primary text-sm hover:underline">
          ← Back to events
        </A>
      </div>

      <Show when={series.loading}>
        <p class="text-muted-foreground py-16 text-center">Loading…</p>
      </Show>

      <Show when={!series.loading && series() === null}>
        <p class="text-destructive py-16 text-center">Series not found.</p>
      </Show>

      <Show when={series()}>
        {(s) => (
          <article class="flex flex-col gap-6">
            <Card class="p-5">
              <div class="mb-2 flex items-center gap-2">
                <Badge variant="secondary" class="text-[10px] tracking-wider uppercase">
                  Recurring
                </Badge>
                <Show when={s().status === "cancelled"}>
                  <span class="text-destructive text-xs">Cancelled</span>
                </Show>
              </div>
              {/* Serif display headline per DESIGN.md */}
              <h1
                class="text-foreground mb-2 text-3xl leading-tight"
                style='font-family: "Instrument Serif", serif; font-weight: 400;'
              >
                {s().title}
              </h1>
              <p
                class="text-muted-foreground mb-3 text-xs tracking-wide uppercase"
                style='font-family: "Geist Mono", ui-monospace, monospace;'
              >
                {summariseRRule(s().rrule)} · {s().timezone}
              </p>
              <Show when={s().createdByName}>
                {(name) => <p class="text-muted-foreground mb-3 text-xs">Hosted by {name()}</p>}
              </Show>
              <Show when={s().description}>
                <p class="text-foreground text-sm whitespace-pre-wrap">{s().description}</p>
              </Show>
              <Show when={s().venue || s().location}>
                <p class="text-muted-foreground mt-3 text-xs">
                  {[s().venue, s().location].filter(Boolean).join(", ")}
                </p>
              </Show>
            </Card>

            {/* Tabs */}
            <div role="tablist" class="border-border/50 flex gap-2 border-b">
              <button
                role="tab"
                aria-selected={scope() === "upcoming"}
                onClick={() => setScope("upcoming")}
                class={`-mb-px border-b-2 px-3 py-2 text-sm transition ${
                  scope() === "upcoming"
                    ? "border-primary text-foreground font-medium"
                    : "text-muted-foreground border-transparent"
                }`}
              >
                Upcoming
              </button>
              <button
                role="tab"
                aria-selected={scope() === "past"}
                onClick={() => setScope("past")}
                class={`-mb-px border-b-2 px-3 py-2 text-sm transition ${
                  scope() === "past"
                    ? "border-primary text-foreground font-medium"
                    : "text-muted-foreground border-transparent"
                }`}
              >
                Past
              </button>
            </div>

            <Show when={instances.loading}>
              <p class="text-muted-foreground py-8 text-center text-sm">Loading…</p>
            </Show>
            <Show when={!instances.loading && (instances() ?? []).length === 0}>
              <p class="text-muted-foreground py-8 text-center text-sm">No {scope()} instances.</p>
            </Show>
            <div class="flex flex-col gap-2">
              <For each={instances() ?? []}>{(i) => <InstanceRow instance={i} />}</For>
            </div>
          </article>
        )}
      </Show>
    </main>
  );
}
