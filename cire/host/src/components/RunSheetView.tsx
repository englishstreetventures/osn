import Button from "@cire/ui/button";
import { useAuth } from "@shared/rp-auth/solid";
import { EmptyState } from "@shared/ui/ui/empty-state";
import { Notice } from "@shared/ui/ui/notice";
import { Tooltip } from "@shared/ui/ui/tooltip";
import {
  createEffect,
  createMemo,
  createSignal,
  createUniqueId,
  For,
  type JSX,
  Match,
  on,
  onCleanup,
  onMount,
  Show,
  Switch,
} from "solid-js";

import { isAuthExpired, redirectToLogin } from "../lib/api";
import { readerFirst } from "../lib/holder-writes";
import { useMembersChanged } from "../lib/members-changed";
import { isComingUp, isOwnTask, nextComingUpChange } from "../lib/run-sheet";
import { dayHeading, offsetPhrase, type ZonedTime, zonedTime } from "../lib/run-sheet-display";
import {
  ensureRunSheetLoaded,
  fetchRunSheet,
  rereadRunSheet,
  type RunSheet,
  RunSheetError,
  type RunSheetEventItem,
  type RunSheetItem,
  type RunSheetPerson,
  type RunSheetTaskItem,
  runSheetAccessor,
} from "../lib/run-sheet-store";
import { useTasksChanged } from "../lib/tasks-changed";
import { type Tier, tierAtLeast } from "../lib/tiers";
import type { WeddingRole } from "../lib/wedding-roles";
import PanelLoading from "./PanelLoading";
import { ClockGlyph, LinkGlyph, TickGlyph, UnlinkGlyph } from "./RunGlyphs";
import TaskHolders, { type Holder } from "./TaskHolders";

/**
 * The run sheet's props, final: the module shell and a helper's seat both
 * mount it with these, and the component tests render it with them.
 */
export interface RunSheetViewProps {
  /** The wedding, fixed for the view's life. */
  weddingId: string;
  /** The wedding's plan tier: below Gold the run sheet is not offered, and no
   *  request is sent. */
  tier: Tier;
  /** The reader's role on the wedding. Not named `role`: on a JSX element
   *  that reads as an ARIA role. */
  callerRole: WeddingRole;
  /** An owner or editor, who sets times on the checklist. */
  canEdit: boolean;
  /** Open the Checklist, where times are set. Absent for a helper. */
  onOpenChecklist?: () => void;
}

/** The longest `setTimeout` waits; past it the timer fires at once. */
const LONGEST_WAIT_MS = 2 ** 31 - 1;

/** What the view says instead of the run sheet: below Gold, or a 402. It
 *  names no plan and offers nothing to buy — a helper cannot buy one. */
const NOT_AVAILABLE = "The run sheet isn't available for this wedding.";

/** A row, with its times read on its own clock once. */
interface Row {
  item: RunSheetItem;
  /** An event's start or a task's run time; null for "any time on the day". */
  when: ZonedTime | null;
  /** An event's end, when it states one. */
  until: ZonedTime | null;
}

/** One local date's rows, or the untimed ones. */
interface Day {
  key: string;
  heading: string;
  /** The zones the day's times are on, as shown ("AEST", "GMT+5:30"). */
  zones: string[];
  rows: Row[];
}

function rowOf(item: RunSheetItem): Row {
  if (item.kind === "event") {
    return {
      item,
      when: zonedTime(item.startAt, item.timezone),
      until: item.endAt ? zonedTime(item.endAt, item.timezone) : null,
    };
  }
  return { item, when: item.runAt ? zonedTime(item.runAt, item.runTimezone) : null, until: null };
}

/**
 * The rows by the local date each falls on in its own zone, in the API's
 * order — by instant — so a Kolkata task sits between the Sydney rows it
 * happens between, under the date it has in Kolkata. Untimed tasks come last,
 * under "Any time on the day".
 */
function daysOf(items: readonly RunSheetItem[]): Day[] {
  const byDate = new Map<string, Row[]>();
  const anyTime: Row[] = [];
  for (const item of items) {
    const row = rowOf(item);
    if (row.when === null) {
      anyTime.push(row);
      continue;
    }
    const rows = byDate.get(row.when.date);
    if (rows) rows.push(row);
    else byDate.set(row.when.date, [row]);
  }
  const days: Day[] = [...byDate].map(([date, rows]) => ({
    key: date,
    heading: dayHeading(date),
    zones: [...new Set(rows.map((row) => row.when!.zone))],
    rows,
  }));
  if (anyTime.length > 0) {
    days.push({ key: "any", heading: "Any time on the day", zones: [], rows: anyTime });
  }
  return days;
}

/**
 * The day of the wedding, hour by hour: its events and the checklist tasks
 * timed on it, each on its own clock, with who holds each task. Read-only for
 * every role; owners and editors set times on the checklist.
 *
 * A task is flagged "Coming up" from half an hour before it starts until it
 * does, against the browser's clock: a timer wakes the view at the next change,
 * and a tab coming back from the background looks again. The reader's own
 * tasks say "You". Done tasks stay where they were, struck through.
 */
export default function RunSheetView(props: RunSheetViewProps) {
  const { authFetch } = useAuth();
  const sheet = runSheetAccessor(props.weddingId);
  const [failure, setFailure] = createSignal<number | null>(null);
  const offered = () => tierAtLeast(props.tier, "gold");

  const fetcher = () => fetchRunSheet(authFetch, props.weddingId);
  const settle = (load: Promise<boolean>) =>
    load.then(
      () => setFailure(null),
      (err: unknown) => {
        if (isAuthExpired(err) || (err instanceof RunSheetError && err.status === 401)) {
          return redirectToLogin();
        }
        setFailure(err instanceof RunSheetError ? err.status : 0);
      },
    );
  const load = () => void settle(ensureRunSheetLoaded(props.weddingId, fetcher));

  onMount(() => {
    if (offered()) load();
  });
  // Someone changed the tasks or the seats: read again. The cache waits out
  // this tab's own task writes and coalesces a burst into two reads.
  createEffect(
    on(
      [useTasksChanged(), useMembersChanged()],
      () => {
        if (offered()) void settle(rereadRunSheet(props.weddingId, fetcher));
      },
      { defer: true },
    ),
  );

  return (
    <Switch>
      <Match when={!offered() || failure() === 402}>
        <Notice>{NOT_AVAILABLE}</Notice>
      </Match>
      <Match when={failure() !== null}>
        <div class="flex flex-col items-start gap-3">
          <Notice tone="warn" class="self-stretch">
            Couldn't load the run sheet.
          </Notice>
          <Button
            variant="quiet"
            size="sm"
            onClick={() => {
              setFailure(null);
              load();
            }}
          >
            Try again
          </Button>
        </div>
      </Match>
      <Match when={sheet()}>
        {(day) => (
          <Sheet
            sheet={day()}
            canEdit={props.canEdit}
            onOpenChecklist={props.canEdit ? props.onOpenChecklist : undefined}
          />
        )}
      </Match>
      <Match when={true}>
        <PanelLoading />
      </Match>
    </Switch>
  );
}

/** A loaded run sheet. */
function Sheet(props: { sheet: RunSheet; canEdit: boolean; onOpenChecklist?: () => void }) {
  // The clock the flags are read against. Not deduplicated: a timer that
  // fires within the millisecond it was set must still re-arm the next one.
  const [now, setNow] = createSignal(Date.now(), { equals: false });
  createEffect(() => {
    const next = nextComingUpChange(props.sheet.items, now());
    if (next === null) return;
    const wait = Math.min(Math.max(next - Date.now(), 0), LONGEST_WAIT_MS);
    const timer = setTimeout(() => setNow(Date.now()), wait);
    onCleanup(() => clearTimeout(timer));
  });
  // A background tab's timers are slowed or stopped, and a laptop that slept
  // ran none: a tab that comes back looks at the clock again.
  const onVisible = () => {
    if (document.visibilityState === "visible") setNow(Date.now());
  };
  document.addEventListener("visibilitychange", onVisible);
  onCleanup(() => document.removeEventListener("visibilitychange", onVisible));

  const days = createMemo(() => daysOf(props.sheet.items));
  const eventNames = createMemo(
    () =>
      new Map(
        props.sheet.items
          .filter((item): item is RunSheetEventItem => item.kind === "event")
          .map((event) => [event.id, event.name]),
      ),
  );
  const people = createMemo(
    () => new Map(props.sheet.people.map((person) => [person.hostId, person])),
  );
  const own = () => props.sheet.scope === "own";

  return (
    <Show
      when={props.sheet.items.length > 0}
      fallback={
        <EmptyState
          title={
            own() ? "Nothing on the run sheet is yours yet." : "Nothing is timed for the day yet."
          }
          description={
            own()
              ? "When a task on the day is given to you, it shows here with its time."
              : props.canEdit
                ? "Give a task a time on the checklist, or put it in the day-of list, and it shows here."
                : "Tasks given a time on the checklist show here, in the order they happen."
          }
          action={
            props.onOpenChecklist && !own() ? (
              <Button variant="outline" size="sm" onClick={() => props.onOpenChecklist?.()}>
                Set times on the checklist
              </Button>
            ) : undefined
          }
        />
      }
    >
      {/* The view measures its own box: in the module shell it sits in the
          panel, and in a helper's seat in the page itself. */}
      <div data-run-sheet class="@container/run-sheet flex flex-col gap-8">
        <Show when={own() || props.onOpenChecklist}>
          <div class="flex flex-wrap items-center justify-between gap-3">
            <Show when={own()}>
              <p class="font-body text-text text-ui-base">Your tasks for the day</p>
            </Show>
            <Show when={props.onOpenChecklist}>
              <Button
                variant="quiet"
                size="sm"
                class="ms-auto"
                onClick={() => props.onOpenChecklist?.()}
              >
                Change times on the checklist
              </Button>
            </Show>
          </div>
        </Show>

        <For each={days()}>
          {(day) => (
            <DaySection
              day={day}
              now={now()}
              viewerHostId={props.sheet.viewerHostId}
              eventNames={eventNames()}
              people={people()}
            />
          )}
        </For>
      </div>
    </Show>
  );
}

interface DayProps {
  day: Day;
  now: number;
  viewerHostId: string | null;
  eventNames: ReadonlyMap<string, string>;
  people: ReadonlyMap<string, RunSheetPerson>;
}

/** One date's rows as a headed list, on the day's thread. */
function DaySection(props: DayProps) {
  const headingId = createUniqueId();
  const mixed = () => props.day.zones.length > 1;
  return (
    <section aria-labelledby={headingId} class="flex flex-col gap-2">
      <div class="border-border flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b pb-2">
        <h3 id={headingId} class="font-body text-gold-ink text-ui-sm font-medium">
          {props.day.heading}
        </h3>
        <Show when={props.day.zones.length > 0}>
          <p class="font-body text-text-muted text-ui-xs">
            {mixed() ? "Each time on its own clock" : `Times in ${props.day.zones[0]}`}
          </p>
        </Show>
      </div>
      <ol class="run-sheet-day flex flex-col gap-1">
        <For each={props.day.rows}>
          {(row) =>
            row.item.kind === "event" ? (
              <EventRow event={row.item} row={row} showZone={mixed()} />
            ) : (
              <TaskRow
                task={row.item}
                row={row}
                showZone={mixed()}
                now={props.now}
                viewerHostId={props.viewerHostId}
                eventNames={props.eventNames}
                people={props.people}
              />
            )
          }
        </For>
      </ol>
    </section>
  );
}

/** The time column: a start, an event's end under it, and the zone when the
 *  day mixes zones. */
function When(props: {
  when: ZonedTime | null;
  iso: string | null;
  until?: ZonedTime | null;
  untilIso?: string;
  showZone: boolean;
  muted?: boolean;
}) {
  return (
    <div class="font-body flex flex-col items-end text-end leading-snug">
      <Show when={props.when && props.iso}>
        <time
          datetime={props.iso!}
          class="text-ui-sm font-medium tabular-nums"
          classList={{ "text-text": !props.muted, "text-text-muted": props.muted }}
        >
          {props.when!.time}
        </time>
      </Show>
      <Show when={props.until}>
        {(until) => (
          <span class="text-text-muted text-ui-xs tabular-nums">
            to <time datetime={props.untilIso}>{until().time}</time>
            {/* An end past midnight names its day. */}
            <Show when={until().date !== props.when?.date}>{` ${until().day.split(" ")[0]}`}</Show>
          </span>
        )}
      </Show>
      <Show when={props.showZone && props.when}>
        {(when) => <span class="text-text-muted text-ui-xs">{when().zone}</span>}
      </Show>
    </div>
  );
}

/** An event on the run sheet: a raised band on the thread, marked by a diamond. */
function EventRow(props: { event: RunSheetEventItem; row: Row; showZone: boolean }) {
  const place = () =>
    [props.event.venueName, props.event.address].filter((part) => part !== null).join(" · ");
  return (
    <li
      data-run-sheet-item={props.event.id}
      data-kind="event"
      class="run-sheet-row run-sheet-band bg-surface lip relative grid rounded-sm"
    >
      <span aria-hidden="true" class="run-sheet-mark bg-gold rounded-hair rotate-45" />
      <When
        when={props.row.when}
        iso={props.event.startAt}
        until={props.row.until}
        untilIso={props.event.endAt}
        showZone={props.showZone}
      />
      <div class="flex min-w-0 flex-col gap-0.5">
        <p class="font-body text-text text-ui-base font-medium wrap-break-word">
          <span class="sr-only">Event: </span>
          {props.event.name}
        </p>
        <Show when={place()}>
          <p class="font-body text-text-muted text-ui-sm wrap-break-word">{place()}</p>
        </Show>
      </div>
    </li>
  );
}

interface TaskRowProps {
  task: RunSheetTaskItem;
  row: Row;
  showZone: boolean;
  now: number;
  viewerHostId: string | null;
  eventNames: ReadonlyMap<string, string>;
  people: ReadonlyMap<string, RunSheetPerson>;
}

/** A task on the run sheet: its time, what it is, its flags and who holds it. */
function TaskRow(props: TaskRowProps) {
  const done = () => props.task.status === "done";
  const soon = () => isComingUp(props.task, props.now);
  const mine = () => isOwnTask(props.task, props.viewerHostId);
  const linked = () => {
    const { eventId, runOffsetMinutes } = props.task;
    if (!props.task.anchored || eventId === null || runOffsetMinutes === null) return null;
    const name = props.eventNames.get(eventId);
    return name === undefined ? null : offsetPhrase(runOffsetMinutes, name);
  };
  // The holders the run sheet names, the reader first. A seat the answer does
  // not name is left out rather than shown as a face with no name.
  const holders = createMemo((): Holder[] =>
    readerFirst(props.task.assigneeHostIds, props.viewerHostId).flatMap((hostId) => {
      const seat = props.people.get(hostId);
      return seat ? [{ hostId, seat }] : [];
    }),
  );

  return (
    <li
      data-run-sheet-item={props.task.id}
      data-kind="task"
      data-own={mine() || undefined}
      data-coming-up={soon() || undefined}
      class="run-sheet-row relative grid rounded-sm"
      classList={{
        "bg-gold/8": soon(),
        "before:bg-brand-ink before:absolute before:inset-y-2 before:start-0 before:w-0.75 before:rounded-full":
          mine(),
      }}
    >
      <span
        aria-hidden="true"
        class="run-sheet-mark rounded-full border-2"
        classList={{
          "border-gold bg-gold": soon(),
          "border-transparent bg-text-faint": done(),
          "border-border-strong bg-bg": !soon() && !done(),
        }}
      />
      <When when={props.row.when} iso={props.task.runAt} showZone={props.showZone} muted={done()} />
      <div class="flex min-w-0 flex-col gap-1">
        <p
          class="font-body text-ui-base wrap-break-word"
          classList={{ "text-text-muted line-through": done(), "text-text": !done() }}
        >
          {props.task.title}
        </p>
        <Show when={linked()}>
          {(phrase) => (
            <p class="font-body text-text-muted text-ui-sm flex items-center gap-1.5">
              <LinkGlyph class="size-3" />
              {phrase()}
            </p>
          )}
        </Show>
        <Show when={props.task.notes}>
          <p class="font-body text-text-muted text-ui-sm wrap-break-word whitespace-pre-line">
            {props.task.notes}
          </p>
        </Show>
        <Show when={mine() || soon() || done() || props.task.eventRemoved}>
          <div class="flex flex-wrap items-center gap-1.5 pt-0.5">
            <Show when={mine()}>
              <Flag tone="you">You</Flag>
            </Show>
            <Show when={soon()}>
              <Flag tone="soon" glyph={<ClockGlyph class="size-3" />}>
                Coming up
              </Flag>
            </Show>
            <Show when={done()}>
              <Flag tone="done" glyph={<TickGlyph class="size-3" />}>
                Done
              </Flag>
            </Show>
            <Show when={props.task.eventRemoved}>
              <Tooltip text="Its event was taken off the schedule. The task kept its last time.">
                <Flag tone="removed" glyph={<UnlinkGlyph class="size-3" />}>
                  Event removed
                </Flag>
              </Tooltip>
            </Show>
          </div>
        </Show>
      </div>
      <div class="run-sheet-holders">
        <TaskHolders
          title={props.task.title}
          open={!done()}
          holders={holders()}
          canAssign={false}
          seats={null}
          seatsFailed={false}
          viewerHostId={props.viewerHostId}
          holds={() => false}
          busy={false}
          onOpen={() => {}}
          onToggle={() => {}}
        />
      </div>
    </li>
  );
}

const FLAG_TONE = {
  you: "border-brand bg-brand text-on-brand",
  soon: "border-gold bg-gold text-on-gold",
  done: "border-border-strong text-text-muted",
  removed: "border-warn/50 bg-warn/5 text-warn",
} as const;

/** A state a row is in, as a word and a shape: never colour alone. */
function Flag(props: { tone: keyof typeof FLAG_TONE; glyph?: JSX.Element; children: string }) {
  return (
    <span
      data-flag={props.tone}
      class={`font-body text-ui-xs inline-flex items-center gap-1 rounded-full border px-2 py-0.5 leading-none font-medium ${FLAG_TONE[props.tone]}`}
    >
      {props.glyph}
      {props.children}
    </span>
  );
}
