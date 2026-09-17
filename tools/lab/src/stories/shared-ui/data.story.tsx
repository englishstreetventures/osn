import { Chip } from "@shared/ui/ui/chip";
import { Meter } from "@shared/ui/ui/meter";
import { Table, Td, Th } from "@shared/ui/ui/table";

import type { Story, StoryArgs } from "../../lab/types.ts";

export const meta = { title: "shared/ui/data", layout: "padded" as const };

const GUESTS = [
  { name: "Ada Lovelace", household: "Lovelace", reply: "Going", seats: 2 },
  { name: "Grace Hopper", household: "Hopper", reply: "Going", seats: 1 },
  { name: "Katherine Johnson", household: "Johnson", reply: "Awaiting", seats: 4 },
  { name: "Margaret Hamilton", household: "Hamilton", reply: "Declined", seats: 0 },
];

/**
 * The table's whole reason for existing is off the right-hand edge.
 *
 * Narrow the preview with the **viewport** control — phone (390) is the case —
 * and the frame should scroll sideways on its own while the page stays put. Then
 * tab to it: the frame is a focusable, named region, because WebKit does not
 * make an overflow container reachable from the keyboard on its own, and a
 * column you cannot scroll to is a column that is not there.
 */
export const Guests = () => (
  <Table label="Guests">
    <thead>
      <tr>
        <Th>Name</Th>
        <Th>Household</Th>
        <Th>Email</Th>
        <Th>Reply</Th>
        <Th align="center">Seats</Th>
      </tr>
    </thead>
    <tbody>
      {GUESTS.map((guest) => (
        <tr>
          <Td>{guest.name}</Td>
          <Td>{guest.household}</Td>
          <Td>{guest.name.toLowerCase().replace(" ", ".")}@example.com</Td>
          <Td>
            <Chip
              tone={
                guest.reply === "Going"
                  ? "success"
                  : guest.reply === "Awaiting"
                    ? "pending"
                    : "neutral"
              }
            >
              {guest.reply}
            </Chip>
          </Td>
          <Td numeric>{guest.seats}</Td>
        </tr>
      ))}
    </tbody>
  </Table>
);

/**
 * `numeric` is the column to look down. The figures are right-aligned and
 * tabular, so the digits line up and a column of money can be read as a column
 * rather than as four separate numbers.
 */
export const Figures = () => (
  <Table label="Budget">
    <thead>
      <tr>
        <Th>Category</Th>
        <Th>Budgeted</Th>
        <Th>Spent</Th>
      </tr>
    </thead>
    <tbody>
      <tr>
        <Td>Venue</Td>
        <Td numeric>$8,000.00</Td>
        <Td numeric>$8,000.00</Td>
      </tr>
      <tr>
        <Td>Catering</Td>
        <Td numeric>$11,250.00</Td>
        <Td numeric>$9,410.55</Td>
      </tr>
      <tr>
        <Td>Flowers</Td>
        <Td numeric>$900.00</Td>
        <Td numeric>$1,140.00</Td>
      </tr>
    </tbody>
  </Table>
);

/**
 * `over` is the case the budget module needs: a value past its maximum is still
 * drawn full, but in the danger tone, so "spent everything" and "spent more than
 * everything" are not the same picture.
 */
export const Meters = () => (
  <div class="flex w-full max-w-md flex-col gap-6">
    {[
      { label: "Venue", value: 8000, max: 8000, tone: undefined },
      { label: "Catering", value: 9410, max: 11250, tone: undefined },
      { label: "Flowers", value: 1140, max: 900, tone: "over" as const },
      { label: "Music", value: 0, max: 2000, tone: undefined },
    ].map((row) => (
      <div class="flex flex-col gap-2">
        <div class="text-meta flex items-baseline justify-between">
          <span>{row.label}</span>
          <span class="text-subtle tabular-nums">
            ${row.value.toLocaleString()} / ${row.max.toLocaleString()}
          </span>
        </div>
        <Meter value={row.value} max={row.max} tone={row.tone} label={`${row.label} spent`} />
      </div>
    ))}
  </div>
);

interface MeterArgs extends StoryArgs {
  value: number;
  max: number;
  over: boolean;
}

/**
 * Drag `value` past `max` and the bar stops moving — it is clamped — which is
 * why `over` has to be a tone the caller sets rather than something the
 * component could infer from the numbers alone. Set `max` to 0 too: a budget
 * with no total is the ordinary case on a new wedding, and `value / 0` reaching
 * the transform as `scaleX(Infinity)` would take the layout with it.
 */
export const MeterPlayground: Story<MeterArgs> = {
  args: { value: 40, max: 100, over: false },
  controls: {
    value: { kind: "range", min: 0, max: 200 },
    max: { kind: "range", min: 0, max: 200 },
  },
  render: (args) => (
    <div class="w-80">
      <Meter
        value={args.value}
        max={args.max}
        tone={args.over ? "over" : "accent"}
        label="Playground"
      />
    </div>
  ),
};
