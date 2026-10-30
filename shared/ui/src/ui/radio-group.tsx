import { clsx } from "clsx";
import {
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
  DRAWN_TEXT,
  FIRST_LINE,
  NATIVE_RADIO,
  NATIVE_ROW,
  NATIVE_TEXT,
  ROW_ALIGN,
  type ChoiceAlign,
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
};

type RadioContextValue = {
  name: () => string;
  value: () => string;
  choose: (input: HTMLInputElement) => void;
  disabled: () => boolean;
  box: () => ChoiceBox;
  size: () => ChoiceSize;
};

const RadioContext = createContext<RadioContextValue>();

/**
 * Root gap and direction. Native: 16px between radios in a row, twice the
 * box-to-label gap so each radio reads with its own word, and 8px in a column.
 * Drawn keeps pulse's 8px either way. A column lays each radio out at its own
 * width, so only the radio and its words answer a click, as a `Checkbox` does.
 */
const ROOT = {
  native: {
    horizontal: "base:flex base:flex-wrap base:gap-x-4 base:gap-y-2",
    vertical: "base:flex base:flex-col base:items-start base:gap-2",
  },
  drawn: {
    horizontal: "base:flex base:gap-2 base:text-ui-base",
    vertical: "base:flex base:flex-col base:items-start base:gap-2 base:text-ui-base",
  },
} satisfies Readonly<Record<ChoiceBox, Readonly<Record<RadioOrientation, string>>>>;

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
      }}
    >
      <div
        ref={root}
        role="radiogroup"
        class={clsx(ROOT[local.box ?? "drawn"][local.orientation ?? "horizontal"], local.class)}
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
  disabled?: boolean;
  /** {@link ChoiceAlign}. `center` by default; `start` for a label that wraps. */
  align?: ChoiceAlign;
  "aria-describedby"?: string;
};

const RadioGroupItem: Component<RadioGroupItemProps> = (props) => {
  const [local, others] = splitProps(props, [
    "class",
    "value",
    "label",
    "disabled",
    "align",
    "aria-describedby",
  ]);
  const group = useContext(RadioContext);
  if (!group) throw new Error("RadioGroupItem renders inside a RadioGroup");
  const chosen = () => group.value() === local.value;
  const off = () => local.disabled === true || group.disabled();
  const native = () => group.box() === "native";
  const align = () => local.align ?? "center";
  const flag = (on: boolean) => (on ? "" : undefined);

  const input = (
    <input
      type="radio"
      // `peer` marks the drawn circle's focus ring; it is not a utility.
      class={native() ? NATIVE_RADIO : "peer base:sr-only"}
      name={group.name()}
      value={local.value}
      checked={chosen()}
      disabled={off()}
      aria-describedby={local["aria-describedby"]}
      onClick={(event) => {
        // A click on the label reaches the input without focusing it in every
        // engine; focus it, so the arrow keys carry on from here.
        event.currentTarget.focus();
      }}
      onChange={(event) => group.choose(event.currentTarget)}
    />
  );

  // The dot is drawn only while chosen, as Kobalte's indicator was. A contrast
  // theme would repaint it in the circle's own colour, so there it keeps the
  // theme's text colour (its `currentColor`); and focus, whose ring is a shadow the theme drops,
  // draws an outline.
  const circle = (
    <span
      aria-hidden="true"
      data-checked={flag(chosen())}
      data-disabled={flag(off())}
      class="base:border-ui-hairline-strong base:bg-ui-ground base:data-[checked]:border-ui-accent base:peer-focus-visible:ring-ui-focus base:aspect-square base:h-4 base:w-4 base:rounded-ui-pill base:border base:transition-colors base:peer-focus-visible:ring-2 base:data-[disabled]:opacity-50 base:forced-colors:peer-focus-visible:outline-2 base:forced-colors:peer-focus-visible:outline-offset-2"
    >
      <Show when={chosen()}>
        <span class="base:after:bg-ui-accent base:flex base:items-center base:justify-center base:after:block base:after:h-2.5 base:after:w-2.5 base:after:rounded-full base:forced-colors:after:forced-color-adjust-none base:forced-colors:after:bg-current" />
      </Show>
    </span>
  );

  // Reactive, so a box that changes after mount draws the new one whole.
  const box = () => (native() ? input : [input, circle]);

  return (
    <label
      class={clsx(
        native()
          ? NATIVE_ROW
          : "base:flex base:cursor-pointer base:gap-1 base:data-[disabled]:cursor-not-allowed",
        // The type is the row's, so the first-line box and the words share one line.
        native() ? NATIVE_TEXT[group.size()] : DRAWN_TEXT[group.size()],
        ROW_ALIGN[align()],
        local.class,
      )}
      data-disabled={flag(off())}
      {...others}
    >
      <Show when={align() === "start"} fallback={box()}>
        <span class={FIRST_LINE}>{box()}</span>
      </Show>
      <span class={native() ? "base:min-w-0" : undefined}>{local.label}</span>
    </label>
  );
};

export { RadioGroup, RadioGroupItem };
export type { RadioGroupProps, RadioGroupItemProps, ChoiceAlign, ChoiceBox, ChoiceSize };
