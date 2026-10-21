import Button from "@cire/ui/button";
import { Popover } from "@kobalte/core/popover";
import { useAuth } from "@shared/rp-auth/solid";
import { Field } from "@shared/ui/ui/field";
import { Input } from "@shared/ui/ui/input";
import { Notice } from "@shared/ui/ui/notice";
import { Select } from "@shared/ui/ui/select";
import { createEffect, createMemo, createSignal, createUniqueId, For, on, Show } from "solid-js";

import { redirectToLogin } from "../lib/api";
import { splitIso } from "../lib/event-datetime";
import type { EventRow } from "../lib/events-store";
import { haptic } from "../lib/haptics";
import { type ZonedTime, zonedTime } from "../lib/run-sheet-display";
import { type RunTimePatch, type RunTimeRefusal, saveTaskRunTime } from "../lib/run-time-write";
import type { TaskRow } from "../lib/tasks-store";
import { browserTimeZone, describeTimeZone, timeZoneGroups } from "../lib/timezones";
import { ClockGlyph, UnlinkGlyph } from "./RunGlyphs";

/**
 * The run-time editor's props, final: `ChecklistView` mounts it on each row for
 * an owner or editor, and the component tests render it with them.
 */
export interface RunTimeEditorProps {
  /** The wedding, fixed for the editor's life. */
  weddingId: string;
  /** The task, live: a save keeps the row, so this is read, never captured. */
  task: TaskRow;
  /** The wedding's events, or `null` until they load. */
  events: readonly EventRow[] | null;
  /** A write of this task is out. */
  disabled?: boolean;
  /** The popover is opening: read the events it offers. */
  onOpen?: () => void;
  /** The events could not be read: only a fixed time can be set. */
  eventsFailed?: boolean;
}

/** The longest a linked task may sit from its event's start, as the API holds
 *  it (`MAX_RUN_OFFSET_MINUTES`): a day. */
const MAX_OFFSET_MINUTES = 1440;

/** What a refused save says, in the popover. A signed-out answer is not here:
 *  it sends the organiser to sign in. */
const REFUSED = {
  not_saved: "This time wasn't saved — reload and try again.",
  event_not_in_wedding: "That event is gone — pick another.",
  out_of_range: "Pick a time within a day of the event.",
  failed: "Couldn't save the time.",
} as const satisfies Record<Exclude<RunTimeRefusal, "signed_out">, string>;

/** A task's time as its row shows it, or null when it has none. */
function shownTime(task: TaskRow): ZonedTime | null {
  return task.runAt ? zonedTime(task.runAt, task.runTimezone ?? null) : null;
}

/** The empty slot: a dotted circle holding a clock, like the holders' +. It
 *  is the boundary of an unfilled control, so `--border-strong`, and gold on
 *  hover and while its popover is open. */
const SLOT =
  "border-border-strong bg-bg text-text-muted hover:border-gold hover:text-text data-[expanded]:border-gold data-[expanded]:text-gold-ink flex size-7 shrink-0 items-center justify-center rounded-full border-2 border-dotted transition-colors duration-(--dur-fast) disabled:opacity-40";
/** A time: a pill holding a clock and the time. */
const PILL =
  "font-body text-ui-xs inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border px-2.5 font-medium whitespace-nowrap tabular-nums";
/** The pill's ink: a time, or one whose event was removed. */
const PILL_INK = "border-border-strong text-text";
const PILL_INK_REMOVED = "border-warn/60 text-warn";
/** The pill as a control. */
const PILL_CONTROL =
  "hover:border-gold data-[expanded]:border-gold transition-colors duration-(--dur-fast) disabled:opacity-40";

/** What the trigger and the read-only chip both show: a glyph, the time, and
 *  what a screen reader needs to know which task's time it is. The time is
 *  on the task's own clock; when that is not the reader's, its zone says so. */
function TimeFace(props: { task: TaskRow; time: ZonedTime }) {
  const away = () => {
    const here = props.task.runAt ? zonedTime(props.task.runAt, browserTimeZone()) : null;
    return here !== null && here.zone !== props.time.zone ? props.time.zone : null;
  };
  return (
    <>
      {props.task.eventRemoved ? <UnlinkGlyph class="size-3.5" /> : <ClockGlyph class="size-3.5" />}
      <span>{props.time.time}</span>
      <Show when={away()}>{(zone) => <span class="text-text-muted">{zone()}</span>}</Show>
      <span class="sr-only">
        {`, time for ${props.task.title}${props.task.eventRemoved ? ", its event removed" : ""}`}
      </span>
    </>
  );
}

/**
 * A task's time on its checklist row, for someone who cannot change it: the
 * same pill as an editor's trigger, as text. Nothing when it has no time.
 */
export function RunTimeChip(props: { task: TaskRow }) {
  return (
    <Show when={shownTime(props.task)}>
      {(time) => (
        <span class={`${PILL} ${props.task.eventRemoved ? PILL_INK_REMOVED : PILL_INK}`}>
          <TimeFace task={props.task} time={time()} />
        </span>
      )}
    </Show>
  );
}

/**
 * A task's time on the day, set from its checklist row. The trigger shows the
 * time, or an empty dotted slot with a clock; it opens a popover that links
 * the task to an event — some minutes before or after its start, or at a clock
 * time on the event's own clock, which the API turns into minutes — or gives
 * it a fixed time in a zone, or clears it.
 *
 * Linked, the task has no zone of its own: it runs on the event's clock and
 * moves with it, so no zone is asked for. Unlinked, the zone defaults to the
 * one every event shares, else the browser's.
 *
 * The popover traps the focus while open — it is a form, and Tab moves between
 * its fields — and hands it back to the trigger when it closes, a save
 * included. The trigger is one node whatever it shows, and the row keeps it
 * across a save.
 */
export default function RunTimeEditor(props: RunTimeEditorProps) {
  const { authFetch } = useAuth();
  const id = createUniqueId();
  let trigger: HTMLButtonElement | undefined;

  const [open, setOpen] = createSignal(false);
  const [saving, setSaving] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  const [eventId, setEventId] = createSignal("");
  const [mode, setMode] = createSignal<"offset" | "clock">("offset");
  const [minutes, setMinutes] = createSignal("");
  const [direction, setDirection] = createSignal<"before" | "after">("before");
  const [date, setDate] = createSignal("");
  const [time, setTime] = createSignal("");
  const [zone, setZone] = createSignal("");
  /** The organiser has set these themselves; a default arriving late (the
   *  events loading after the popover opened) leaves them alone. */
  let dateTouched = false;
  let zoneTouched = false;

  const shown = () => shownTime(props.task);
  const hasTime = () => props.task.runAt !== null || (props.task.eventId ?? null) !== null;

  /** The events by start, each with its start on its own clock. */
  const events = createMemo(() =>
    (props.events ?? [])
      .map((event) => ({ event, start: zonedTime(event.startAt, event.timezone) }))
      .toSorted(
        (a, b) =>
          (Date.parse(a.event.startAt) || Infinity) - (Date.parse(b.event.startAt) || Infinity) ||
          a.event.sortOrder - b.event.sortOrder,
      ),
  );
  const chosen = () => events().find((e) => e.event.id === eventId()) ?? null;
  /** The linked event's name, or how to speak of it while the events load or
   *  once it is gone. */
  const eventName = () => chosen()?.event.name ?? "the event";

  /** The zone every event shares, else the browser's. */
  const defaultZone = () => {
    const zones = new Set((props.events ?? []).map((e) => e.timezone).filter(Boolean));
    return zones.size === 1 ? [...zones][0]! : browserTimeZone();
  };
  /** The first event's date on its own clock: the day, for a new time. */
  const defaultDate = () => events().find((e) => e.start !== null)?.start?.date ?? "";

  /** The form, from the task as it is now. */
  const reset = () => {
    const task = props.task;
    const linked = (task.eventId ?? null) !== null && (task.runOffsetMinutes ?? null) !== null;
    const wall = task.runAt ? splitIso(task.runAt) : null;
    setError(null);
    setEventId(linked ? task.eventId! : "");
    setMode("offset");
    setMinutes(linked ? String(Math.abs(task.runOffsetMinutes!)) : "");
    setDirection(linked && task.runOffsetMinutes! > 0 ? "after" : "before");
    setDate(wall?.date || defaultDate());
    setTime(wall?.time ?? "");
    setZone(!linked && task.runTimezone ? task.runTimezone : defaultZone());
    dateTouched = wall !== null;
    zoneTouched = !linked && Boolean(task.runTimezone);
  };

  // The events can land after the popover opened on an empty list: the
  // defaults they decide follow them, unless the organiser has set their own.
  createEffect(
    on(
      () => props.events,
      () => {
        if (!open()) return;
        if (!zoneTouched) setZone(defaultZone());
        if (!dateTouched && !date()) setDate(defaultDate());
      },
      { defer: true },
    ),
  );

  const pickEvent = (next: string) => {
    setEventId(next);
    setError(null);
    const start = events().find((e) => e.event.id === next)?.start;
    if (start && !dateTouched) setDate(start.date);
  };

  /** Minutes as typed: a whole number within a day, or null. */
  const typedMinutes = (): number | null => {
    const raw = minutes().trim();
    if (!/^\d{1,4}$/.test(raw)) return null;
    const n = Number(raw);
    return n <= MAX_OFFSET_MINUTES ? n : null;
  };

  /** Where an offset lands, on the event's clock: "Sat 20 Jun, 2:30 pm". */
  const lands = () => {
    const picked = chosen();
    const n = typedMinutes();
    if (!picked || n === null) return null;
    const start = Date.parse(picked.event.startAt);
    if (Number.isNaN(start)) return null;
    const signed = direction() === "before" ? -n : n;
    const at = zonedTime(new Date(start + signed * 60_000).toISOString(), picked.event.timezone);
    return at ? `${at.day}, ${at.time}` : null;
  };

  /** The write the form describes, or what is missing from it. */
  const patch = (): RunTimePatch | string => {
    const picked = eventId();
    if (picked && mode() === "offset") {
      const n = typedMinutes();
      if (n === null) return `Minutes must be a whole number from 0 to ${MAX_OFFSET_MINUTES}.`;
      return {
        kind: "offset",
        eventId: picked,
        offsetMinutes: direction() === "before" ? -n : n,
      };
    }
    if (!date() || !time()) return "Pick a date and a time.";
    const at = `${date()}T${time().slice(0, 5)}`;
    if (picked) return { kind: "clock", eventId: picked, at };
    if (!zone()) return "Pick a time zone.";
    return { kind: "fixed", at, timezone: zone() };
  };

  const send = async (runTime: RunTimePatch | null) => {
    if (saving()) return;
    setSaving(true);
    setError(null);
    const result = await saveTaskRunTime(authFetch, props.weddingId, props.task.id, runTime);
    setSaving(false);
    if (result.ok) {
      haptic("commit");
      setOpen(false);
      // The popover hands the focus back as it closes; said here too, so it
      // lands on the trigger even when the popover was already closing.
      trigger?.focus({ preventScroll: true });
      return;
    }
    if (result.reason === "signed_out") {
      redirectToLogin();
      return;
    }
    haptic("reject");
    setError(REFUSED[result.reason]);
  };

  const save = (e: SubmitEvent) => {
    e.preventDefault();
    const built = patch();
    if (typeof built === "string") setError(built);
    else void send(built);
  };

  const zoneGroups = createMemo(() => timeZoneGroups(zone()));

  return (
    <Popover
      open={open()}
      onOpenChange={(next) => {
        if (next) {
          reset();
          props.onOpen?.();
        }
        setOpen(next);
      }}
      placement="bottom-end"
      gutter={6}
      modal
      preventScroll={false}
    >
      <Popover.Trigger
        ref={trigger}
        disabled={props.disabled}
        class={
          shown()
            ? `${PILL} ${PILL_CONTROL} ${props.task.eventRemoved ? PILL_INK_REMOVED : PILL_INK}`
            : SLOT
        }
      >
        <Show
          when={shown()}
          fallback={
            <>
              <ClockGlyph class="size-3.5" />
              <span class="sr-only">{`Set a time for ${props.task.title}`}</span>
            </>
          }
        >
          {(at) => <TimeFace task={props.task} time={at()} />}
        </Show>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content class="droplet-popover border-border bg-surface-raised lip z-50 flex w-80 max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-md border shadow-(--elev-2) outline-none">
          <form
            class="droplet-popover-body flex flex-col gap-4 p-4"
            onSubmit={save}
            noValidate
            aria-busy={saving() || undefined}
          >
            <div class="flex flex-col gap-1">
              <Popover.Title class="text-text-muted font-body text-ui-xs tracking-ui-widest uppercase">
                Time on the day
              </Popover.Title>
              <Popover.Description class="font-body text-text text-ui-sm wrap-break-word">
                {props.task.title}
              </Popover.Description>
            </div>

            <Field
              label="Event"
              hint={props.eventsFailed ? "Couldn't load the events: set a fixed time." : undefined}
            >
              {(field) => (
                <Select {...field} onChange={(e) => pickEvent(e.currentTarget.value)}>
                  <option value="" selected={eventId() === ""}>
                    No event — a fixed time
                  </option>
                  <Show when={props.events === null && !props.eventsFailed}>
                    <option value="" disabled>
                      Loading the events…
                    </option>
                  </Show>
                  {/* The task's event before the list holds it: still loading,
                      or taken off the schedule since the task was read. */}
                  <Show when={eventId() !== "" && chosen() === null}>
                    <option value={eventId()} selected>
                      {props.events === null ? "Its event" : "An event no longer on the schedule"}
                    </option>
                  </Show>
                  {/* `selected` on each option, not `value` on the select: the
                      events can be read again under an open popover. */}
                  <For each={events()}>
                    {(entry) => (
                      <option value={entry.event.id} selected={entry.event.id === eventId()}>
                        {entry.start
                          ? `${entry.event.name} · ${entry.start.day}, ${entry.start.time}`
                          : entry.event.name}
                      </option>
                    )}
                  </For>
                </Select>
              )}
            </Field>

            <Show
              when={eventId() !== ""}
              fallback={
                <>
                  <DateAndTime
                    date={date()}
                    time={time()}
                    onDate={(v) => {
                      dateTouched = true;
                      setDate(v);
                    }}
                    onTime={setTime}
                  />
                  <Field
                    label="Time zone"
                    hint={zone() ? describeTimeZone(zone(), date()) : undefined}
                  >
                    {(field) => (
                      <Select
                        {...field}
                        value={zone()}
                        onChange={(e) => {
                          zoneTouched = true;
                          setZone(e.currentTarget.value);
                        }}
                      >
                        <For each={zoneGroups()}>
                          {(group) => (
                            <optgroup label={group.label}>
                              <For each={group.zones}>{(z) => <option value={z}>{z}</option>}</For>
                            </optgroup>
                          )}
                        </For>
                      </Select>
                    )}
                  </Field>
                </>
              }
            >
              <>
                <fieldset class="flex flex-col gap-2">
                  <legend class="sr-only">How the time follows {eventName()}</legend>
                  <Choice
                    name={`${id}-mode`}
                    checked={mode() === "offset"}
                    onPick={() => setMode("offset")}
                  >
                    Before or after the start
                  </Choice>
                  <Choice
                    name={`${id}-mode`}
                    checked={mode() === "clock"}
                    onPick={() => setMode("clock")}
                  >
                    At a clock time
                  </Choice>
                </fieldset>
                <Show
                  when={mode() === "offset"}
                  fallback={
                    <div class="flex flex-col gap-1.5">
                      <DateAndTime
                        date={date()}
                        time={time()}
                        onDate={(v) => {
                          dateTouched = true;
                          setDate(v);
                        }}
                        onTime={setTime}
                      />
                      <p class="font-body text-text-muted text-ui-xs leading-snug">
                        {chosen()
                          ? `On ${eventName()}'s clock: ${describeTimeZone(chosen()!.event.timezone, date())}`
                          : "On the event's own clock."}
                      </p>
                    </div>
                  }
                >
                  <div class="flex flex-col gap-1.5">
                    <div class="flex items-end gap-2">
                      <Field label="Minutes" class="w-24 shrink-0">
                        {(field) => (
                          <Input
                            {...field}
                            type="number"
                            inputMode="numeric"
                            min="0"
                            max={String(MAX_OFFSET_MINUTES)}
                            step="1"
                            value={minutes()}
                            onInput={(e) => setMinutes(e.currentTarget.value)}
                          />
                        )}
                      </Field>
                      <Field label="Before or after" class="min-w-0 flex-1">
                        {(field) => (
                          <Select
                            {...field}
                            value={direction()}
                            onChange={(e) =>
                              setDirection(e.currentTarget.value === "after" ? "after" : "before")
                            }
                          >
                            <option value="before">before the start</option>
                            <option value="after">after the start</option>
                          </Select>
                        )}
                      </Field>
                    </div>
                    <p class="font-body text-text-muted text-ui-xs leading-snug" aria-live="polite">
                      {lands()
                        ? `${lands()}, on ${eventName()}'s clock`
                        : `Moves with ${eventName()}.`}
                    </p>
                  </div>
                </Show>
              </>
            </Show>

            <Show when={error()}>
              {(message) => (
                <Notice tone="danger" alert>
                  {message()}
                </Notice>
              )}
            </Show>

            <div class="flex flex-wrap items-center gap-2 pt-1">
              <Show when={hasTime()}>
                <Button variant="subtle" onClick={() => void send(null)}>
                  Clear time
                </Button>
              </Show>
              <div class="ms-auto flex items-center gap-3">
                <Button variant="subtle" onClick={() => setOpen(false)}>
                  Cancel
                </Button>
                {/* Not `disabled` while saving: a disabled button drops the
                    focus it holds, and the focus has to survive the save. */}
                <Button
                  type="submit"
                  variant="primary"
                  size="sm"
                  aria-disabled={saving() || undefined}
                >
                  {saving() ? "Saving…" : "Save"}
                </Button>
              </div>
            </div>
          </form>
        </Popover.Content>
      </Popover.Portal>
    </Popover>
  );
}

/** A date and a time, side by side. */
function DateAndTime(props: {
  date: string;
  time: string;
  onDate: (value: string) => void;
  onTime: (value: string) => void;
}) {
  return (
    <div class="flex items-end gap-2">
      <Field label="Date" class="min-w-0 flex-1">
        {(field) => (
          <Input
            {...field}
            type="date"
            value={props.date}
            onInput={(e) => props.onDate(e.currentTarget.value)}
          />
        )}
      </Field>
      <Field label="Time" class="min-w-0 flex-1">
        {(field) => (
          <Input
            {...field}
            type="time"
            value={props.time}
            onInput={(e) => props.onTime(e.currentTarget.value)}
          />
        )}
      </Field>
    </div>
  );
}

/** One of two ways to tie a time to its event: a radio and its words. */
function Choice(props: { name: string; checked: boolean; onPick: () => void; children: string }) {
  return (
    <label class="font-body text-text text-ui-sm flex cursor-pointer items-center gap-2.5">
      <input
        type="radio"
        name={props.name}
        checked={props.checked}
        onChange={() => props.onPick()}
        class="border-border-strong checked:border-brand-ink checked:bg-brand-ink size-4 shrink-0 cursor-pointer appearance-none rounded-full border-2 checked:shadow-[inset_0_0_0_2.5px_var(--surface-raised)]"
      />
      {props.children}
    </label>
  );
}
