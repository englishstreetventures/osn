/**
 * Where a floating panel's portal should land.
 *
 * `<body>` normally. But {@link Modal} is `<dialog>` + `showModal()`, and a
 * modal dialog paints in the **top layer**, above every stacking context in the
 * document — so a panel portalled to `<body>` while one is open is unclickable
 * at any `z-index`. It is still laid out and still announced; a pointer simply
 * lands on the dialog.
 *
 * Promoting the panel into the top layer as well does not fix it: Kobalte
 * positions with `position: absolute`, whose containing block changes once an
 * element is promoted, and the panel ends up painted somewhere the hit test
 * never reaches.
 *
 * Mounting INTO the open dialog does fix it, and is the more honest description
 * of what is happening anyway: a panel opened from inside a modal belongs to
 * that modal. It inherits the dialog's top-layer promotion, keeps Kobalte's
 * positioning intact, and needs nothing from the call site.
 *
 * `dialog:modal` matches only a dialog opened with `showModal()`, so a
 * non-modal `<dialog open>` — which is an ordinary stacking context — is left
 * alone and keeps the `<body>` portal.
 *
 * Kobalte-free, so the popover and the menu share it without either pulling in
 * the other.
 */
export function portalMount(): HTMLElement | undefined {
  if (typeof document === "undefined") return undefined;
  // The LAST modal dialog in document order, not the first. With two open, the
  // top layer stacks in promotion order and a panel mounted into the earlier
  // one is painted under the later one — the same invisible-and-unclickable
  // failure this function exists to remove, one nesting level up.
  const modals = document.querySelectorAll<HTMLElement>("dialog:modal");
  return modals.item(modals.length - 1) ?? undefined;
}
