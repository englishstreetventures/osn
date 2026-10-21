/**
 * Focus a script moves in answer to a touch or a click, drawn without the
 * keyboard's ring.
 *
 * The event sheet moves focus to the arriving panel's heading on every switch,
 * and a menu opened by a tap takes focus too, so the keyboard and assistive
 * technology land where the guest now is. None of those targets was reached by
 * keyboard. Chromium agrees and leaves the ring off; other engines — iOS Safari
 * among them — can match `:focus-visible` on a script's focus that follows a
 * touch, and the ring then reads as the heading or the menu being selected under
 * the guest's finger. `global.css` drops the ring from an element carrying
 * `data-quiet-focus`; this module sets that attribute for a pointer's move and
 * never for a keyboard's, so a guest moving by keyboard still sees where focus
 * went.
 */

/**
 * Whether a click came from a pointer — a mouse, a finger or a pen — rather than
 * from a key press on a focused control.
 *
 * Chromium (111 on) sends a click as a `PointerEvent` whose `pointerType` names
 * the pointer, and `""` for a key press. Firefox and Safari send a `MouseEvent`,
 * where a pointer's click counts its presses in `detail` and a key's is 0. A
 * screen reader's synthesised click can read either way; a pointer reading
 * costs it nothing but the ring.
 */
export function pressedByPointer(e: MouseEvent): boolean {
  if (typeof PointerEvent !== "undefined" && e instanceof PointerEvent && e.pointerType !== "") {
    return true;
  }
  return e.detail > 0;
}

/**
 * Move focus to `el`, quietly when `quiet` (a pointer's move: no ring) and with
 * the ring otherwise. The mark lasts until `el` loses focus, so a later keyboard
 * move that lands on it again draws the ring as usual.
 */
export function moveFocus(el: HTMLElement | undefined, quiet: boolean, options?: FocusOptions) {
  if (!el) return;
  el.toggleAttribute("data-quiet-focus", quiet);
  if (quiet) {
    el.addEventListener("blur", () => el.removeAttribute("data-quiet-focus"), { once: true });
  }
  el.focus(options);
}
