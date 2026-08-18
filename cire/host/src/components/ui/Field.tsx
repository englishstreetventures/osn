import { createUniqueId, For, type JSX, Show, splitProps, untrack } from "solid-js";

import type { SafeProps } from "./props";

/**
 * The portal's form controls, and the label-hint-error scaffolding around them.
 *
 * ## Four inputs where there should have been one
 *
 * Counted across the write surfaces, the text input had drifted into four
 * shapes: `px-3 py-2 text-[0.9rem]` on the planning modules, the same padding at
 * `text-[0.95rem]` with a focus border and disabled styling on the settings and
 * co-host forms, `px-2 py-1` with no text size at all on the guest editor's
 * inline cells, and `px-2 py-1 text-[0.8rem]` in the budget table. Three of the
 * four had no focus treatment, so typing into a guest row and typing into the
 * wedding name looked like two different products.
 *
 * Two sizes, then: `md` for a form and `sm` for a control sitting inside a table
 * row. Both take the same focus ring, and `Select` gets the same box so a date
 * and a currency line up.
 *
 * ## Why `Field` takes a function
 *
 * Every one of those forms wrapped its control in a `<label>` and put the hint
 * inside the label too — which quietly makes the hint part of the input's
 * accessible *name*, so a screen reader announces "RSVP by, the day replies are
 * due, measured in Australia/Sydney" as the name of a date box. A hint is a
 * description, not a name.
 *
 * Splitting them means the control needs an id to point back at, and the caller
 * should not have to invent one. So `Field` mints the id and hands the wiring —
 * `id`, `aria-describedby`, `aria-invalid` — to a function:
 *
 * ```tsx
 * <Field label="Wedding name" hint="Shown to guests" errors={nameErrors()}>
 *   {(field) => <Input {...field} value={name()} onInput={…} />}
 * </Field>
 * ```
 *
 * The alternative — a `Field` that renders the control itself from a `type`
 * prop — collapses the moment a field holds a date picker, a colour swatch or a
 * pair of inputs, and the portal has all three.
 *
 * ## No haptic here either
 *
 * Same reason as `Button`: typing is not a commit. The feedback belongs on the
 * save that follows.
 */

export type ControlSize = "sm" | "md";

const CONTROL_BASE =
  "font-body text-text border-border bg-bg w-full rounded-sm border " +
  "transition-colors duration-(--dur-fast) ease-(--ease-out) outline-none " +
  "focus:border-gold placeholder:opacity-40 disabled:opacity-40 " +
  "aria-[invalid=true]:border-error/60";

const CONTROL_SIZE = {
  sm: "px-2 py-1 text-[0.82rem]",
  md: "px-3 py-2 text-[0.95rem]",
} satisfies Readonly<Record<ControlSize, string>>;

function controlClass(size: ControlSize | undefined, extra: string | undefined): string {
  return `${CONTROL_BASE} ${CONTROL_SIZE[size ?? "md"]}${extra ? ` ${extra}` : ""}`;
}

/** The native `size` attribute is dropped: it sizes a box in characters, which
 *  nothing here wants, and it would collide with the two names below. */
export type InputProps = Omit<SafeProps<"input">, "size"> & { size?: ControlSize };

/** A single-line box. `type="text"` unless the caller says otherwise. */
export function Input(props: InputProps) {
  const [own, rest] = splitProps(props, ["size", "class"]);
  return <input type="text" {...rest} class={controlClass(own.size, own.class)} />;
}

export type TextareaProps = Omit<SafeProps<"textarea">, "size"> & { size?: ControlSize };

/** A multi-line box. `resize-y` on purpose: sideways resize breaks the column
 *  it sits in, and no-resize takes away the one control a host has over a long
 *  note. */
export function Textarea(props: TextareaProps) {
  const [own, rest] = splitProps(props, ["size", "class"]);
  return <textarea {...rest} class={`${controlClass(own.size, own.class)} resize-y`} />;
}

export type SelectProps = Omit<SafeProps<"select">, "size"> & { size?: ControlSize };

/** A native select. Native because the portal has no combobox that behaves on a
 *  phone, and the platform one does. */
export function Select(props: SelectProps) {
  const [own, rest] = splitProps(props, ["size", "class"]);
  return <select {...rest} class={controlClass(own.size, own.class)} />;
}

/** What `Field` hands its child: everything the control needs to be named,
 *  described and marked wrong. Spread it. */
export interface FieldControlProps {
  id: string;
  "aria-describedby": string | undefined;
  "aria-invalid": "true" | undefined;
}

export interface FieldProps {
  /** JSX, not a string: a few labels carry a lower-case qualifier — "events.csv
   *  (optional)" — that has to opt out of the label's own `uppercase`. */
  label: JSX.Element;
  /** A standing note under the control — a format, a unit, a consequence. */
  hint?: JSX.Element;
  /** What is wrong with what is in the box. Announced, and it turns the border. */
  errors?: readonly string[];
  /** Visually hide the label but keep it for a screen reader. For a control
   *  whose column heading already says what it is. */
  labelHidden?: boolean;
  class?: string;
  /** Called once, when the field mounts. Spread what it hands you onto the
   *  control — the two `aria-*` values are getters, so they keep updating. */
  children: (field: FieldControlProps) => JSX.Element;
}

/** The label, the control, the hint and the errors — in that order, wired. */
export default function Field(props: FieldProps) {
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
  // the caret and the focus with it, at the exact moment the host is fixing
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
    <div class={`flex flex-col gap-1.5${props.class ? ` ${props.class}` : ""}`}>
      <label
        for={id}
        class={
          props.labelHidden
            ? "sr-only"
            : "font-body text-text-muted text-[0.72rem] tracking-[0.1em] uppercase"
        }
      >
        {props.label}
      </label>
      {control}
      <Show when={props.hint}>
        <p id={hintId} class="font-body text-text-muted text-[0.75rem] leading-snug">
          {props.hint}
        </p>
      </Show>
      {/* A live region, because the usual way a message lands here is a save
          that just came back rejected — by which time focus has left the box
          and nothing else would say so. */}
      <Show when={hasErrors()}>
        <div id={errorId} role="alert" class="flex flex-col gap-0.5">
          <For each={props.errors}>
            {(message) => <p class="font-body text-error text-[0.78rem]">{message}</p>}
          </For>
        </div>
      </Show>
    </div>
  );
}

/**
 * A group of controls that answer one question — a radio set, a pair of
 * checkboxes.
 *
 * A `<fieldset>` rather than a `<div>` with a heading, because the grouping is
 * what a screen reader needs to announce "Guest code style" before each option
 * rather than reading four unrelated radios. The browser's default border and
 * padding come off; the legend takes the same treatment as a `Field` label so
 * the two line up in a column of fields.
 */
export function Fieldset(props: { legend: string; class?: string; children: JSX.Element }) {
  return (
    <fieldset
      class={`m-0 flex flex-col gap-1.5 border-0 p-0${props.class ? ` ${props.class}` : ""}`}
    >
      <legend class="font-body text-text-muted mb-1.5 text-[0.72rem] tracking-[0.1em] uppercase">
        {props.legend}
      </legend>
      {props.children}
    </fieldset>
  );
}
