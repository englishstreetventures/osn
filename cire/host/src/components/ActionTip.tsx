import Button, { type ButtonProps } from "@cire/ui/button";
import { Popper } from "@kobalte/core/popper";
import type { SafeProps } from "@shared/ui/ui/props";
import { createSignal, type JSX, onCleanup, onMount, Show, splitProps } from "solid-js";
import { Portal } from "solid-js/web";

/**
 * The tooltip on a control that shows an icon instead of its words, and on a
 * badge that explains itself — one panel for the whole page.
 *
 * A control here builds no tooltip of its own. It carries its name as its
 * `aria-label` and again as `data-tip`; a badge (`TipNote`) carries its
 * explanation as hidden text and as `data-tip`. `TipLayer`, mounted once by the
 * module shell, watches the page and draws one panel beside whichever of them
 * the pointer rests on or the keyboard reaches. A list of 300 households, four
 * icons and a badge each, therefore mounts no popup machinery at all until
 * someone hovers.
 *
 * The panel repeats words the control or badge already gives a screen reader,
 * so it is for the eye only: `aria-hidden`, and nothing points at it — no
 * control carries an `aria-describedby` for it.
 *
 * A view drawn alone, outside the shell, has no layer and so no panels; its
 * controls keep their names.
 */

const PANEL =
  "bg-surface-raised text-text border-border z-50 max-w-xs rounded-md border px-2 py-1 text-ui-xs leading-ui-snug shadow-md";

/** How long a mouse rests on a control before its panel opens. */
const OPEN_DELAY_MS = 300;
/** Within this long of one panel closing, the next opens at once. */
const SKIP_DELAY_MS = 300;

/** An icon-only `Button`, named by `label`, with the label as its tooltip.
 *  `tipDisabled` keeps the name and drops the tooltip, for a control whose
 *  words are on screen at the moment. */
export function IconButton(
  props: Omit<ButtonProps, "aria-label" | "type"> & { label: string; tipDisabled?: boolean },
) {
  const [own, rest] = splitProps(props, ["label", "tipDisabled"]);
  return (
    <Button
      type="button"
      {...rest}
      aria-label={own.label}
      data-tip={own.tipDisabled ? undefined : own.label}
    />
  );
}

/**
 * A plain button with the same tooltip, for a control whose look is its own —
 * a sub-tab, a mode switch. Its name comes from its contents or its own
 * `aria-label`; `label` is what the panel shows.
 */
export function TipTrigger(
  props: Omit<SafeProps<"button">, "type"> & { label: string; tipDisabled?: boolean },
) {
  const [own, rest] = splitProps(props, ["label", "tipDisabled"]);
  return <button type="button" {...rest} data-tip={own.tipDisabled ? undefined : own.label} />;
}

/**
 * A passive badge that explains itself on hover: a screen reader gets the
 * explanation once, as hidden text after the children; a mouse user sees it in
 * the panel. No tab stop. The hidden copy is `normal-case`, so a badge inside
 * an `uppercase` run does not hand it to a screen reader in capitals. An
 * explanation a host needs in order to act belongs in visible text instead.
 */
export function TipNote(props: { text: string; children: JSX.Element }) {
  return (
    // `inline-block`, so the box the panel is placed against is the whole
    // badge, not its last line box.
    <span data-tip={props.text} class="inline-block">
      {props.children}
      <span class="sr-only normal-case">{props.text}</span>
    </span>
  );
}

/** The element whose tip an event concerns, if any. */
function tipOf(target: EventTarget | null): HTMLElement | null {
  return target instanceof Element ? target.closest<HTMLElement>("[data-tip]") : null;
}

/**
 * The page's one tooltip panel. Mount it once.
 *
 * - A mouse or pen resting on a `[data-tip]` opens it after `OPEN_DELAY_MS`,
 *   at once within `SKIP_DELAY_MS` of the last one closing; leaving closes it.
 *   A touch never opens it.
 * - Keyboard focus on one opens it at once; blur closes it. A focus that comes
 *   with a pointer press does not open it.
 * - Escape, a pointer press anywhere, and activating the control (a click, or
 *   Enter and Space, which click) close it — activation usually changes what
 *   the control is, or takes it away.
 * - It closes when its control leaves the page, rather than drifting to a
 *   corner with nothing to point at.
 *
 * The panel portals to `<body>` at `z-50`: inside the shell, a container and
 * so a stacking context of its own, it would paint under the sticky top bar.
 * Kobalte's `Popper` places it, above its control, flipping below when there is
 * no room, and follows the control as the page scrolls.
 */
export function TipLayer() {
  const [shown, setShown] = createSignal<{ el: HTMLElement; text: string } | null>(null);
  let via: "pointer" | "focus" = "pointer";
  let timer: number | undefined;
  // The control a pending open is for, so moving within it does not restart
  // the delay.
  let pending: HTMLElement | undefined;
  let lastClosed = Number.NEGATIVE_INFINITY;
  // Set by a pointer press until the click that ends it, so the focus the
  // press brings does not open a tip. Not cleared on pointerup: a tap's focus
  // arrives after the finger lifts, at the compatibility mousedown.
  let pressing = false;
  let pressTimer: number | undefined;

  const cancel = () => {
    window.clearTimeout(timer);
    timer = undefined;
    pending = undefined;
  };

  function show(el: HTMLElement, how: "pointer" | "focus", now: boolean) {
    cancel();
    const text = el.dataset.tip;
    if (!text) return;
    const open = () => {
      if (!el.isConnected) return;
      via = how;
      setShown({ el, text });
    };
    if (now || shown() !== null || performance.now() - lastClosed < SKIP_DELAY_MS) open();
    else {
      pending = el;
      timer = window.setTimeout(() => {
        pending = undefined;
        open();
      }, OPEN_DELAY_MS);
    }
  }

  function hide() {
    cancel();
    if (shown() === null) return;
    lastClosed = performance.now();
    setShown(null);
  }

  onMount(() => {
    const over = (e: PointerEvent) => {
      if (e.pointerType === "touch") return;
      const el = tipOf(e.target);
      if (!el || el === shown()?.el || el === pending) return;
      show(el, "pointer", false);
    };
    const out = (e: PointerEvent) => {
      if (e.pointerType === "touch") return;
      const el = tipOf(e.target);
      if (!el || el.contains(e.relatedTarget as Node | null)) return;
      if (shown() === null) cancel();
      else if (shown()?.el === el && via === "pointer") hide();
    };
    const released = () => {
      window.clearTimeout(pressTimer);
      pressing = false;
    };
    const down = () => {
      pressing = true;
      // A press that never clicks — dragged off, or held — lets go anyway.
      window.clearTimeout(pressTimer);
      pressTimer = window.setTimeout(released, 1000);
      hide();
    };
    const focusIn = (e: FocusEvent) => {
      const el = tipOf(e.target);
      if (!el || pressing || el !== e.target) return;
      show(el, "focus", true);
    };
    const focusOut = (e: FocusEvent) => {
      if (via === "focus" && shown()?.el === e.target) hide();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") hide();
    };
    const click = (e: MouseEvent) => {
      const current = shown()?.el;
      if (current?.contains(e.target as Node | null)) hide();
      // After the click, whatever this press focused has been focused.
      queueMicrotask(released);
    };
    const doc = document;
    doc.addEventListener("pointerover", over);
    doc.addEventListener("pointerout", out);
    doc.addEventListener("pointerdown", down, true);
    doc.addEventListener("pointercancel", released, true);
    doc.addEventListener("focusin", focusIn);
    doc.addEventListener("focusout", focusOut);
    doc.addEventListener("keydown", key);
    doc.addEventListener("click", click, true);
    onCleanup(() => {
      cancel();
      released();
      doc.removeEventListener("pointerover", over);
      doc.removeEventListener("pointerout", out);
      doc.removeEventListener("pointerdown", down, true);
      doc.removeEventListener("pointercancel", released, true);
      doc.removeEventListener("focusin", focusIn);
      doc.removeEventListener("focusout", focusOut);
      doc.removeEventListener("keydown", key);
      doc.removeEventListener("click", click, true);
    });
  });

  // Its control gone — a confirmation took the icons' place, a view changed —
  // the panel goes too. Checked where Popper reads the control's box, which it
  // does whenever the control resizes, and a control leaving the page does.
  const anchorRect = (el: HTMLElement) => {
    if (!el.isConnected) queueMicrotask(hide);
    return el.getBoundingClientRect();
  };

  let content: HTMLDivElement | undefined;
  return (
    <Show when={shown()} keyed>
      {(tip) => (
        <Portal>
          <Popper
            anchorRef={() => tip.el}
            getAnchorRect={() => anchorRect(tip.el)}
            contentRef={() => content}
            placement="top"
            gutter={4}
          >
            <Popper.Positioner class="pointer-events-none">
              <div ref={content} data-tip-panel role="tooltip" aria-hidden="true" class={PANEL}>
                {tip.text}
              </div>
            </Popper.Positioner>
          </Popper>
        </Portal>
      )}
    </Show>
  );
}
