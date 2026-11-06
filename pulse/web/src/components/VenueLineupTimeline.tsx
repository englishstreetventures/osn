import { Card } from "@shared/ui/ui/card";
import { For, Show } from "solid-js";

import { type DateStyle, zoned } from "../lib/dates";
import type { LineupSlot, LineupRole } from "../lib/venues";
import { LocalTime } from "./LocalTime";

interface Props {
  slots: LineupSlot[];
  /** IANA timezone the venue programs in — slot times render in this zone. */
  timezone: string;
  /** Title shown above the timeline (e.g. the night's name). */
  heading?: string;
}

const ROLE_LABEL = {
  headliner: "Headliner",
  support: "Support",
  resident: "Resident",
  opener: "Opener",
  guest: "Guest",
} satisfies Record<LineupRole, string>;

/**
 * Format an instant as "HH:MM" in the venue's local timezone, in both
 * renderings (`pinZone`); the server's names the zone once, after the end
 * time. Slot timestamps may cross midnight, so we deliberately render the
 * wall-clock time only — the date band on the parent component sets
 * the night's calendar context.
 */
function formatSlotTime(date: Date, style: DateStyle): string {
  return date.toLocaleTimeString(style.locale, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    ...zoned(style),
  });
}

/**
 * Vertical timeline of programmed lineup slots — the centrepiece of
 * the venue night view.
 *
 * Layout: a left-aligned mono time column ("22:00 → 23:30") followed
 * by the artist name and a uppercase role chip. Headliners get a
 * stronger weight to set the visual hierarchy without resorting to
 * background colour, which doesn't read well on the dark club
 * aesthetic the design language is heading toward.
 */
export function VenueLineupTimeline(props: Props) {
  return (
    <Card class="overflow-hidden">
      <div class="border-border/50 border-b p-4">
        <p class="text-muted-foreground text-ui-xs tracking-ui-widest font-mono uppercase">
          Tonight's Lineup
        </p>
        <Show when={props.heading}>{(h) => <h2 class="mt-1 text-xl">{h()}</h2>}</Show>
      </div>
      <ul class="divide-border/50 divide-y">
        <For
          each={props.slots}
          fallback={
            <li class="text-muted-foreground p-6 text-center text-sm">Lineup to be announced.</li>
          }
        >
          {(slot) => {
            const isHeadliner = slot.role === "headliner";
            return (
              <li class="flex items-baseline gap-4 p-4">
                <div class="text-foreground w-28 shrink-0 font-mono text-xs tracking-wide tabular-nums">
                  <LocalTime
                    value={slot.slotStart}
                    zone={props.timezone}
                    pinZone
                    format={(d, style) => formatSlotTime(d, { ...style, nameZone: false })}
                  />
                  <span class="text-muted-foreground"> → </span>
                  <LocalTime
                    value={slot.slotEnd}
                    zone={props.timezone}
                    pinZone
                    format={formatSlotTime}
                  />
                </div>
                <div class="min-w-0 flex-1">
                  <p
                    class={`truncate ${isHeadliner ? "text-base font-semibold" : "text-sm font-medium"}`}
                  >
                    {slot.artistName}
                  </p>
                </div>
                <span
                  class={`text-ui-xs tracking-ui-widest shrink-0 font-mono uppercase ${
                    isHeadliner ? "text-foreground" : "text-muted-foreground"
                  }`}
                >
                  {ROLE_LABEL[slot.role]}
                </span>
              </li>
            );
          }}
        </For>
      </ul>
    </Card>
  );
}
