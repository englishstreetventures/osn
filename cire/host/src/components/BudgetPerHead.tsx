import Button from "@cire/ui/button";
import Eyebrow from "@cire/ui/eyebrow";
import { Checkbox } from "@shared/ui/ui/checkbox";
import { Field } from "@shared/ui/ui/field";
import { Input } from "@shared/ui/ui/input";
import { Notice } from "@shared/ui/ui/notice";
import { RadioGroup, RadioGroupItem } from "@shared/ui/ui/radio-group";
import { createSignal, createUniqueId, For, Show } from "solid-js";

import type { BudgetEvent, BudgetItemRow } from "../lib/budget-store";
import { belowSmallestUnitError, formatMinor, minorToInput, parseMinor } from "../lib/money";

/** What a per-head save sends. `eventIds` is left out unless the organiser
 *  changed the events, so a price edit never rewrites them: `null` counts every
 *  event, a list only those. */
export interface PerHeadChange {
  unitPriceMinor: number;
  eventIds?: string[] | null;
}

/**
 * The line under a per-head row: the price, which events it counts, and what
 * that comes to. While RSVPs are open it shows the expected guests beside the
 * confirmed ones; once they close, only the confirmed ones, which is what the
 * line then costs.
 */
export function PerHeadSummary(props: {
  item: BudgetItemRow;
  events: readonly BudgetEvent[];
  currency: string;
  rsvpsClosed: boolean;
}) {
  const unit = () => props.item.unitPriceMinor ?? 0;
  const heads = () => props.item.headcount ?? { expected: 0, confirmed: 0 };
  const money = (minor: number) => formatMinor(minor, props.currency);
  /** Where the line counts guests; `null` once every picked event is deleted. */
  const scope = (): string | null => {
    const ids = props.item.eventIds;
    if (ids == null) return "every event";
    const names = props.events.filter((e) => ids.includes(e.id)).map((e) => e.name);
    return names.length === 0 ? null : names.join(", ");
  };
  return (
    <p class="text-text-muted text-ui-sm" data-testid="per-head-summary">
      <Show
        when={scope()}
        fallback={
          <>
            {money(unit())} per head.{" "}
            <span class="text-error">The events it counted were deleted, so it counts nobody.</span>
          </>
        }
      >
        {(where) => (
          <>
            {money(unit())} per head at {where()}
            <Show
              when={props.rsvpsClosed}
              fallback={
                <>
                  {" "}
                  · {heads().expected} expected = {money(unit() * heads().expected)} ·{" "}
                  {heads().confirmed} confirmed = {money(unit() * heads().confirmed)}
                </>
              }
            >
              {" "}
              · RSVPs closed: {heads().confirmed} confirmed = {money(unit() * heads().confirmed)}
            </Show>
          </>
        )}
      </Show>
    </p>
  );
}

/**
 * The editor for a line's per-head settings: the price, and whether it counts
 * every event or only some. Saving makes a fixed line per head. On a line that
 * is already per head, "Use a fixed amount" turns it back.
 */
export function PerHeadPanel(props: {
  item: BudgetItemRow;
  events: readonly BudgetEvent[];
  currency: string;
  onSave: (change: PerHeadChange) => void;
  onUseFixed: () => void;
  onCancel: () => void;
}) {
  const isPerHead = props.item.unitPriceMinor != null;
  const [price, setPrice] = createSignal(
    props.item.unitPriceMinor == null
      ? ""
      : minorToInput(props.item.unitPriceMinor, props.currency),
  );
  const [everyEvent, setEveryEvent] = createSignal(props.item.eventIds == null);
  const [picked, setPicked] = createSignal<ReadonlySet<string>>(new Set(props.item.eventIds ?? []));
  const [eventsChanged, setEventsChanged] = createSignal(false);
  // What the line under the form says, and whether it is about the price: the
  // price box is named by the line and marked wrong only then.
  const [error, setError] = createSignal<{ text: string; price: boolean } | null>(null);
  const errorId = createUniqueId();
  const priceRefused = () => error()?.price === true;
  const scopeName = `per-head-scope-${props.item.id}`;
  const legendId = createUniqueId();

  const chooseEvery = (every: boolean) => {
    setEveryEvent(every);
    setEventsChanged(true);
  };
  const toggle = (id: string, on: boolean) => {
    const next = new Set(picked());
    if (on) next.add(id);
    else next.delete(id);
    setPicked(next);
    setEventsChanged(true);
  };

  const submit = (e: Event) => {
    e.preventDefault();
    const unitPriceMinor = parseMinor(price(), props.currency);
    if (unitPriceMinor === null) {
      setError({
        text:
          belowSmallestUnitError(price(), props.currency) ??
          "Enter a price per head of zero or more.",
        price: true,
      });
      return;
    }
    const change: PerHeadChange = { unitPriceMinor };
    if (eventsChanged()) {
      if (everyEvent()) change.eventIds = null;
      else {
        // In the wedding's own order, and only events that still exist.
        const ids = props.events.filter((ev) => picked().has(ev.id)).map((ev) => ev.id);
        if (ids.length === 0) {
          setError({ text: "Tick at least one event, or count every event.", price: false });
          return;
        }
        change.eventIds = ids;
      }
    }
    setError(null);
    props.onSave(change);
  };

  return (
    <form
      onSubmit={submit}
      class="border-border/60 ml-2 flex flex-col gap-3 border-l pl-3"
      data-testid="per-head-panel"
    >
      <Field label={`Price per head (${props.currency})`} class="w-44">
        {(field) => (
          <Input
            {...field}
            // Named by the line under the form while it is the price's. An
            // `undefined` after the spread keeps the field's own value, so
            // otherwise the field's wiring stands.
            aria-describedby={priceRefused() ? errorId : undefined}
            aria-invalid={priceRefused() ? "true" : undefined}
            size="form-compact"
            type="number"
            min="0"
            step="any"
            value={price()}
            onInput={(e) => setPrice(e.currentTarget.value)}
          />
        )}
      </Field>
      {/* The radio group is the group, named by the label over it; the event
          boxes that follow "Only these events" are its answer, not more
          choices in it. */}
      <div class="flex flex-col gap-2">
        <Eyebrow id={legendId} tone="muted" class="mb-1">
          Count guests at
        </Eyebrow>
        <RadioGroup
          box="native"
          size="sm"
          orientation="vertical"
          name={scopeName}
          value={everyEvent() ? "every" : "these"}
          onChange={(value) => chooseEvery(value === "every")}
          aria-labelledby={legendId}
        >
          <RadioGroupItem value="every" label="Every event" />
          <RadioGroupItem
            value="these"
            label="Only these events"
            disabled={props.events.length === 0}
          />
        </RadioGroup>
        <Show when={!everyEvent()}>
          {/* The boxes answer "Only these events", so they are a group of
              their own, named for it, as the indent shows on screen. */}
          <fieldset class="m-0 ml-6 flex flex-col gap-2 border-0 p-0">
            <legend class="sr-only">Events to count</legend>
            <For each={props.events}>
              {(ev) => (
                <Checkbox
                  box="native"
                  size="sm"
                  checked={picked().has(ev.id)}
                  onChange={(next) => toggle(ev.id, next)}
                  label={ev.name}
                />
              )}
            </For>
          </fieldset>
        </Show>
      </div>
      <p class="text-text-muted text-ui-xs max-w-prose">
        Until RSVPs close this counts every invited guest who has not declined, then only those who
        said yes. A guest at more than one of these events counts once. Withdrawn invites and your
        preview household are not counted.
      </p>
      <Show when={error()}>
        {(line) => (
          <Notice id={errorId} size="inline" tone="danger" alert>
            {line().text}
          </Notice>
        )}
      </Show>
      <div class="flex flex-wrap gap-2">
        <Button type="submit" variant="primary" size="sm">
          Save
        </Button>
        <Show when={isPerHead}>
          <Button type="button" variant="outline" size="sm" onClick={() => props.onUseFixed()}>
            Use a fixed amount
          </Button>
        </Show>
        <Button type="button" variant="quiet" size="sm" onClick={() => props.onCancel()}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
