import { buttonClass } from "@cire/ui/button";
import { createSignal, createUniqueId, Index, onCleanup, Show } from "solid-js";

import { Z_CLASS } from "../lib/z-index";
import { moveFocus, pressedByPointer } from "./quiet-focus";

/** One way out of the menu: a link to another site, or a file to save. */
export interface LinkMenuItem {
  label: string;
  href: string;
  /**
   * A filename: the item saves the file at `href` rather than opening it. Absent,
   * the link opens in a new tab with no opener and no referrer.
   */
  download?: string;
}

export interface LinkMenuProps {
  /** The trigger's words, which are its name. */
  label: string;
  /** The menu's accessible name ("Add to calendar options"). */
  menuLabel: string;
  items: readonly LinkMenuItem[];
  /** Runs as the menu opens, before it renders: for an item built on demand. */
  onOpen?: () => void;
  /** Classes added to the trigger, for its place in the row: `mt-1`. */
  class?: string;
}

/**
 * The trigger: a text action, like every other action in the details panel.
 * Not a box: the sheet's switch is the one control drawn as one. `touchLink`,
 * because the invite is read on a phone, where an underline that waits for
 * hover never shows, and nothing else would mark these words as something to
 * press. `min-h-11` keeps a 44px target round a line of text.
 */
const TRIGGER_CLASS = `${buttonClass({ variant: "touchLink", size: "md" })} min-h-11`;

/**
 * Each item a 44px row, filled gold under the pointer, while keyboard focus is
 * on it, and while a finger presses it. Not on focus alone: a tap focuses the
 * link it lands on, and an item filled for a pointer's focus reads as chosen.
 */
const ITEM_CLASS =
  "font-body text-text-muted hover:bg-gold hover:text-on-gold focus-visible:bg-gold focus-visible:text-on-gold active:bg-gold active:text-on-gold text-ui-sm tracking-ui-normal flex min-h-11 items-center rounded-sm px-3 transition-[color,background-color,border-color,text-decoration-color] duration-(--dur-fast) ease-(--ease-out) focus-visible:outline-none";

/** The menu's `min-w-56`, for placing it before it has been measured. */
const MENU_WIDTH = 224;

/** One item's 44px, the `gap-1` between items, and the `p-2` and border round them. */
const ITEM_HEIGHT = 44;
const ITEM_GAP = 4;
const MENU_CHROME = 2 * 8 + 2;

/**
 * The menu's height before it has been measured, for `count` items. Used for
 * the first placement only; once shown, the menu is measured and placed again.
 */
function estimatedMenuHeight(count: number): number {
  return count * ITEM_HEIGHT + Math.max(0, count - 1) * ITEM_GAP + MENU_CHROME;
}

/** Space kept between the menu, its trigger and the viewport's edges. */
const MARGIN = 8;

interface PopoverPosition {
  top: number;
  left: number;
}

/**
 * A text action that opens a menu of links — "Add to calendar" and its two
 * calendars, "Open in maps" and its map apps.
 *
 * ## Opening
 *
 * By keyboard, the ARIA menu-button pattern: Enter or Space on the trigger
 * opens the menu on its first item, ArrowDown too, and ArrowUp on its last.
 *
 * By a tap or a click, on the menu itself rather than an item, and quietly
 * (`quiet-focus.ts`): the guest has chosen nothing yet, and an item filled gold
 * the moment the menu opens reads as already chosen. The arrows reach the
 * items from there. A click is a pointer's when it carries a `pointerType`
 * (Chromium) or counts presses in `detail` (Firefox, Safari); a screen
 * reader's synthesised click may read either way, and one read as a pointer's
 * lands on the menu, whose items the arrows reach.
 *
 * ## Keys in the menu
 *
 * ArrowDown and ArrowUp move between the items and wrap round, Home and End go
 * to either end, and Escape closes it with focus back on the trigger. Choosing
 * an item closes it onto the trigger too: the item goes with the menu, and
 * focus left on it would fall to the document's `<body>`, outside the modal
 * sheet. Tab closes it as well, from the trigger, so the browser carries on to
 * whatever comes next. The items are out of the Tab order (`tabindex="-1"`);
 * the arrows reach them.
 *
 * Every key the menu takes cancels its default action. The menu's DOM sits
 * inside the sheet's focusable scrollport, where an arrow, Home or End would
 * otherwise scroll the sheet under a menu fixed to the viewport.
 *
 * ## Where it paints
 *
 * In the top layer, as a `popover`, rendered in place: the sheet is a modal
 * dialog, which paints above every stacking context and makes everything
 * outside it inert, so a menu portalled elsewhere or ranked by `z-index` would
 * be hidden behind the sheet or dead in front of it.
 */
export function LinkMenu(props: LinkMenuProps) {
  const [open, setOpen] = createSignal(false);
  const [position, setPosition] = createSignal<PopoverPosition>({ top: 0, left: 0 });
  const popoverId = createUniqueId();

  let buttonRef: HTMLButtonElement | undefined;
  let popoverRef: HTMLDivElement | undefined;

  /** The menu's items, in order. */
  function items(): HTMLElement[] {
    return popoverRef ? [...popoverRef.querySelectorAll<HTMLElement>('[role="menuitem"]')] : [];
  }

  /** Close the menu, leaving focus wherever it is. */
  function dismiss() {
    setOpen(false);
    detachListeners();
  }

  /** Close the menu and hand focus back to its trigger. */
  function close() {
    dismiss();
    buttonRef?.focus();
  }

  /**
   * Anchor the (position:fixed) popover to the button: under it when it fits,
   * over it when only that fits, and under it when neither does (a viewport
   * shorter than the menu either way, where under is where a reader looks
   * first). Sideways it is clamped inside the viewport with the same gutter.
   *
   * The coordinates are viewport coordinates, which is right because the menu
   * is in the top layer: its containing block is the viewport whatever the
   * button's ancestors do, so nothing here has to know about the sheet's
   * scrollport or its `overflow: hidden`.
   */
  function updatePosition() {
    if (!buttonRef) return;
    const rect = buttonRef.getBoundingClientRect();
    const width = popoverRef?.offsetWidth || MENU_WIDTH;
    const height = popoverRef?.offsetHeight || estimatedMenuHeight(props.items.length);
    const maxLeft = Math.max(MARGIN, window.innerWidth - width - MARGIN);
    const left = Math.min(rect.left, maxLeft);
    const below = rect.bottom + MARGIN;
    const above = rect.top - MARGIN - height;
    const fitsBelow = below + height <= window.innerHeight - MARGIN;
    setPosition({ top: !fitsBelow && above >= MARGIN ? above : below, left });
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  }

  /** Move focus within the open menu: the arrows wrap, Home and End jump. */
  function onMenuKeyDown(e: KeyboardEvent) {
    const list = items();
    if (list.length === 0) return;
    const at = list.indexOf(document.activeElement as HTMLElement);
    let next: number;
    switch (e.key) {
      case "ArrowDown":
        next = at < 0 ? 0 : (at + 1) % list.length;
        break;
      case "ArrowUp":
        next = at < 0 ? list.length - 1 : (at - 1 + list.length) % list.length;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = list.length - 1;
        break;
      case "Tab":
        // Back to the trigger, then let the browser's own Tab move on from it.
        close();
        return;
      default:
        return;
    }
    e.preventDefault();
    list[next]?.focus();
  }

  function onDocumentPointer(e: MouseEvent) {
    const target = e.target as Node | null;
    if (!target) return;
    if (popoverRef?.contains(target)) return;
    if (buttonRef?.contains(target)) return;
    dismiss();
  }

  // rAF-throttled reposition: scroll / resize can fire many times per frame on
  // touch-momentum scroll, and each call would read layout (`getBoundingClientRect`)
  // and write a signal. Coalesce into one update per frame.
  let rafPending = false;
  function onScrollOrResize() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      updatePosition();
    });
  }

  // Listeners attach only while the popover is open, and detach on every close
  // (or unmount via the `onCleanup` below).
  let listenersAttached = false;
  function attachListeners() {
    if (listenersAttached) return;
    listenersAttached = true;
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("mousedown", onDocumentPointer);
    // Capture-phase scroll catches nested scroll containers too — the menu is
    // positioned against the viewport, so a scroll of the sheet it sits in
    // would otherwise drift it away from the anchor button.
    window.addEventListener("scroll", onScrollOrResize, { capture: true, passive: true });
    window.addEventListener("resize", onScrollOrResize);
  }
  function detachListeners() {
    if (!listenersAttached) return;
    listenersAttached = false;
    document.removeEventListener("keydown", onKeyDown);
    document.removeEventListener("mousedown", onDocumentPointer);
    window.removeEventListener("scroll", onScrollOrResize, { capture: true });
    window.removeEventListener("resize", onScrollOrResize);
  }

  // Catch the rare case where the component unmounts while open — detach
  // without firing close() since there is no button left to focus.
  onCleanup(detachListeners);

  /**
   * Open the menu with focus on its first item, its last, or — for a
   * pointer's open — on the menu itself, quietly.
   */
  function show(focus: "first" | "last" | "menu") {
    props.onOpen?.();
    updatePosition();
    attachListeners();
    setOpen(true);
    queueMicrotask(() => {
      if (focus === "menu") {
        moveFocus(popoverRef, true);
        return;
      }
      const list = items();
      (focus === "first" ? list[0] : list.at(-1))?.focus();
    });
  }

  function toggle(e: MouseEvent) {
    if (open()) {
      dismiss();
      return;
    }
    show(pressedByPointer(e) ? "menu" : "first");
  }

  function onTriggerKeyDown(e: KeyboardEvent) {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    show(e.key === "ArrowDown" ? "first" : "last");
  }

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        class={props.class ? `${TRIGGER_CLASS} ${props.class}` : TRIGGER_CLASS}
        aria-haspopup="menu"
        aria-expanded={open()}
        aria-controls={popoverId}
        onClick={toggle}
        onKeyDown={onTriggerKeyDown}
      >
        {props.label}
      </button>
      <Show when={open()}>
        <div
          ref={(el) => {
            popoverRef = el;
            // The top layer, entered from here rather than from a z-index.
            //
            // This menu is opened from INSIDE the details sheet, which is a
            // `showModal()` dialog — and a modal dialog paints above every
            // stacking context in the document by definition, so no `z-index`
            // can put the menu over it. Rendered behind the sheet, a menu is
            // invisible and unclickable. Showing a popover puts this in the
            // top layer too.
            //
            // `manual` because this component already owns Escape, the
            // outside-click dismissal and the focus return; `auto` would
            // light-dismiss underneath all three.
            //
            // The attribute is set here rather than written in the JSX so it
            // exists only where the method does. A `[popover]` element that
            // has never been shown is `display: none`, so in an environment
            // without the API — jsdom, or a server render — writing it would
            // hide the menu outright instead of degrading to the z-index.
            if (typeof el.showPopover !== "function") return;
            el.setAttribute("popover", "manual");
            // A microtask later, because a `ref` callback runs BEFORE the
            // element is inserted, and `showPopover()` on a disconnected
            // element throws `InvalidStateError`. Placed again once shown,
            // now that it can be measured.
            queueMicrotask(() => {
              if (!el.isConnected) return;
              el.showPopover();
              updatePosition();
            });
          }}
          id={popoverId}
          role="menu"
          aria-label={props.menuLabel}
          // Focusable by script only, as a menu takes its keys: focus lives on
          // the items, or on the menu after a pointer's open, and a click on
          // the menu's own padding lands here, where the arrows still reach
          // the first and last items.
          tabindex="-1"
          onKeyDown={onMenuKeyDown}
          // `inset-auto m-0` undo the user-agent styles a `popover` carries
          // (`inset: 0; margin: auto`), which would otherwise fight the
          // measured `top`/`left` below and stretch the box across the
          // viewport.
          class={`border-border bg-surface-raised fixed ${Z_CLASS.MODAL_POPOVER} inset-auto m-0 flex max-w-[calc(100vw-1rem)] min-w-56 flex-col gap-1 rounded-md border p-2 shadow-lg`}
          style={{ top: `${position().top}px`, left: `${position().left}px` }}
        >
          <Index each={props.items}>
            {(item) => (
              <a
                role="menuitem"
                tabindex="-1"
                href={item().href}
                download={item().download}
                target={item().download === undefined ? "_blank" : undefined}
                rel={item().download === undefined ? "noopener noreferrer" : undefined}
                class={ITEM_CLASS}
                onClick={close}
              >
                {item().label}
              </a>
            )}
          </Index>
        </div>
      </Show>
    </>
  );
}
