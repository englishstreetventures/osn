import { For } from "solid-js";

import { type CalendarEntry, formatRailDate, groupEntriesByDay } from "../lib/calendar";
import { CalendarEventCard } from "./CalendarEventCard";

/**
 * Vertical-timeline agenda: a continuous axis runs down the left edge,
 * with a dated marker per day and that day's events listed to the right.
 */
export function CalendarTimeline(props: {
  entries: CalendarEntry[];
  accessToken: string | null;
  onChanged: () => void;
}) {
  const groups = () => groupEntriesByDay(props.entries);

  return (
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
                    {(entry) => (
                      <CalendarEventCard
                        entry={entry}
                        accessToken={props.accessToken}
                        onChanged={props.onChanged}
                      />
                    )}
                  </For>
                </div>
              </div>
            </div>
          );
        }}
      </For>
    </div>
  );
}
