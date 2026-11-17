import { clsx } from "clsx";
import {
  children,
  createContext,
  createUniqueId,
  onMount,
  Show,
  splitProps,
  useContext,
  type Component,
  type JSX,
} from "solid-js";

import {
  DESCRIPTION,
  DRAWN_FADE,
  DRAWN_FOCUS,
  DRAWN_HOVER,
  DRAWN_ROW,
  DRAWN_TEXT,
  FIRST_LINE,
  idList,
  NATIVE_RADIO,
  NATIVE_ROW,
  NATIVE_TEXT,
  present,
  TOUCH_PULL,
  TOUCH_ROW,
  type ChoiceBox,
  type ChoiceSize,
} from "./choice";
import type { SafeProps } from "./props";

/** How the group lays its radios out. */
export type RadioOrientation = "horizontal" | "vertical";

type RadioGroupProps = Omit<SafeProps<"div">, "onChange"> & {
  /** The chosen value; `""` for none yet. Controlled: the group shows this and
   *  nothing else, so a choice the caller refuses never shows as made. */
  value: string;
  /** Asked for the value a radio was chosen for. */
  onChange?: (value: string) => void;
  /** Shared by every radio. Native radios exclude each other, and answer the
   *  arrow keys, only within one name, so one is made up when none is given. */
  name?: string;
  /** Every radio unavailable. */
  disabled?: boolean;
  /** {@link ChoiceBox}. `drawn` by default; `native` draws the browser's radio. */
  box?: ChoiceBox;
  /** {@link ChoiceSize} — every label's type step. `md` by default. */
  size?: ChoiceSize;
  /**
   * `horizontal` (the default) puts the radios in a row, `vertical` one under
   * another. Layout only, so no `aria-orientation`: native radios answer all
   * four arrow keys whichever it is, and a group laid out by its caller's own
   * class would otherwise announce the wrong one.
   */
  orientation?: RadioOrientation;
  /**
   * Below `md`, every radio a 44px target: each row padded to it, the rows
   * abutting, and the group pulled in by the same amount, so it sits where it
   * would without and its options stay evenly apart whatever their length.
   */
  touch?: boolean;
};

type RadioContextValue = {
  name: () => string;
  value: () => string;
  choose: (input: HTMLInputElement) => void;
  disabled: () => boolean;
  box: () => ChoiceBox;
  size: () => ChoiceSize;
  touch: () => boolean;
};

const RadioContext = createContext<RadioContextValue>();

/**
 * Root gap and direction, either box: 16px between radios in a row, twice the
 * radio-to-words gap so each radio reads with its own words, and 8px in a
 * column. A column lays each radio out at its own width, so only the radio and
 * its words answer a click, as a `Checkbox` does. With `touch`, below `md`, the
 * rows' own padding spaces them, so they abut.
 */
const ROOT = {
  horizontal: "base:flex base:flex-wrap base:gap-x-4 base:gap-y-2",
  vertical: "base:flex base:flex-col base:items-start base:gap-2",
} satisfies Readonly<Record<RadioOrientation, string>>;

const ROOT_TOUCH = `max-md:base:gap-y-0 ${TOUCH_PULL}`;

/**
 * One choice among several, collected into a form.
 *
 * A `role="radiogroup"` around native `<input type="radio">`s that share one
 * `name`: Tab enters on the chosen radio, the arrow keys move and choose, and a
 * click on a radio's label chooses it. Name the group — `aria-label`, or
 * `aria-labelledby` pointing at the legend or heading above it.
 */
const RadioGroup: Component<RadioGroupProps> = (props) => {
  const [local, others] = splitProps(props, [
    "class",
    "value",
    "onChange",
    "name",
    "disabled",
    "box",
    "size",
    "orientation",
    "touch",
    "children",
  ]);
  const fallbackName = createUniqueId();
  const name = () => local.name ?? fallbackName;
  let root: HTMLDivElement | undefined;

  /** Every radio back to the value the group was given. */
  const restore = () => {
    for (const radio of root?.querySelectorAll<HTMLInputElement>('input[type="radio"]') ?? []) {
      if (radio.name === name()) radio.checked = radio.value === local.value;
    }
  };

  // A server-rendered page that the browser restores — a reload, a back
  // navigation the cache missed — can choose a radio before it hydrates, and
  // hydration writes no property. Put the caller's value back once mounted.
  onMount(restore);

  const choose = (input: HTMLInputElement) => {
    const next = input.value;
    // Controlled: put every radio back to the value the group was given, and
    // let `value` move them if the caller agrees.
    restore();
    local.onChange?.(next);
  };

  return (
    <RadioContext.Provider
      value={{
        name,
        value: () => local.value,
        choose,
        disabled: () => local.disabled === true,
        box: () => local.box ?? "drawn",
        size: () => local.size ?? "md",
        touch: () => local.touch === true,
      }}
    >
      <div
        ref={root}
        role="radiogroup"
        class={clsx(
          ROOT[local.orientation ?? "horizontal"],
          // The rows' own step and leading, so the pull-in's `lh` is a row's line.
          DRAWN_TEXT[local.size ?? "md"],
          local.touch && ROOT_TOUCH,
          local.class,
        )}
        {...others}
      >
        {local.children}
      </div>
    </RadioContext.Provider>
  );
};

type RadioGroupItemProps = Omit<SafeProps<"label">, "children"> & {
  value: string;
  /** The words beside the radio, inside its `<label>`. JSX, so a second line or
   *  a link is the caller's to put here. */
  label: JSX.Element;
  /** A line under the words, inside the label: what choosing this does. The
   *  radio is then named by `label` alone and described by this. */
  description?: JSX.Element;
  disabled?: boolean;
  /** Joined with the description's id, never replaced by it. */
  "aria-describedby"?: string;
};

const RadioGroupItem: Component<RadioGroupItemProps> = (props) => {
  const [local, others] = splitProps(props, [
    "class",
    "value",
    "label",
    "description",
    "disabled",
    "aria-describedby",
  ]);
  const group = useContext(RadioContext);
  if (!group) throw new Error("RadioGroupItem renders inside a RadioGroup");
  const titleId = createUniqueId();
  const descriptionId = createUniqueId();
  const description = children(() => local.description);
  const hasDescription = () => present(description());
  const chosen = () => group.value() === local.value;
  const off = () => local.disabled === true || group.disabled();
  const native = () => group.box() === "native";
  const flag = (on: boolean) => (on ? "" : undefined);

  const input = (
    <input
      type="radio"
      // `peer` marks the drawn circle's focus outline; it is not a utility.
      class={native() ? NATIVE_RADIO : "peer base:sr-only"}
      name={group.name()}
      value={local.value}
      checked={chosen()}
      disabled={off()}
      aria-labelledby={hasDescription() ? titleId : undefined}
      aria-describedby={idList(local["aria-describedby"], hasDescription() && descriptionId)}
      onClick={(event) => {
        // A click on the label reaches the input without focusing it in every
        // engine; focus it, so the arrow keys carry on from here.
        event.currentTarget.focus();
      }}
      onChange={(event) => group.choose(event.currentTarget)}
    />
  );

  // The dot is drawn only while chosen, as Kobalte's indicator was: an 8px
  // disc in the circle's one grid cell, so it is centred by layout, not by
  // arithmetic, and 3px of ground ring it inside the edge. A contrast theme
  // would repaint it in the circle's own colour, so there it keeps the theme's
  // text colour (its `currentColor`).
  const circle = (
    <span
      aria-hidden="true"
      data-checked={flag(chosen())}
      data-disabled={flag(off())}
      class={clsx(
        "base:border-ui-choice-edge base:bg-ui-ground base:data-[checked]:border-ui-accent base:grid base:size-4 base:shrink-0 base:place-items-center base:rounded-ui-pill base:border base:data-[disabled]:opacity-50",
        DRAWN_FADE,
        DRAWN_HOVER,
        DRAWN_FOCUS,
      )}
    >
      <Show when={chosen()}>
        <span class="base:bg-ui-accent base:size-2 base:rounded-full base:forced-colors:forced-color-adjust-none base:forced-colors:bg-current" />
      </Show>
    </span>
  );

  // Reactive, so a box that changes after mount draws the new one whole.
  const box = () => (native() ? input : [input, circle]);

  return (
    <label
      class={clsx(
        native() ? NATIVE_ROW : DRAWN_ROW,
        // The type is the row's, so the first-line slot and the words share one line.
        native() ? NATIVE_TEXT[group.size()] : DRAWN_TEXT[group.size()],
        group.touch() && TOUCH_ROW,
        local.class,
      )}
      data-disabled={flag(off())}
      {...others}
    >
      <span class={FIRST_LINE}>{box()}</span>
      <span class="base:min-w-0">
        <Show when={hasDescription()} fallback={local.label}>
          <span id={titleId} class="base:block">
            {local.label}
          </span>
          <span id={descriptionId} class={DESCRIPTION}>
            {description()}
          </span>
        </Show>
      </span>
    </label>
  );
};

export { RadioGroup, RadioGroupItem };
export type { RadioGroupProps, RadioGroupItemProps, ChoiceBox, ChoiceSize };
