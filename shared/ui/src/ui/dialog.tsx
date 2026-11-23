import {
  Dialog as KobalteDialog,
  useDialogContext,
  type DialogContentOptions,
  type DialogContextValue,
} from "@kobalte/core/dialog";
import type { PolymorphicProps } from "@kobalte/core/polymorphic";
import { clsx } from "clsx";
import {
  createContext,
  createEffect,
  createSignal,
  on,
  onCleanup,
  onMount,
  Show,
  splitProps,
  useContext,
  type Accessor,
  type Component,
  type ComponentProps,
  type JSX,
  type ParentComponent,
  type ValidComponent,
} from "solid-js";

import { readsLinearEasing, settleCurve } from "../lib/spring";
import {
  closesOnRelease,
  dragOffset,
  releaseSpeed,
  SAMPLE_KEEP_MS,
  sheetSpeed,
  slopFor,
  type DragSample,
} from "./sheet-drag";

const Dialog = KobalteDialog;
const DialogTrigger = KobalteDialog.Trigger;
/**
 * The close control of a dialog.
 *
 * `treatment` exists because the corner "×" is not a button that happens to
 * hold a multiplication sign — it is a glyph that has to be optically the size
 * of the title beside it, sit on its own baseline rather than a line box, and
 * recede until pointed at. Two products had spelled the same four utilities out
 * on it. `bare` is the default so a dialog whose close control is a real
 * labelled button (`<DialogClose as={Button}>Cancel</DialogClose>`) is unstyled
 * here and styled by that button.
 */
const DIALOG_CLOSE_TREATMENT = {
  bare: "",
  glyph:
    "base:text-ui-ink-secondary base:hover:text-ui-ink base:text-ui-lg base:leading-none " +
    "base:transition-colors",
} satisfies Readonly<Record<"bare" | "glyph", string>>;

/**
 * Polymorphic, because `as={Button}` is the documented way to spell the labelled
 * close control the `bare` treatment exists for. A concrete
 * `ComponentProps<"button">` here would drop Kobalte's `as` from the type while
 * leaving it working at runtime — the prop lands in `others` and Kobalte honours
 * it — so the contract and the behaviour would disagree silently.
 */
type DialogCloseProps<T extends ValidComponent = "button"> = PolymorphicProps<
  T,
  { treatment?: keyof typeof DIALOG_CLOSE_TREATMENT; class?: string; children?: JSX.Element }
>;

function DialogClose<T extends ValidComponent = "button">(props: DialogCloseProps<T>) {
  const [local, others] = splitProps(props as DialogCloseProps, ["class", "treatment"]);
  return (
    <KobalteDialog.CloseButton
      class={clsx(DIALOG_CLOSE_TREATMENT[local.treatment ?? "bare"], local.class)}
      {...others}
    />
  );
}

const DialogPortal: ParentComponent = (props) => {
  return <KobalteDialog.Portal>{props.children}</KobalteDialog.Portal>;
};

/**
 * How the scrim comes and goes, by presentation. As a card it fades on the
 * card's keyframes. Behind a sheet below `md` it fades by an `opacity`
 * transition on the sheet's pace, so it darkens as the sheet rises, or under
 * reduced motion as the sheet fades in, and turns round with it; the sheet's
 * two motion utilities also run keyframes that
 * move nothing, which tell Kobalte how long to keep it mounted
 * (`tokens.css`). Each width sets only its own properties, so neither
 * depends on Tailwind's order of `md:` and `max-md:`.
 */
const DIALOG_SCRIM_MOTION = {
  centred:
    "base:data-[expanded]:animate-in base:data-[closed]:animate-out base:data-[closed]:fade-out-0 base:data-[expanded]:fade-in-0",
  sheet:
    "md:base:data-[expanded]:animate-in md:base:data-[closed]:animate-out md:base:data-[closed]:fade-out-0 md:base:data-[expanded]:fade-in-0 " +
    "max-md:base:data-[expanded]:animate-sheet-in max-md:base:data-[closed]:animate-sheet-out " +
    "max-md:base:data-[closed]:opacity-0 max-md:base:starting:opacity-0",
} satisfies Readonly<Record<"centred" | "sheet", string>>;

/**
 * The veil behind the panel. It paints the contract's scrim role,
 * `--ui-scrim`, which `Modal`'s `::backdrop` reads too, so an app that maps it
 * once gets one backdrop for both; unmapped, it is black at 50%.
 * `presentation` matches the panel's, which `DialogContent` passes on.
 */
const DialogOverlay: Component<
  ComponentProps<"div"> & { presentation?: keyof typeof DIALOG_SCRIM_MOTION }
> = (props) => {
  const [local, others] = splitProps(props, ["class", "presentation"]);
  return (
    <KobalteDialog.Overlay
      class={clsx(
        "base:fixed base:inset-0 base:z-50 base:bg-ui-scrim",
        DIALOG_SCRIM_MOTION[local.presentation ?? "centred"],
        local.class,
      )}
      {...others}
    />
  );
};

/**
 * Where the panel sits, and what shape that makes it.
 *
 * `sheet` is the same idea as `Modal`'s, for the Kobalte-backed dialog: below
 * `md` the centred card becomes a bottom sheet — pinned to the bottom edge,
 * full width, square bottom corners at every width up to 767px, its top
 * corners reading `--ui-radius-sheet` — and at `md` and up it is exactly the
 * centred card again. No class on the panel may round its corners at a
 * breakpoint under `md`: Tailwind emits a min-width query after the `max-md`
 * ones, so it would win and round the sheet's bottom corners. The safe-area
 * inset is part of the variant rather than the caller's business, because a
 * panel flush with the bottom edge always has the home indicator drawn over it.
 *
 * A caller that spells this out in classes gets it right on the axis it
 * remembers and wrong on the other two; that is what this replaces.
 *
 * The sheet also moves differently: `DIALOG_MOTION` below. Below `md` it can
 * be dragged down (`SheetDrag`), which `--ui-sheet-drag` marks, so the script
 * reads the breakpoint the classes use rather than a second copy of it; and a
 * scroll that reaches either end of the sheet stops there rather than moving
 * the page behind it.
 */
const DIALOG_PRESENTATION = {
  centred: "",
  sheet:
    "max-md:base:top-auto max-md:base:bottom-0 max-md:base:left-0 " +
    "max-md:base:max-w-none max-md:base:translate-x-0 max-md:base:translate-y-0 " +
    "max-md:base:rounded-t-ui-sheet max-md:base:rounded-b-none " +
    "max-md:base:border-x-0 max-md:base:border-b-0 " +
    "max-md:base:pb-[max(0px,env(safe-area-inset-bottom))] " +
    "max-md:base:[--ui-sheet-drag:1] max-md:base:overscroll-y-contain",
} satisfies Readonly<Record<"centred" | "sheet", string>>;

/**
 * How the panel comes and goes, by presentation.
 *
 * `centred` fades and scales on the card's keyframes at every width.
 * `sheet` does the same at `md` and up, where it is the card; below `md` it
 * slides up from its own height below the bottom edge over `--ui-dur-slow`
 * and back down over `--ui-dur-base`, both on `--ui-ease-sheet`, at full
 * opacity and with no scale. The slide is a `transform` transition from
 * `@starting-style` in and to the closed state out, so a sheet closed or
 * reopened part-way turns round from where it is. It is on `transform`, not
 * `translate`: the card's centring and the sheet's reset of it are both on
 * `translate`, so a sheet carried across `md` while open would otherwise fly
 * in from the middle of the screen. Under reduced motion the sheet does not
 * slide: it fades in and out with its scrim, on the same pace, and the card
 * shows and hides at once (`tokens.css`).
 */
const DIALOG_MOTION = {
  centred:
    "base:data-[expanded]:animate-in base:data-[closed]:animate-out base:data-[closed]:fade-out-0 base:data-[expanded]:fade-in-0 base:data-[closed]:zoom-out base:data-[expanded]:zoom-in",
  sheet:
    "md:base:data-[expanded]:animate-in md:base:data-[closed]:animate-out md:base:data-[closed]:fade-out-0 md:base:data-[expanded]:fade-in-0 md:base:data-[closed]:zoom-out md:base:data-[expanded]:zoom-in " +
    "max-md:base:data-[expanded]:animate-sheet-in max-md:base:data-[closed]:animate-sheet-out " +
    "max-md:base:data-[closed]:sheet-hidden max-md:base:starting:sheet-hidden",
} satisfies Readonly<Record<keyof typeof DIALOG_PRESENTATION, string>>;

/**
 * How far focus scrolling keeps a control below the top of the panel: the
 * header's height, which `DialogHeader` measures and writes on the panel, the
 * fade under it (`--ui-scroll-edge-size`, 16px), and 1.5rem more for the
 * label above a field and the gap to it, which also holds the widest focus
 * mark (a field's `ring-2 ring-offset-2`, Musubi's 2px outline 2px off). So a
 * field reached with Shift+Tab arrives with its label clear of the fade. A
 * fixed length in place of the header's height would match only a one-line
 * title.
 */
const DIALOG_SCROLL_PADDING =
  "base:scroll-pt-[calc(var(--ui-dialog-header-height,0px)+var(--ui-scroll-edge-size,1rem)+1.5rem)]";

/**
 * Kobalte's focus trap puts a 1px visually hidden `span` at each end of the
 * panel, absolutely placed where it falls. The last one hangs 1px under the
 * footer, so a body that fits would still scroll 1px, and that pixel would
 * bring in the fade. Pinned to the panel's top, the two take no room.
 */
const DIALOG_FOCUS_TRAP = "[&>[data-focus-trap]]:base:top-0";

/**
 * Keeps a control the focus trap wraps onto in view. Kobalte moves focus from
 * one end of the panel to the other without scrolling (Shift+Tab off the first
 * control lands on the footer's action), so in a panel past its cap the
 * control would hold focus out of sight. Focus that arrives from one of the
 * trap's `span`s scrolls the panel itself, never the page behind it, until the
 * control is inside the panel and below the header, the fade and the label
 * allowance (`DIALOG_SCROLL_PADDING`).
 */
function keepWrappedFocusInView(event: FocusEvent) {
  const panel = event.currentTarget;
  const control = event.target;
  const from = event.relatedTarget;
  if (!(panel instanceof HTMLElement) || !(control instanceof HTMLElement)) return;
  if (!(from instanceof HTMLElement) || !from.hasAttribute("data-focus-trap")) return;
  const box = panel.getBoundingClientRect();
  const top = box.top + panel.clientTop;
  const clear = top + (Number.parseFloat(getComputedStyle(panel).scrollPaddingTop) || 0);
  const bottom = top + panel.clientHeight;
  const rect = control.getBoundingClientRect();
  if (rect.bottom > bottom) panel.scrollTop += rect.bottom - bottom;
  else if (rect.top < clear) panel.scrollTop -= clear - rect.top;
}

/** What `DialogHeader` needs from the sheet around it: whether it is the drag's handle, and whether a drag is under way. */
interface SheetHandle {
  dragging: Accessor<boolean>;
}
const SheetHandleContext = createContext<SheetHandle>();

/** A press in a field belongs to the field: its caret, its selection, its keyboard. */
const TEXT_ENTRY = "input, textarea, select, [contenteditable]:not([contenteditable='false'])";

/**
 * The inline properties a drag writes, and the only ones it ever removes.
 * Kobalte writes `pointer-events` on both elements and `DialogHeader` writes
 * `--ui-dialog-header-height` on the panel, so the drag never clears a whole
 * `style`.
 */
const PANEL_OWNS = [
  "transform",
  "transition",
  "animation-duration",
  "opacity",
  "box-shadow",
] as const;
const SCRIM_OWNS = ["opacity", "transition", "animation-duration"] as const;

/** A press on the panel, from `pointerdown` until it lifts or is cancelled. */
interface Press {
  id: number;
  type: string;
  /** Where it went down. */
  x0: number;
  y0: number;
  /** Down on the title row, or in the body. */
  handle: boolean;
  /** A press in the body is the sheet's only when its first move is down at the top. */
  owned: boolean | undefined;
  /** Past the slop: no longer a tap, so the click it would make is swallowed. */
  moved: boolean;
  /** The drag has taken the sheet. */
  dragging: boolean;
  /** Where the finger was, and the sheet's offset, when the drag took it. */
  originY: number;
  base: number;
  raw: number;
  offset: number;
  height: number;
  refused: boolean;
  samples: DragSample[];
}

/**
 * What the sheet is doing on its own: at rest (`idle`), following a finger,
 * springing back after a short drag, inside `close()` after a long one
 * (`closing`), or leaving after it (`dismissing`).
 */
type SheetPhase = "idle" | "dragging" | "settling" | "closing" | "dismissing";

/**
 * A 3D translation, which puts the panel on a layer of its own while a drag
 * moves it. Not `will-change`: on a panel scrolled to its top Chromium then
 * shifts its scroll by a pixel as the drag begins.
 */
const translate = (y: number) => `translate3d(0, ${y}px, 0)`;

/** A computed time (`0.1s`, `100ms`) in ms; 0 when there is none. */
function millis(value: string): number {
  const first = value.split(",")[0]!.trim();
  const n = Number.parseFloat(first);
  if (!Number.isFinite(n)) return 0;
  return first.endsWith("ms") ? n : n * 1000;
}

/** The running transition of `property` on `el`, if one is running. */
function transitionOf(el: Element, property: string): Animation | undefined {
  if (typeof CSSTransition === "undefined" || typeof el.getAnimations !== "function") return;
  return el
    .getAnimations()
    .find((a) => a instanceof CSSTransition && a.transitionProperty === property);
}

/**
 * The drag that dismisses a sheet below `md` (the owner's design on #2288).
 *
 * A finger or a pointer pressed on the title row moves the sheet from its
 * first pixel, one to one; pressed in the body it does so only when its first
 * move is down and the body, and every box between the press and the panel,
 * is scrolled to its top, after the slop (8px for a finger, 4px for a mouse),
 * from where the sheet is then. A press in a text field is the field's. Up
 * past rest the sheet gives on the rubber band, and a sheet that cannot close
 * (`dismissible={false}`) gives on it both ways. The scrim fades with the
 * share of the sheet's height it has moved.
 *
 * Let go past a quarter of its height, unless the finger's last move was a
 * flick back up, or after a flick down of 0.4px/ms over at least 24px, the
 * sheet closes through Kobalte's `close()`, the path Cancel takes, so the host's
 * `onOpenChange(false)` decides. Otherwise, or when the host keeps it open
 * (it is still open once `close()` returns), it goes back to rest. Both ride
 * a critically damped spring with a 0.3s response started at the sheet's
 * speed (`settleCurve`), as transitions: the panel's and the scrim's
 * `animation-duration` take the spring's length too, so Kobalte keeps them
 * mounted until the panel has left. A sheet closed by Cancel, Escape or the
 * scrim keeps the class's 200ms exit.
 *
 * Under reduced motion (the sheet's transitions are `opacity` alone) the drag
 * still follows the finger; a close fades where the sheet was let go, and a
 * return fades out where it is, moves to rest unseen and fades back in, over
 * `--ui-dur-base` in all.
 *
 * A press while the sheet springs back, or rises as it opens, stops it where it
 * is once it moves as a drag would, and drags it from there; a press that does
 * not move lets it go on, and its click through. A sheet already closing is
 * not caught. Cancel, Escape and the scrim stay the ways out that need no
 * drag.
 */
function sheetDrag(
  panel: HTMLElement,
  context: DialogContextValue,
  options: { dismissible: () => boolean; setDragging: (dragging: boolean) => void },
) {
  let phase: SheetPhase = "idle";
  let press: Press | undefined;
  let landing = 0;
  let landingTimer: ReturnType<typeof setTimeout> | undefined;
  let swallowUntil = 0;

  const scrim = () => context.overlayRef();
  const style = () => getComputedStyle(panel);
  const draggable = () => style().getPropertyValue("--ui-sheet-drag").trim() === "1";
  /** Under reduced motion the sheet's transitions are `opacity` alone (`tokens.css`). */
  const fades = () => style().getPropertyValue("--ui-sheet-transition").trim() === "opacity";
  const offsetNow = () => {
    const transform = style().transform;
    return transform && transform !== "none" ? new DOMMatrixReadOnly(transform).m42 : 0;
  };

  function release(el: HTMLElement | undefined, owns: readonly string[]) {
    for (const property of owns) el?.style.removeProperty(property);
  }
  function releaseAll() {
    release(panel, PANEL_OWNS);
    release(scrim(), SCRIM_OWNS);
  }
  function cancelLanding() {
    landing++;
    clearTimeout(landingTimer);
  }

  /** Puts the sheet at `offset` px below its rest, and its scrim at the share left. */
  function place(offset: number, height: number) {
    panel.style.transform = translate(offset);
    const shown = 1 - Math.min(1, Math.max(0, offset / height));
    scrim()?.style.setProperty("opacity", String(shown));
  }

  /**
   * Holds the panel and the scrim to what the drag writes. Under reduced
   * motion the panel's transitions are `opacity` alone, so its `transform`
   * already moves at once, and its opacity keeps the class's fade, which an
   * Escape in the middle of a drag runs.
   */
  function hold() {
    if (!fades()) panel.style.transition = "none";
    scrim()?.style.setProperty("transition", "none");
  }

  /** Stops a sheet that is moving where it is on screen, and returns its offset. */
  function freeze(): number {
    const y = offsetNow();
    const shown = scrim() ? getComputedStyle(scrim()!).opacity : undefined;
    cancelLanding();
    panel.style.removeProperty("opacity");
    panel.style.removeProperty("transition");
    hold();
    panel.style.transform = translate(y);
    if (shown !== undefined) scrim()?.style.setProperty("opacity", shown);
    return y;
  }

  /** Whether the sheet is moving by itself: springing back, or rising as it opens. */
  const moving = () => phase === "settling" || transitionOf(panel, "transform") !== undefined;

  function startDrag(p: Press, event: PointerEvent, fromPress: boolean) {
    const caught = moving();
    p.base = caught ? freeze() : 0;
    if (!caught) hold();
    p.originY = caught || !fromPress ? event.clientY : p.y0;
    p.height = panel.offsetHeight;
    p.refused = !options.dismissible();
    p.dragging = true;
    phase = "dragging";
    panel.setAttribute("data-dragging", "");
    options.setDragging(true);
    // A copy of the panel, nearly its own height lower, in its own colour, so a
    // pull above rest shows no gap under its bottom edge. 24px short of the
    // height, so the copy's round top corners sit behind the panel; first in
    // the list, so the elevation's blur never paints over it.
    panel.style.boxShadow = `0 ${p.height - 24}px 0 0 ${style().backgroundColor}, var(--ui-elev-2)`;
    if (p.type !== "touch") window.getSelection()?.removeAllRanges();
  }

  /** Whether `target` and every box between it and the panel are scrolled to their top. */
  function atTop(target: Element): boolean {
    for (let el: Element | null = target; el; el = el.parentElement) {
      if (el.scrollTop > 0) return false;
      if (el === panel) return true;
    }
    return true;
  }

  function onPointerDown(event: PointerEvent) {
    swallowUntil = 0;
    if (press || !event.isPrimary) return;
    if (event.pointerType === "mouse" && event.button !== 0) return;
    if (!context.isOpen() || phase === "closing" || phase === "dismissing") return;
    const target = event.target;
    if (!(target instanceof Element) || target.closest(TEXT_ENTRY)) return;
    if (!draggable()) return;
    // A press on the panel's own scrollbar scrolls it.
    if (target === panel) {
      const box = panel.getBoundingClientRect();
      if (event.clientX >= box.left + panel.clientLeft + panel.clientWidth) return;
    }
    const handle = target.closest("[data-dialog-header]");
    press = {
      id: event.pointerId,
      type: event.pointerType,
      x0: event.clientX,
      y0: event.clientY,
      handle: handle !== null && panel.contains(handle),
      owned: undefined,
      moved: false,
      dragging: false,
      originY: event.clientY,
      base: 0,
      raw: 0,
      offset: 0,
      height: panel.offsetHeight,
      refused: false,
      samples: [{ y: event.clientY, t: event.timeStamp }],
    };
    window.addEventListener("pointermove", onPointerMove, true);
    window.addEventListener("pointerup", onPointerUp, true);
    window.addEventListener("pointercancel", onPointerCancel, true);
  }

  function onPointerMove(event: PointerEvent) {
    const p = press;
    if (!p || event.pointerId !== p.id) return;
    const coalesced = event.getCoalescedEvents?.() ?? [];
    for (const e of coalesced.length > 0 ? coalesced : [event]) {
      p.samples.push({ y: e.clientY, t: e.timeStamp || event.timeStamp });
    }
    while (p.samples.length > 2 && p.samples[0]!.t < event.timeStamp - SAMPLE_KEEP_MS) {
      p.samples.shift();
    }
    const dx = event.clientX - p.x0;
    const dy = event.clientY - p.y0;
    const pastSlop = Math.max(Math.abs(dx), Math.abs(dy)) > slopFor(p.type);
    if (!p.dragging) {
      if (!p.handle) {
        // The first move decides, as the browser's own scroll lock does: down,
        // mostly vertical, with everything under the press at its top.
        p.owned ??= dy > 0 && Math.abs(dy) >= Math.abs(dx) && atTop(event.target as Element);
        if (!p.owned) return end(true);
        if (!pastSlop) return;
      }
      startDrag(p, event, p.handle);
    }
    if (pastSlop && !p.moved) {
      p.moved = true;
      try {
        panel.setPointerCapture(p.id);
      } catch {
        // A pointer the browser has already let go of has nothing to capture.
      }
    }
    p.raw = p.base + (event.clientY - p.originY);
    p.offset = dragOffset(p.raw, p.height, p.refused);
    place(p.offset, p.height);
  }

  function onPointerUp(event: PointerEvent) {
    if (!press || event.pointerId !== press.id) return;
    press.samples.push({ y: event.clientY, t: event.timeStamp });
    end(false);
  }
  function onPointerCancel(event: PointerEvent) {
    if (press && event.pointerId === press.id) end(true);
  }
  /**
   * The panel lost a drag's pointer it had captured: the browser took it. A
   * child losing the implicit capture a touch starts with, as the panel takes
   * it over, bubbles here too, and is no loss.
   */
  function onLostCapture(event: PointerEvent) {
    if (event.target !== panel) return;
    if (press?.dragging && event.pointerId === press.id) end(true);
  }

  /** The touch's own scroll would take it from the drag (and send `pointercancel`). */
  function onTouchMove(event: TouchEvent) {
    if (!event.cancelable || !press) return;
    if (press.dragging || press.owned === true) event.preventDefault();
  }

  /** The one click a drag that left its slop would make on what it went down on. */
  function onClick(event: MouseEvent) {
    if (performance.now() > swallowUntil) return;
    swallowUntil = 0;
    event.preventDefault();
    event.stopPropagation();
  }

  function end(cancelled: boolean) {
    const p = press;
    press = undefined;
    window.removeEventListener("pointermove", onPointerMove, true);
    window.removeEventListener("pointerup", onPointerUp, true);
    window.removeEventListener("pointercancel", onPointerCancel, true);
    if (!p) return;
    if (panel.hasPointerCapture?.(p.id)) panel.releasePointerCapture(p.id);
    if (!p.dragging) return;
    panel.removeAttribute("data-dragging");
    options.setDragging(false);
    // Disarmed by the next press, so a tap after a drag that made no click
    // still reaches its button.
    if (p.moved) swallowUntil = performance.now() + 350;
    const speed = cancelled ? 0 : releaseSpeed(p.samples);
    const refused = p.refused || !options.dismissible();
    const closes = closesOnRelease({
      offset: p.offset,
      travel: (p.samples[p.samples.length - 1]?.y ?? p.y0) - p.y0,
      speed,
      height: p.height,
      refused,
      cancelled,
    });
    const leaving = sheetSpeed(speed, p.raw, p.height, refused);
    if (closes && dismiss(p, leaving)) return;
    springBack(p, leaving);
  }

  /** Closes through Kobalte; false when the host kept the sheet open. */
  function dismiss(p: Press, speed: number): boolean {
    const motion = !fades();
    const curve = motion ? settleCurve(p.offset, p.height, speed) : null;
    const timed = [panel, scrim()].filter((el) => el !== undefined);
    phase = "closing";
    for (const el of timed) {
      el.style.removeProperty("transition");
      if (!curve) continue;
      const time = `${curve.duration}ms`;
      el.style.transitionDuration = time;
      el.style.transitionTimingFunction = readsLinearEasing() ? curve.easing : curve.fallback;
      el.style.animationDuration = time;
    }
    context.close();
    if (context.isOpen()) {
      for (const el of timed) {
        el.style.removeProperty("transition");
        el.style.removeProperty("animation-duration");
      }
      hold();
      phase = "dragging";
      return false;
    }
    phase = "dismissing";
    // From where it was let go: the class's place for a closed sheet, its own
    // height below the edge, or under reduced motion in place and clear.
    if (motion) panel.style.removeProperty("transform");
    scrim()?.style.removeProperty("opacity");
    return true;
  }

  /** Back to rest from a drag that did not close the sheet. */
  function springBack(p: Press, speed: number) {
    phase = "settling";
    const token = ++landing;
    const land = () => {
      if (token !== landing) return;
      clearTimeout(landingTimer);
      releaseAll();
      phase = "idle";
    };
    // `next` runs once `property`'s transition on `el` ends, or, should it
    // never end (a hidden tab draws no frames), 100ms after it would have.
    const after = (el: HTMLElement, property: string, next: () => void) => {
      if (token !== landing) return;
      const run = transitionOf(el, property);
      const wait = millis(getComputedStyle(el).transitionDuration) + 100;
      clearTimeout(landingTimer);
      landingTimer = setTimeout(next, wait);
      run?.addEventListener(
        "finish",
        () => {
          if (token === landing) next();
        },
        { once: true },
      );
    };
    if (fades()) {
      if (Math.abs(p.offset) < 1) return land();
      // Out where it is, to rest unseen, back in: nothing moves by itself.
      const half = (el: HTMLElement) => {
        el.style.removeProperty("transition");
        el.style.transitionProperty = "opacity";
        el.style.transitionDuration = "calc(var(--ui-dur-base) / 2)";
        el.style.transitionTimingFunction = "var(--ui-ease-sheet)";
      };
      half(panel);
      void style().opacity;
      panel.style.opacity = "0";
      after(panel, "opacity", () => {
        if (token !== landing) return;
        panel.style.removeProperty("transform");
        const veil = scrim();
        if (veil) {
          half(veil);
          veil.style.removeProperty("opacity");
        }
        panel.style.opacity = "1";
        after(panel, "opacity", land);
      });
      return;
    }
    const curve = settleCurve(p.offset, 0, speed);
    if (!curve) return land();
    // Resolve the place just painted, so the transition starts from it.
    void style().transform;
    const time = `${curve.duration}ms`;
    const ease = readsLinearEasing() ? curve.easing : curve.fallback;
    for (const el of [panel, scrim()]) {
      if (!el) continue;
      el.style.removeProperty("transition");
      el.style.transitionDuration = time;
      el.style.transitionTimingFunction = ease;
    }
    panel.style.removeProperty("transform");
    scrim()?.style.removeProperty("opacity");
    after(panel, "transform", land);
  }

  /** Kobalte opened or closed the sheet by some other way than the drag. */
  function openChanged(open: boolean) {
    if (open) {
      // Reopened while it left after a drag: the class's entry turns it round.
      if (phase !== "dismissing") return;
      cancelLanding();
      releaseAll();
      phase = "idle";
      return;
    }
    if (phase === "closing" || phase === "dismissing") return;
    // Cancel, Escape or the scrim in the middle of a drag or a return: the
    // class's exit runs from where the sheet is.
    if (press) {
      const p = press;
      press = undefined;
      window.removeEventListener("pointermove", onPointerMove, true);
      window.removeEventListener("pointerup", onPointerUp, true);
      window.removeEventListener("pointercancel", onPointerCancel, true);
      if (panel.hasPointerCapture?.(p.id)) panel.releasePointerCapture(p.id);
      panel.removeAttribute("data-dragging");
      options.setDragging(false);
    }
    if (phase === "idle") return;
    cancelLanding();
    releaseAll();
    phase = "idle";
  }

  panel.addEventListener("pointerdown", onPointerDown);
  panel.addEventListener("lostpointercapture", onLostCapture);
  panel.addEventListener("touchmove", onTouchMove, { passive: false });
  panel.addEventListener("click", onClick, true);
  return {
    openChanged,
    detach() {
      cancelLanding();
      end(true);
      panel.removeEventListener("pointerdown", onPointerDown);
      panel.removeEventListener("lostpointercapture", onLostCapture);
      panel.removeEventListener("touchmove", onTouchMove);
      panel.removeEventListener("click", onClick, true);
    },
  };
}

/**
 * Wires `sheetDrag` to the panel while it is mounted. Renders nothing; it sits
 * inside the panel so it comes and goes with it.
 */
function SheetDrag(props: {
  dismissible: () => boolean;
  setDragging: (dragging: boolean) => void;
}) {
  const context = useDialogContext();
  let drag: ReturnType<typeof sheetDrag> | undefined;
  createEffect(() => {
    const panel = context.contentRef();
    if (!panel) return;
    const wired = sheetDrag(panel, context, props);
    drag = wired;
    onCleanup(() => {
      wired.detach();
      if (drag === wired) drag = undefined;
    });
  });
  createEffect(on(context.isOpen, (open) => drag?.openChanged(open), { defer: true }));
  return null;
}

type DialogContentProps = ComponentProps<"div"> &
  Pick<DialogContentOptions, "onEscapeKeyDown" | "onInteractOutside"> & {
    presentation?: keyof typeof DIALOG_PRESENTATION;
    /**
     * False while the host refuses to close: a drag then gives with resistance
     * and goes back, and Escape and a press outside do nothing. A close button
     * inside the dialog is the host's to disable, as `StepUpDialog` disables
     * Cancel. Defaults to true.
     */
    dismissible?: boolean;
  };

/**
 * The panel. Its plane is `--ui-surface`, its shadow the contract's raised
 * elevation, `--ui-elev-2` — the one `Modal`, the raised `Card` and the accent
 * menu cast — so an app that maps it once themes every raised panel.
 *
 * At every width, sheet or card, it is at most 85% of the window tall and
 * scrolls past that, as one box, header and footer included. It names its
 * scroll position (`scroll-edge-timeline`) for the fade under `DialogHeader`,
 * keeps focus clear of that header as it scrolls (`DIALOG_SCROLL_PADDING`),
 * and keeps a control the focus trap wraps onto in view
 * (`keepWrappedFocusInView`).
 *
 * As a sheet below `md` it can be dragged down to close (`sheetDrag`); while a
 * drag holds it, no text in it is selected. `dismissible={false}` refuses the
 * drag, Escape and a press outside. A host closes or refuses in
 * `onOpenChange` at once: one that closes later is read as a refusal, and
 * its sheet springs back before it leaves.
 */
const DialogContent: ParentComponent<DialogContentProps> = (props) => {
  const [local, others] = splitProps(props, [
    "class",
    "children",
    "presentation",
    "onFocusIn",
    "dismissible",
    "onEscapeKeyDown",
    "onInteractOutside",
  ]);
  const presentation = () => local.presentation ?? "centred";
  const dismissible = () => local.dismissible !== false;
  const [dragging, setDragging] = createSignal(false);
  const onFocusIn = (event: FocusEvent & { currentTarget: HTMLDivElement; target: Element }) => {
    keepWrappedFocusInView(event);
    if (typeof local.onFocusIn === "function") local.onFocusIn(event);
  };
  const onEscapeKeyDown: DialogContentOptions["onEscapeKeyDown"] = (event) => {
    local.onEscapeKeyDown?.(event);
    if (!dismissible()) event.preventDefault();
  };
  const onInteractOutside: DialogContentOptions["onInteractOutside"] = (event) => {
    local.onInteractOutside?.(event);
    if (!dismissible()) event.preventDefault();
  };
  return (
    <DialogPortal>
      <DialogOverlay presentation={presentation()} />
      <KobalteDialog.Content
        class={clsx(
          "base:bg-ui-surface base:border-ui-hairline base:fixed base:top-1/2 base:left-1/2 base:z-50 base:w-full base:max-w-lg base:-translate-x-1/2 base:-translate-y-1/2 base:rounded-ui-lg base:border base:shadow-[var(--ui-elev-2)] base:focus:outline-none",
          "base:max-h-[85dvh] base:overflow-y-auto base:scroll-edge-timeline",
          "base:data-[dragging]:select-none",
          DIALOG_SCROLL_PADDING,
          DIALOG_FOCUS_TRAP,
          DIALOG_PRESENTATION[presentation()],
          DIALOG_MOTION[presentation()],
          local.class,
        )}
        onFocusIn={onFocusIn}
        onEscapeKeyDown={onEscapeKeyDown}
        onInteractOutside={onInteractOutside}
        {...others}
      >
        <Show when={presentation() === "sheet"}>
          <SheetDrag dismissible={dismissible} setDragging={setDragging} />
        </Show>
        <SheetHandleContext.Provider value={presentation() === "sheet" ? { dragging } : undefined}>
          {local.children}
        </SheetHandleContext.Provider>
      </KobalteDialog.Content>
    </DialogPortal>
  );
};

/**
 * Where scroll timelines are read, the header draws no line: its edge keeps
 * its 1px, transparent, so it is as tall as with the line, and a 16px fade
 * under it (`scroll-edge-fade`, `tokens.css`) comes in as the body scrolls
 * under it. Elsewhere it keeps the hairline and draws no fade.
 */
const SCROLL_EDGE =
  "supports-[animation-timeline:scroll()]:base:border-b-transparent " +
  "supports-[animation-timeline:scroll()]:base:after:scroll-edge-fade";

/**
 * The dialog's title row. It stays at the top of the panel while a long body
 * scrolls under it, on the panel's own surface, with the scroll edge
 * (`SCROLL_EDGE`) under it. `z-1` keeps a positioned box in the body under it as it passes:
 * by tree order alone the later box would paint over it. Chromium paints a
 * stuck header on top either way; the class is for the engines that follow
 * the order.
 *
 * It writes its height on the panel as `--ui-dialog-header-height`, which the
 * panel's scroll padding reads, so focus never parks a control under it. A
 * title can wrap, so the height is measured, not assumed, by a
 * `ResizeObserver` on the header and the panel. Past a third of the panel's
 * height the row is no longer stuck.
 *
 * In a sheet below `md` it is the handle a drag closes the sheet by
 * (`sheetDrag`): it takes no touch scroll or text selection, and shows the
 * grab cursor, grabbing while a drag holds the sheet. It draws no grabber bar:
 * the title row is the handle (the owner's choice on #2288).
 */
const SHEET_HANDLE = "max-md:base:touch-none max-md:base:select-none";

const DialogHeader: Component<ComponentProps<"div">> = (props) => {
  const [local, others] = splitProps(props, ["class", "ref"]);
  const sheet = useContext(SheetHandleContext);
  let header: HTMLDivElement | undefined;
  onMount(() => {
    const row = header;
    const panel = row?.closest<HTMLElement>('[role="dialog"]');
    if (!row || !panel || typeof ResizeObserver === "undefined") return;
    // Layout sizes, which the card's entry scale does not shrink. A row taller
    // than a third of the panel — a title of a thousand characters someone
    // else chose — stops sticking and scrolls away with the body, so it can
    // never cover the dialog's own words and buttons.
    const observer = new ResizeObserver(() => {
      const tall = row.offsetHeight > panel.clientHeight / 3;
      row.style.position = tall ? "static" : "";
      panel.style.setProperty("--ui-dialog-header-height", `${tall ? 0 : row.offsetHeight}px`);
    });
    observer.observe(row);
    observer.observe(panel);
    onCleanup(() => {
      observer.disconnect();
      panel.style.removeProperty("--ui-dialog-header-height");
    });
  });
  return (
    <div
      ref={(el) => {
        header = el;
        if (typeof local.ref === "function") local.ref(el);
      }}
      data-dialog-header=""
      class={clsx(
        "base:sticky base:top-0 base:z-1 base:bg-ui-surface",
        "base:flex base:items-center base:justify-between base:border-b base:border-ui-hairline base:p-4",
        SCROLL_EDGE,
        sheet && SHEET_HANDLE,
        sheet && (sheet.dragging() ? "max-md:base:cursor-grabbing" : "max-md:base:cursor-grab"),
        local.class,
      )}
      {...others}
    />
  );
};

const DialogFooter: Component<ComponentProps<"div">> = (props) => {
  const [local, others] = splitProps(props, ["class"]);
  return (
    <div
      class={clsx(
        "base:flex base:items-center base:justify-end base:gap-2 base:border-t base:border-ui-hairline base:p-4",
        local.class,
      )}
      {...others}
    />
  );
};

/**
 * The dialog's heading. Its weight is the contract's title weight,
 * `--ui-weight-title` through `font-ui-title`, which falls back to 600, so an
 * app that maps nothing keeps the semibold title it always had.
 */
const DialogTitle: Component<ComponentProps<"h2">> = (props) => {
  const [local, others] = splitProps(props, ["class"]);
  return (
    <KobalteDialog.Title
      class={clsx("base:text-ui-ink base:text-ui-md base:font-ui-title", local.class)}
      {...others}
    />
  );
};

const DialogDescription: Component<ComponentProps<"p">> = (props) => {
  const [local, others] = splitProps(props, ["class"]);
  return (
    <KobalteDialog.Description
      class={clsx("base:text-ui-ink-secondary base:text-ui-base", local.class)}
      {...others}
    />
  );
};

export {
  Dialog,
  DialogTrigger,
  DialogClose,
  DialogPortal,
  DialogOverlay,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
};
