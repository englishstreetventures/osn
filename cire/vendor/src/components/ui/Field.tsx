import { createUniqueId, For, type JSX, Show, splitProps, untrack } from "solid-js";

import type { SafeProps } from "./props";

/**
 * The portal's form controls, and the label-hint-error scaffolding around them.
 *
 * ## One input, declared twice
 *
 * `ListingEditor` and `VendorEnquiryThread` each opened with a private
 * `inputClass` constant, and the two were the same 200-character string copied
 * across — which is a rename away from being two different inputs, and gives a
 * reviewer nothing to check a third copy against. The budget-table variant the
 * host portal grew is the end state of that pattern; this is the fix applied
 * before it happens here.
 *
 * Two sizes: `md` for a form and `sm` for a control sitting inside a row. Both
 * take the same focus ring, and `Select` gets the same box so the price band and
 * the price fields line up.
 *
 * ## Why `Field` takes a function
 *
 * The quote form wrapped its control in a `<label>` and put the live-formatted
 * amount inside the label too — which quietly makes that figure part of the
 * input's accessible *name*, so a screen reader announces the box as "Quote
 * amount $1,200.00" and re-announces it on every keystroke. A running total is a
 * description, not a name.
 *
 * Splitting them means the control needs an id to point back at, and the caller
 * should not have to invent one. So `Field` mints the id and hands the wiring —
 * `id`, `aria-describedby`, `aria-invalid` — to a function:
 *
 * ```tsx
 * <Field label="Quote amount" hint={formatted()} errors={amountErrors()}>
 *   {(field) => <Input {...field} value={amount()} onInput={…} />}
 * </Field>
 * ```
 *
 * The alternative — a `Field` that renders the control itself from a `type`
 * prop — collapses the moment a field holds a currency prefix or a pair of
 * inputs, and this portal has both.
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

export type TextareaResize = "y" | "none";

const TEXTAREA_RESIZE = {
  y: "resize-y",
  none: "resize-none",
} satisfies Readonly<Record<TextareaResize, string>>;

export type TextareaProps = Omit<SafeProps<"textarea">, "size"> & {
  size?: ControlSize;
  /** `"y"` (the default) on purpose: sideways resize breaks the column a
   *  textarea sits in, and no-resize takes away the one control a vendor has
   *  over a long description. `"none"` exists for the one place that default
   *  is wrong — a textarea inside the auto-sized frame `createAutoSize()`
   *  wraps `ListingEditor` in (`lib/auto-size.ts`). That observer's reflow
   *  guard watches width only; dragging this textarea's own resize grip
   *  changes height at a fixed width, which the guard reads as a content
   *  change on every delivery (xchromo/osn-tracker#130). A caller cannot fix
   *  this by passing `class="resize-none"`: this component appends its own
   *  resize class after `own.class`, so both land on the element and
   *  Tailwind resolves the conflict by the two utilities' order in the
   *  generated stylesheet, not by attribute order — the caller's class does
   *  not reliably win. */
  resize?: TextareaResize;
};

/** A multi-line box. */
export function Textarea(props: TextareaProps) {
  const [own, rest] = splitProps(props, ["size", "class", "resize"]);
  return (
    <textarea
      {...rest}
      class={`${controlClass(own.size, own.class)} ${TEXTAREA_RESIZE[own.resize ?? "y"]}`}
    />
  );
}

export type SelectProps = Omit<SafeProps<"select">, "size"> & { size?: ControlSize };

/** A native select. Native because the portal has no combobox that behaves on a
 *  phone, and the platform one does. */
export function Select(props: SelectProps) {
  const [own, rest] = splitProps(props, ["size", "class"]);
  return <select {...rest} class={`${controlClass(own.size, own.class)} cursor-pointer`} />;
}

/** What `Field` hands its child: everything the control needs to be named,
 *  described and marked wrong. Spread it. */
export interface FieldControlProps {
  id: string;
  "aria-describedby": string | undefined;
  "aria-invalid": "true" | undefined;
}

export interface FieldProps {
  /** JSX, not a string: a few labels carry a lower-case qualifier — "Note
   *  (optional)" — that has to opt out of the label's own `uppercase`. */
  label: JSX.Element;
  /** A standing note under the control — a format, a unit, a running total. */
  hint?: JSX.Element;
  /** What is wrong with what is in the box. Announced, and it turns the border. */
  errors?: readonly string[];
  /** Visually hide the label but keep it for a screen reader. */
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
  // the caret and the focus with it, at the exact moment the vendor is fixing
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
 * A group of controls that answer one question — the service-category
 * checkboxes.
 *
 * A `<fieldset>` rather than a `<div>` with a heading, because the grouping is
 * what a screen reader needs to announce "Categories" before each option rather
 * than reading fourteen unrelated checkboxes. The browser's default border and
 * padding come off; the legend takes the same treatment as a `Field` label so
 * the two line up in a column of fields.
 */
export function Fieldset(props: { legend: JSX.Element; class?: string; children: JSX.Element }) {
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

/**
 * A checkbox and its word, as one clickable row.
 *
 * The label wraps the control here rather than pointing at it by id, which is
 * the one place that association is better done by nesting: the whole row is the
 * hit target, and a `for`/`id` pair would need an id invented per category key.
 */
export function Checkbox(props: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: JSX.Element;
}) {
  return (
    <label class="flex cursor-pointer items-center gap-2">
      <input
        type="checkbox"
        checked={props.checked}
        onChange={(e) => props.onChange(e.currentTarget.checked)}
        class="accent-gold h-4 w-4 shrink-0 cursor-pointer rounded"
      />
      <span class="font-body text-text text-[0.88rem]">{props.label}</span>
    </label>
  );
}
