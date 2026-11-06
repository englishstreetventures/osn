import { A } from "@solidjs/router";
import { For, Show } from "solid-js";

import { LocalTime } from "../components/LocalTime";
import { type CalendarEntry, formatRailDate, groupEntriesByDay } from "../lib/calendar";
import { createInBrowser } from "../lib/hydration";
import { formatTime } from "../lib/utils";
import { CalendarEventCard } from "./CalendarEventCard";

/**
 * The entries as the server writes them: each event's title, linked, and its
 * start in UTC with the zone named (`LocalTime`), in the API's order. The
 * timeline groups by the reader's local day, which only the browser knows.
 */
function ServerAgenda(props: { entries: CalendarEntry[] }) {
  return (
    <ul class="m-0 flex list-none flex-col gap-2.5 p-0">
      <For each={props.entries}>
        {(entry) => (
          <li class="cal-card border-border bg-card rounded-xl border">
            <A href={`/events/${entry.event.id}`} class="block px-4 py-3">
              <span class="text-ui-base block leading-tight font-semibold tracking-tight">
                {entry.event.title}
              </span>
              <LocalTime
                value={entry.event.startTime}
                format={formatTime}
                class="text-muted-foreground text-ui-sm"
              />
            </A>
          </li>
        )}
      </For>
    </ul>
  );
}

/**
 * Vertical-timeline agenda: a continuous axis runs down the left edge,
 * with a dated marker per day and that day's events listed to the right.
 *
 * Grouped by the reader's local day, so it is drawn in the browser only; the
 * server writes `ServerAgenda`, which the browser repeats until it has mounted.
 */
export function CalendarTimeline(props: { entries: CalendarEntry[]; onChanged: () => void }) {
  const inBrowser = createInBrowser();
  const groups = () => groupEntriesByDay(props.entries);

  return (
    <Show when={inBrowser()} fallback={<ServerAgenda entries={props.entries} />}>
      <div class="cal-timeline">
        <For each={groups()}>
          {(group) => {
            const rail = formatRailDate(group.date);
            return (
              <div class="cal-day">
                <div class="cal-day__rail">
                  <div class="cal-day__marker">
                    <div class="cal-day__month">{rail.month}</div>
                    <div class="cal-day__daynum">{rail.day}</div>
                    <div class="cal-day__weekday">{rail.weekday}</div>
                  </div>
                </div>
                <div class="cal-day__axis" aria-hidden="true">
                  <span class="cal-day__dot" />
                </div>
                <div class="cal-day__content">
                  <h2 class="cal-day__label">{group.label}</h2>
                  <div class="flex flex-col gap-2.5">
                    <For each={group.entries}>
                      {(entry) => <CalendarEventCard entry={entry} onChanged={props.onChanged} />}
                    </For>
                  </div>
                </div>
              </div>
            );
          }}
        </For>
      </div>
    </Show>
  );
}
