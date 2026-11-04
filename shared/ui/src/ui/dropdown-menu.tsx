import {
  DropdownMenu as KobalteDropdownMenu,
  type DropdownMenuContentOptions,
} from "@kobalte/core/dropdown-menu";
import { type MenuContextValue, useMenuContext } from "@kobalte/core/menu";
import type { PolymorphicProps } from "@kobalte/core/polymorphic";
import { clsx } from "clsx";
import {
  createContext,
  Show,
  splitProps,
  useContext,
  type JSX,
  type ParentComponent,
  type ValidComponent,
} from "solid-js";

import {
  MENU_CHECK_CLASS,
  menuLabelClass,
  menuPanelClass,
  menuRowClass,
  menuSeparatorClass,
  type MenuLabelTone,
  type MenuVariant,
} from "./menu-classes";
import { portalMount } from "./portal-mount";
import type { SafeProps } from "./props";
import { SWITCH_THUMB_CLASS, SWITCH_TRACK_CLASS } from "./switch-classes";

/**
 * The panel's variant, read by every row, label and separator inside it, so a
 * menu has one look and a call site sets it once, on the panel.
 */
const MenuVariantContext = createContext<MenuVariant>("default");
const useVariant = () => useContext(MenuVariantContext);

const DropdownMenu = KobalteDropdownMenu;

/**
 * What opens the menu.
 *
 * `treatment` exists for the trigger that *is* the control rather than a wrapper
 * around one. `<DropdownMenuTrigger as={Button}>` needs nothing here — the
 * button brings its own radius and focus ring — but an avatar-as-trigger has
 * neither, and a keyboard user landing on it sees nothing at all. `bare` is
 * therefore the default, so the `as={Button}` spelling is untouched.
 *
 * The ring and the radius are one choice rather than two because they cannot
 * disagree: a rectangular focus ring drawn around a circular avatar is the
 * defect, not a variation on it. The ring is a shadow, which a contrast theme
 * drops, so the outline is hidden only while the ring shows and the theme
 * paints it in the ring's place.
 */
const DROPDOWN_MENU_TRIGGER_TREATMENT = {
  bare: "",
  pill:
    "base:cursor-pointer base:rounded-ui-pill base:outline-none " +
    "base:focus-visible:ring-2 base:focus-visible:ring-ui-focus base:focus-visible:ring-offset-2 base:focus-visible:outline-hidden",
} satisfies Readonly<Record<"bare" | "pill", string>>;

/**
 * The trigger's own props. The three that write markup over its children are
 * `never` (`props.ts`): overriding them, rather than omitting them, keeps
 * `as`'s element type inferred from the call site.
 */
type DropdownMenuTriggerProps<T extends ValidComponent = "button"> = PolymorphicProps<
  T,
  {
    treatment?: keyof typeof DROPDOWN_MENU_TRIGGER_TREATMENT;
    class?: string;
    children?: JSX.Element;
    innerHTML?: never;
    innerText?: never;
    textContent?: never;
  }
>;

function DropdownMenuTrigger<T extends ValidComponent = "button">(
  props: DropdownMenuTriggerProps<T>,
) {
  const [local, others] = splitProps(props as DropdownMenuTriggerProps, ["class", "treatment"]);
  return (
    <KobalteDropdownMenu.Trigger
      class={clsx(DROPDOWN_MENU_TRIGGER_TREATMENT[local.treatment ?? "bare"], local.class)}
      {...others}
    />
  );
}

/**
 * The panel. `variant` sets the look of everything in it (`menu-classes.ts`):
 * `default`, the shared look, or `accent`, cire's portal look.
 * `onCloseAutoFocus` is Kobalte's: where focus goes as the menu closes, for a
 * menu opened by something other than its own trigger.
 *
 * With a modal dialog open it portals into it, as `PopoverContent` does
 * (`portal-mount.ts`): portalled to `<body>`, a menu opened inside `Modal`
 * would paint under the dialog and take no click. There it also carries
 * `data-kb-top-layer`, which keeps it out of the walk that hides everything
 * outside a modal from a screen reader. With no modal open it portals to
 * `<body>` with no such mark, as it always did: Kobalte reads the mark outside
 * modals too (a press inside a marked panel never counts as outside another
 * open layer), so carrying it everywhere would change every other menu.
 */
const DropdownMenuContent: ParentComponent<
  SafeProps<"div"> &
    Pick<DropdownMenuContentOptions, "onCloseAutoFocus"> & { variant?: MenuVariant }
> = (props) => {
  const [local, others] = splitProps(props, ["class", "variant", "children"]);
  const variant = () => local.variant ?? "default";
  const menu = useMenuContext();
  // The mount is found as the menu opens, not as it first renders, since a
  // modal may have opened since: the `Show` builds its child afresh on each
  // open, as Kobalte's own portal does inside it. Found once, so the portal and
  // the panel's mark agree without a second look through the document.
  return (
    <Show when={menu.contentPresent()}>
      {(() => {
        const modal = portalMount();
        return (
          <KobalteDropdownMenu.Portal mount={modal}>
            <KobalteDropdownMenu.Content
              class={clsx(menuPanelClass(variant()), local.class)}
              data-kb-top-layer={modal ? "" : undefined}
              {...others}
            >
              <MenuVariantContext.Provider value={variant()}>
                {local.children}
              </MenuVariantContext.Provider>
            </KobalteDropdownMenu.Content>
          </KobalteDropdownMenu.Portal>
        );
      })()}
    </Show>
  );
};

/** What a row takes beyond its element's own props. */
interface ItemOptions {
  /** Kobalte's: runs when the row is chosen, by a click, Enter or Space. */
  onSelect?: () => void;
  /** Kobalte's: the row stays in the menu, marked `data-disabled`, and cannot
   *  be chosen — for a choice that would change nothing right now, rather
   *  than one the reader may never make. */
  disabled?: boolean;
  /** Whether choosing the row closes the menu. Kobalte's default: it does. */
  closeOnSelect?: boolean;
  class?: string;
  children?: JSX.Element;
}

/**
 * One choice: a `div` by default, or with `as="a"` a real anchor that takes
 * `href`, `target`, `rel` and `download`. A navigation is an `<a>`, so it gets
 * a middle-click, "copy link address" and the browser's preview of where it
 * goes.
 *
 * A link is followed by the browser, never by script, so the menu waits for
 * the link's own click before it closes, and closes a task after it: an anchor
 * taken out of the document during its click goes nowhere. Every way of
 * choosing it ends in that click — a mouse, a tap (whose click can arrive well
 * after the finger lifts, where the menu's own close-on-select would already
 * have removed it), Enter, and Space, which the link answers with a click
 * because a link alone ignores Space. Disabled, it keeps no `href`, so nothing
 * follows it.
 *
 * It follows only an address a menu may lead to: a web page, a path or
 * fragment on this site, `mailto:` or `tel:`. Any other — `javascript:`,
 * `data:` — leaves the row with no `href`, as a disabled row has: a menu link
 * never carries a script or data URL, whatever its caller passed.
 *
 * A link that opens another tab or window — any `target` but `_self`,
 * `_parent` and `_top` — gets `noopener noreferrer` added to whatever `rel`
 * its caller gives, and loses an `opener`: the page it opens learns neither
 * this window nor the address it came from.
 */
type DropdownMenuItemProps =
  | (Omit<SafeProps<"div">, keyof ItemOptions> & ItemOptions & { as?: "div" })
  | (Omit<SafeProps<"a">, keyof ItemOptions | "onClick" | "onKeyDown"> &
      Omit<ItemOptions, "closeOnSelect"> & { as: "a" });

type LinkItemProps = Extract<DropdownMenuItemProps, { as: "a" }>;

function DropdownMenuItem(props: DropdownMenuItemProps) {
  const variant = useVariant();
  const [local, others] = splitProps(props, ["class", "onSelect"]);
  return (
    <Show
      when={props.as === "a"}
      fallback={
        <KobalteDropdownMenu.Item
          class={clsx(menuRowClass(variant), local.class)}
          onSelect={local.onSelect}
          {...(others as Omit<SafeProps<"div">, keyof ItemOptions> & ItemOptions)}
        />
      }
    >
      <LinkItem {...(others as LinkItemProps)} class={local.class} onSelect={local.onSelect} />
    </Show>
  );
}

/** The schemes a menu link may follow. A relative address resolves to the page's own. */
const FOLLOWABLE = new Set(["http:", "https:", "mailto:", "tel:"]);

/** `href` when a menu link may follow it, else nothing. */
function followable(href: string | undefined): string | undefined {
  if (href === undefined) return undefined;
  try {
    const base = typeof document === "undefined" ? "https://localhost/" : document.baseURI;
    return FOLLOWABLE.has(new URL(href, base).protocol) ? href : undefined;
  } catch {
    return undefined;
  }
}

/** The targets that keep the link in this browsing context. */
const SAME_CONTEXT = new Set(["", "_self", "_parent", "_top"]);

/**
 * The caller's `rel`, with `noopener` and `noreferrer` added and `opener`
 * dropped when the link opens another browsing context.
 */
function relFor(target: string | undefined, rel: string | undefined): string | undefined {
  const tokens = (rel ?? "").split(/\s+/).filter(Boolean);
  if (target === undefined || SAME_CONTEXT.has(target.toLowerCase())) {
    return tokens.length > 0 ? tokens.join(" ") : undefined;
  }
  const kept = tokens.filter((token) => token.toLowerCase() !== "opener");
  for (const cut of ["noopener", "noreferrer"]) {
    if (!kept.some((token) => token.toLowerCase() === cut)) kept.push(cut);
  }
  return kept.join(" ");
}

function LinkItem(props: LinkItemProps) {
  const variant = useVariant();
  const menu = useMenuContext();
  const [local, others] = splitProps(props, ["class", "href", "rel", "target", "disabled"]);
  return (
    <KobalteDropdownMenu.Item
      {...(others as Omit<SafeProps<"div">, keyof ItemOptions> & ItemOptions)}
      as="a"
      class={clsx(menuRowClass(variant), local.class)}
      href={local.disabled ? undefined : followable(local.href)}
      target={local.target}
      rel={relFor(local.target, local.rel)}
      disabled={local.disabled}
      closeOnSelect={false}
      onClick={() => {
        if (!local.disabled) setTimeout(() => menu.close(true), 0);
      }}
      onKeyDown={(event: KeyboardEvent) => {
        if (event.key !== " " || event.repeat || local.disabled) return;
        event.preventDefault();
        (event.currentTarget as HTMLAnchorElement).click();
      }}
    />
  );
}

/** The trailing check on a chosen row, in the accent's readable ink. */
function CheckMark() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      class="base:size-3.5"
    >
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

/**
 * A row that is on or off. `indicator` is how it says so: `check`, the default,
 * a trailing check while on; `switch`, the shared `Switch`'s own track and
 * thumb, drawn for the eye alone — the row carries the state
 * (`menuitemcheckbox`, `aria-checked`). It stays open when chosen unless
 * `closeOnSelect` says otherwise, so a setting can be tried and tried again.
 */
const DropdownMenuCheckboxItem: ParentComponent<
  Omit<SafeProps<"div">, "onChange" | keyof ItemOptions> &
    Omit<ItemOptions, "onSelect"> & {
      checked: boolean;
      onChange?: (checked: boolean) => void;
      indicator?: "check" | "switch";
    }
> = (props) => {
  const variant = useVariant();
  const [local, others] = splitProps(props, ["class", "children", "indicator", "checked"]);
  const on = () => (local.checked ? "" : undefined);
  return (
    <KobalteDropdownMenu.CheckboxItem
      class={clsx(menuRowClass(variant), local.class)}
      checked={local.checked}
      {...others}
    >
      {local.children}
      {local.indicator === "switch" ? (
        <span
          aria-hidden="true"
          data-menu-switch=""
          data-checked={on()}
          class={clsx(MENU_CHECK_CLASS, SWITCH_TRACK_CLASS)}
        >
          <span data-checked={on()} class={SWITCH_THUMB_CLASS} />
        </span>
      ) : (
        <KobalteDropdownMenu.ItemIndicator data-menu-check="" class={MENU_CHECK_CLASS}>
          <CheckMark />
        </KobalteDropdownMenu.ItemIndicator>
      )}
    </KobalteDropdownMenu.CheckboxItem>
  );
};

/** One choice of several. The chosen row carries a trailing check. */
const DropdownMenuRadioGroup: ParentComponent<{
  value: string;
  onChange?: (value: string) => void;
}> = (props) => (
  <KobalteDropdownMenu.RadioGroup value={props.value} onChange={props.onChange}>
    {props.children}
  </KobalteDropdownMenu.RadioGroup>
);

const DropdownMenuRadioItem: ParentComponent<
  Omit<SafeProps<"div">, keyof ItemOptions> & Omit<ItemOptions, "onSelect"> & { value: string }
> = (props) => {
  const variant = useVariant();
  const [local, others] = splitProps(props, ["class", "children"]);
  return (
    <KobalteDropdownMenu.RadioItem class={clsx(menuRowClass(variant), local.class)} {...others}>
      {local.children}
      <KobalteDropdownMenu.ItemIndicator data-menu-check="" class={MENU_CHECK_CLASS}>
        <CheckMark />
      </KobalteDropdownMenu.ItemIndicator>
    </KobalteDropdownMenu.RadioItem>
  );
};

/**
 * A group's label. Three jobs:
 *
 * - `heading` names a group of items and leads the menu — semibold, full ink.
 * - `identity` is the block at the top of an account menu that says *who you
 *   are signed in as*: context rather than a heading, so it recedes.
 * - `eyebrow` leads a group of rows in small caps, in the secondary ink.
 */
const DropdownMenuLabel: ParentComponent<SafeProps<"span"> & { tone?: MenuLabelTone }> = (
  props,
) => {
  const variant = useVariant();
  const [local, others] = splitProps(props, ["class", "tone"]);
  return (
    <KobalteDropdownMenu.GroupLabel
      class={clsx(menuLabelClass(variant, local.tone ?? "heading"), local.class)}
      {...others}
    />
  );
};

const DropdownMenuSeparator: ParentComponent<SafeProps<"hr">> = (props) => {
  const variant = useVariant();
  const [local, others] = splitProps(props, ["class"]);
  return (
    <KobalteDropdownMenu.Separator
      class={clsx(menuSeparatorClass(variant), local.class)}
      {...others}
    />
  );
};

/** The menu a `DropdownMenu` root holds, as {@link DropdownMenuHandle} hands it out. */
type DropdownMenuHandleValue = MenuContextValue;

/**
 * Hands out the menu its `DropdownMenu` root holds, from inside it. For one
 * menu shared by a list of plain buttons (`wiki/shared/component-library.md`
 * §One popup for a list): the buttons call its `open("first")`,
 * `open("last")` or `open(true)`, as Kobalte's own trigger does, so focus lands
 * where a keyboard user expects.
 */
function DropdownMenuHandle(props: { ref: (menu: DropdownMenuHandleValue) => void }) {
  props.ref(useMenuContext());
  return null;
}

/** A group of rows, which a label names. Takes no markup props (`props.ts`). */
const DropdownMenuGroup: ParentComponent<SafeProps<"div">> = (props) => (
  <KobalteDropdownMenu.Group {...props} />
);

export {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuCheckboxItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuGroup,
  DropdownMenuHandle,
};
export type { DropdownMenuHandleValue, DropdownMenuItemProps };
