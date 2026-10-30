import { clsx } from "clsx";
import {
  children,
  createUniqueId,
  onMount,
  Show,
  splitProps,
  type Component,
  type JSX,
} from "solid-js";

import {
  DESCRIPTION,
  DRAWN_TEXT,
  FIRST_LINE,
  idList,
  NATIVE_CHECKBOX,
  NATIVE_ROW,
  NATIVE_TEXT,
  NOTE_INDENT,
  present,
  ROW_ALIGN,
  WRAP,
  type ChoiceAlign,
  type ChoiceBox,
  type ChoiceSize,
} from "./choice";
import type { SafeProps } from "./props";

type CheckboxProps = Omit<SafeProps<"div">, "onChange" | "children"> & {
  /** Ticked or not. Controlled: the box shows this value and nothing else, so a
   *  change the caller refuses, or has not saved yet, never shows as made. */
  checked: boolean;
  /** Asked for the new value. The box changes only when `checked` does. */
  onChange?: (checked: boolean) => void;
  /** The words beside the box, inside its `<label>`, so a click on them ticks
   *  it. JSX: a link or a second line is the caller's to put here. */
  label?: JSX.Element;
  /** A line under the label, inside it: what ticking does. The box is then
   *  named by `label` alone and described by this. */
  description?: JSX.Element;
  /** A line under the row, outside the label, starting where the label's words
   *  start: a note on the box, such as the notice an attestation asks to pass
   *  on. A click on it ticks nothing, and the box is described by it. */
  note?: JSX.Element;
  /** {@link ChoiceBox}. `drawn` by default; `native` draws the browser's box. */
  box?: ChoiceBox;
  /** {@link ChoiceSize} — the label's type step. `md` by default. */
  size?: ChoiceSize;
  /** {@link ChoiceAlign}. `center` by default; `start` for a label that wraps. */
  align?: ChoiceAlign;
  name?: string;
  value?: string;
  /** The input's own id, for a `<label for>` elsewhere. */
  id?: string;
  disabled?: boolean;
  required?: boolean;
  /** Names the box when it has no `label`, as in a table cell. */
  "aria-label"?: string;
  /** Names the box by other text; wins over the label's own words. */
  "aria-labelledby"?: string;
  /** Joined with the description's and the note's ids, never replaced by them. */
  "aria-describedby"?: string;
  "aria-invalid"?: boolean | "true" | "false";
};

/**
 * A box ticked to say yes to one thing, collected into a form and saved later.
 *
 * A native `<input type="checkbox">` inside its `<label>`, so Space ticks it, a
 * click anywhere on the label does, and `aria-label`, `disabled` and the rest
 * land on the input itself. Where flipping it *is* the action, use `Switch`.
 *
 * Native rather than Kobalte's checkbox: the element already carries every
 * behaviour a checkbox needs, and the part renders on cire's portals and guest
 * site, whose bundle budgets have no room for a form-control layer.
 *
 * The outer element is a `<div>` holding the label and, under it, the note, so
 * a note that comes and goes never remounts the input or takes its focus.
 */
const Checkbox: Component<CheckboxProps> = (props) => {
  const [local, field, others] = splitProps(
    props,
    ["class", "checked", "onChange", "label", "description", "note", "box", "size", "align"],
    [
      "name",
      "value",
      "id",
      "disabled",
      "required",
      "aria-label",
      "aria-labelledby",
      "aria-describedby",
      "aria-invalid",
    ],
  );
  const titleId = createUniqueId();
  const descriptionId = createUniqueId();
  const noteId = createUniqueId();
  const description = children(() => local.description);
  const note = children(() => local.note);
  const hasDescription = () => present(description());
  const hasNote = () => present(note());
  const native = () => local.box === "native";
  const size = () => local.size ?? "md";
  const align = () => local.align ?? "center";
  const flag = (on: boolean | undefined) => (on ? "" : undefined);

  let input!: HTMLInputElement;
  // A server-rendered page that the browser restores — a reload, a back
  // navigation the cache missed — can tick or untick the input before it
  // hydrates, and hydration writes no property. Put the caller's value back
  // once mounted, so the box never shows a state the caller does not hold.
  onMount(() => {
    input.checked = local.checked;
  });

  const element = (
    <input
      ref={input}
      type="checkbox"
      // `peer` marks the drawn box's focus ring; it is not a utility.
      class={native() ? NATIVE_CHECKBOX : "peer base:sr-only"}
      checked={local.checked}
      name={field.name}
      value={field.value}
      id={field.id}
      disabled={field.disabled}
      required={field.required}
      aria-label={field["aria-label"]}
      aria-labelledby={
        field["aria-labelledby"] ??
        (hasDescription() && field["aria-label"] === undefined ? titleId : undefined)
      }
      aria-describedby={idList(
        field["aria-describedby"],
        hasDescription() && descriptionId,
        hasNote() && noteId,
      )}
      aria-invalid={field["aria-invalid"]}
      onClick={(event) => {
        // A click on the label reaches the input without focusing it in every
        // engine; focus it, so a keyboard user carries on from here.
        event.currentTarget.focus();
      }}
      onChange={(event) => {
        const next = event.currentTarget.checked;
        // Controlled: put the element back to the value it was given, and let
        // `checked` move it if the caller agrees.
        event.currentTarget.checked = local.checked;
        local.onChange?.(next);
      }}
    />
  );

  // The tick is drawn only while ticked, as Kobalte's indicator was. A contrast
  // theme drops the ring, a shadow, so focus there draws an outline instead.
  const drawnBox = (
    <span
      aria-hidden="true"
      data-checked={flag(local.checked)}
      data-disabled={flag(field.disabled)}
      class="base:border-ui-hairline-strong base:bg-ui-ground base:data-[checked]:bg-ui-accent base:data-[checked]:text-ui-on-accent base:peer-focus-visible:ring-ui-focus base:h-4 base:w-4 base:shrink-0 base:rounded-ui-sm base:border base:transition-colors base:peer-focus-visible:ring-2 base:data-[disabled]:opacity-50 base:forced-colors:peer-focus-visible:outline-2 base:forced-colors:peer-focus-visible:outline-offset-2"
    >
      <Show when={local.checked}>
        <span class="base:flex base:items-center base:justify-center">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="3"
            stroke-linecap="round"
            stroke-linejoin="round"
            class="base:h-3 base:w-3"
          >
            <path d="M20 6 9 17l-5-5" />
          </svg>
        </span>
      </Show>
    </span>
  );

  // Reactive, so a box that changes after mount draws the new one whole.
  const box = () => (native() ? element : [element, drawnBox]);

  return (
    <div class={clsx(WRAP, local.class)} {...others}>
      <label
        // The type is the row's, so the first-line box and the words share one
        // line height.
        class={
          native()
            ? clsx(NATIVE_ROW, NATIVE_TEXT[size()], ROW_ALIGN[align()])
            : clsx("base:flex base:gap-2", DRAWN_TEXT[size()], ROW_ALIGN[align()])
        }
      >
        <Show when={align() === "start"} fallback={box()}>
          <span class={FIRST_LINE}>{box()}</span>
        </Show>
        <Show when={local.label !== undefined || hasDescription()}>
          <span class={native() ? "base:min-w-0" : undefined}>
            <Show when={hasDescription()} fallback={local.label}>
              <span id={titleId} class="base:block">
                {local.label}
              </span>
              <span id={descriptionId} class={DESCRIPTION}>
                {description()}
              </span>
            </Show>
          </span>
        </Show>
      </label>
      <Show when={hasNote()}>
        <div id={noteId} class={NOTE_INDENT[native() ? "native" : "drawn"]}>
          {note()}
        </div>
      </Show>
    </div>
  );
};

export { Checkbox };
export type { CheckboxProps, ChoiceAlign, ChoiceBox, ChoiceSize };
