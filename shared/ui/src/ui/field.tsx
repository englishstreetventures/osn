/**
 * The label, hint and error scaffolding a form control sits in.
 *
 * ## Why this takes a function instead of rendering the control
 *
 * The forms this replaces wrapped their control in a `<label>` and put the hint
 * inside the label too — which quietly makes the hint part of the input's
 * accessible *name*. A screen reader then announces "RSVP by, the day replies
 * are due, measured in Australia/Sydney" as the name of a date box, and a hint
 * that updates as you type (a running total, a character count) re-announces the
 * whole name on every keystroke. A hint is a description, not a name.
 *
 * Splitting the two means the control needs an id for the label to point at, and
 * the caller should not have to invent one. So `Field` mints the id and hands
 * the wiring — `id`, `aria-describedby`, `aria-invalid` — to a function:
 *
 * ```tsx
 * <Field label="Wedding name" hint="Shown to guests" errors={nameErrors()}>
 *   {(field) => <Input {...field} value={name()} onInput={…} />}
 * </Field>
 * ```
 *
 * The alternative — a `Field` that renders the control itself from a `type`
 * prop — collapses the moment a field holds a date picker, a currency prefix, a
 * colour swatch or a pair of inputs, and the products between them have all
 * four.
 */

import { createUniqueId, For, Show, untrack, type JSX } from "solid-js";

/**
 * What {@link Field} hands its child: everything the control needs in order to
 * be named, described and marked wrong. Spread it onto the control.
 */
export interface FieldControlProps {
  id: string;
  "aria-describedby": string | undefined;
  "aria-invalid": "true" | undefined;
}

export interface FieldProps {
  /**
   * JSX rather than a string: a label often carries a lower-case qualifier —
   * "Note (optional)", "events.csv (optional)" — that has to opt out of the
   * label's own `uppercase`.
   */
  label: JSX.Element;
  /** A standing note under the control — a format, a unit, a consequence, a running total. */
  hint?: JSX.Element;
  /** What is wrong with what is in the box. Announced, and it turns the control's border. */
  errors?: readonly string[];
  /**
   * Visually hide the label but keep it for a screen reader — for a control
   * whose column heading already says what it is. Never for one where nothing
   * else does: this hides the label, it does not remove the need for one.
   */
  labelHidden?: boolean;
  class?: string;
  /**
   * Called once, when the field mounts. Spread what it hands you onto the
   * control; the two `aria-*` values are getters, so they keep updating.
   */
  children: (field: FieldControlProps) => JSX.Element;
}

const LABEL =
  "base:font-ui-body base:text-ui-ink-secondary base:text-ui-xs " +
  "base:tracking-ui-wider base:uppercase";

/** The label, the control, the hint and the errors — in that order, wired. */
export function Field(props: FieldProps) {
  const id = createUniqueId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;

  const hasErrors = () => (props.errors?.length ?? 0) > 0;

  // Errors first: when a field is wrong, that is the thing to hear before the
  // format note it just broke.
  const describedBy = () => {
    const parts = [hasErrors() ? errorId : undefined, props.hint ? hintId : undefined].filter(
      Boolean,
    );
    return parts.length > 0 ? parts.join(" ") : undefined;
  };

  // Called once, outside tracking, and held. A call in child position would
  // compile to a render effect, and both values below are reactive — so the
  // first rejected save would dispose the control and build a new one, taking
  // the caret and the focus with it, at the exact moment the person is fixing
  // what they typed. The getters keep `{...field}` spreading reactively, so the
  // two attributes still update; they just update on a node that stays put.
  const control = untrack(() =>
    props.children({
      id,
      get "aria-describedby"() {
        return describedBy();
      },
      get "aria-invalid"() {
        return hasErrors() ? "true" : undefined;
      },
    }),
  );

  return (
    <div class={`base:flex base:flex-col base:gap-1.5${props.class ? ` ${props.class}` : ""}`}>
      <label for={id} class={props.labelHidden ? "base:sr-only" : LABEL}>
        {props.label}
      </label>
      {control}
      <Show when={props.hint}>
        <p
          id={hintId}
          class="base:font-ui-body base:text-ui-ink-secondary base:text-ui-xs base:leading-ui-snug"
        >
          {props.hint}
        </p>
      </Show>
      {/* A live region, because the usual way a message lands here is a save
          that just came back rejected — by which time focus has left the box
          and nothing else would say so. */}
      <Show when={hasErrors()}>
        <div id={errorId} role="alert" class="base:flex base:flex-col base:gap-0.5">
          <For each={props.errors}>
            {(message) => (
              <p class="base:font-ui-body base:text-ui-danger base:text-ui-sm">{message}</p>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}

export interface FieldsetProps {
  /** JSX for the same reason {@link FieldProps.label} is. */
  legend: JSX.Element;
  class?: string;
  children: JSX.Element;
}

/**
 * A group of controls that answer one question — a radio set, a column of
 * category checkboxes.
 *
 * A `<fieldset>` rather than a `<div>` with a heading, because the grouping is
 * what a screen reader needs in order to announce "Categories" before each
 * option rather than reading fourteen unrelated checkboxes. The browser's
 * default border and padding come off; the legend takes the same treatment as a
 * `Field` label so the two line up in a column of fields.
 */
export function Fieldset(props: FieldsetProps) {
  return (
    <fieldset
      class={`base:m-0 base:flex base:flex-col base:gap-1.5 base:border-0 base:p-0${props.class ? ` ${props.class}` : ""}`}
    >
      <legend class={`${LABEL} base:mb-1.5`}>{props.legend}</legend>
      {props.children}
    </fieldset>
  );
}
