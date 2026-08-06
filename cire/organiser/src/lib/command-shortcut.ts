import { onCleanup, onMount } from "solid-js";

/**
 * ⌘K / Ctrl+K, bound at the document.
 *
 * It lives out here rather than inside `CommandPalette` because the palette is
 * now fetched on demand: if the binding stayed in the component, the shortcut
 * that asks for the chunk would itself be inside the chunk, and the first press
 * would do nothing.
 *
 * The binding deliberately does not exempt text fields — a host pressing ⌘K
 * inside an input is asking to leave whatever they are typing in.
 *
 * Returns its own disposer, so the behaviour can be exercised without standing
 * up a Solid root.
 */
export function bindCommandShortcut(toggle: () => void): () => void {
  const onDocumentKey = (event: KeyboardEvent) => {
    if (event.key !== "k" && event.key !== "K") return;
    if (!event.metaKey && !event.ctrlKey) return;
    event.preventDefault();
    toggle();
  };
  document.addEventListener("keydown", onDocumentKey);
  return () => document.removeEventListener("keydown", onDocumentKey);
}

/** `bindCommandShortcut` for the lifetime of the calling component. */
export function createCommandShortcut(toggle: () => void): void {
  onMount(() => onCleanup(bindCommandShortcut(toggle)));
}
