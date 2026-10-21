// An event's run of show, getting-there notes and guest policy, as the
// organiser edits and reads them. The server is AUTHORITATIVE; these mirror
// its rules for inline feedback, each pointing at its source of truth:
//   cire/api/src/schemas/import.ts        (MAX_RUN_OF_SHOW_ITEMS,
//                                           MAX_RUN_OF_SHOW_LABEL,
//                                           CLOCK_TIME_RE, the two presets)
//   cire/invites/src/components/event-details.ts
//                                          (`runOfShowLines`: the guest reads
//                                           the list in time order from the
//                                           event's start, which is what
//                                           `afterMidnight` warns about)

/** Mirror of `MAX_RUN_OF_SHOW_ITEMS`: the most items one event's run of show holds. */
export const MAX_RUN_OF_SHOW_ITEMS = 40;

/** Mirror of `MAX_RUN_OF_SHOW_LABEL`: the longest one item's name may be. */
export const MAX_RUN_OF_SHOW_LABEL = 200;

/** Mirror of `CLOCK_TIME_RE`: a 24-hour wall clock, `HH:MM`. */
const CLOCK_TIME_RE = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

/** Is `value` a 24-hour `HH:MM` clock time, as a `type="time"` input gives one? */
export function isClockTime(value: string): boolean {
  return CLOCK_TIME_RE.test(value);
}

/** Whether children are welcome. `null` is not stated. */
export type ChildrenPolicy = "adults_only" | "children_welcome";

/** How plus-ones work. Wording only: each guest's own permission decides. */
export type PlusOnePolicy = "by_invitation" | "welcome";

/** The drawer's choices for children, the first being "not stated". */
export const CHILDREN_POLICY_OPTIONS = [
  { value: "", label: "Not stated" },
  { value: "adults_only", label: "Adults only" },
  { value: "children_welcome", label: "Children welcome" },
] as const satisfies readonly { value: ChildrenPolicy | ""; label: string }[];

/** The drawer's choices for plus-ones, the first being "not stated". */
export const PLUS_ONE_POLICY_OPTIONS = [
  { value: "", label: "Not stated" },
  { value: "by_invitation", label: "By invitation" },
  { value: "welcome", label: "Welcome" },
] as const satisfies readonly { value: PlusOnePolicy | ""; label: string }[];

/** The words a guest reads for each preset, as `guestPolicyLines` writes them. */
export const CHILDREN_POLICY_WORDS = {
  adults_only: "Adults only",
  children_welcome: "Children welcome",
} as const satisfies Record<ChildrenPolicy, string>;

export const PLUS_ONE_POLICY_WORDS = {
  by_invitation: "Plus-ones by invitation",
  welcome: "Plus-ones welcome",
} as const satisfies Record<PlusOnePolicy, string>;

/** A `<select>` value read back as a children preset, `""` being none. */
export function childrenPolicyOf(value: string): ChildrenPolicy | null {
  return value === "adults_only" || value === "children_welcome" ? value : null;
}

/** A `<select>` value read back as a plus-one preset, `""` being none. */
export function plusOnePolicyOf(value: string): PlusOnePolicy | null {
  return value === "by_invitation" || value === "welcome" ? value : null;
}

/** An `HH:MM` clock time as the guest reads it: `16:00` → "4:00 pm". */
export function clockLabel(time: string): string {
  const hours = Number(time.slice(0, 2));
  const suffix = hours < 12 ? "am" : "pm";
  return `${hours % 12 === 0 ? 12 : hours % 12}:${time.slice(3, 5)} ${suffix}`;
}

/** Minutes past midnight of an `HH:MM` clock time. */
function minutesOf(time: string): number {
  return Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
}

/**
 * Minutes past midnight of the event's start on its own zone's clock, or null
 * when it cannot be read. The zone first, from the instant; the stored value's
 * own clock when the zone does not resolve.
 */
function startMinutes(startAt: string, timezone: string): number | null {
  const instant = new Date(startAt);
  if (!Number.isNaN(instant.getTime())) {
    try {
      const parts = new Intl.DateTimeFormat("en-GB", {
        timeZone: timezone,
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      }).formatToParts(instant);
      const hour = parts.find((p) => p.type === "hour")?.value;
      const minute = parts.find((p) => p.type === "minute")?.value;
      if (hour && minute) return Number(hour) * 60 + Number(minute);
    } catch {
      // A zone this browser does not know: read the stored clock instead.
    }
  }
  const clock = /T(\d{2}):(\d{2})/.exec(startAt);
  return clock ? Number(clock[1]) * 60 + Number(clock[2]) : null;
}

/**
 * Whether a guest reads this item as after midnight: its clock time is earlier
 * than the event's start, and the guest sheet orders the run of show from the
 * start. False for a time not yet set, or a start that cannot be read.
 */
export function afterMidnight(time: string, startAt: string, timezone: string): boolean {
  if (!isClockTime(time)) return false;
  const start = startMinutes(startAt, timezone);
  return start !== null && minutesOf(time) < start;
}
