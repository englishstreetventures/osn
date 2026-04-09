import { createSignal, onCleanup, onMount, Show } from "solid-js";

/**
 * Small "(?)" button that reveals a text tooltip describing what a form
 * field does. Used on the create-event flow so organisers can tell at a
 * glance what "guest list visibility" or "join policy" actually means.
 *
 * Closes on outside click or Escape.
 */
export function InfoPopover(props: { label?: string; body: string }) {
  const [open, setOpen] = createSignal(false);
  let wrapper: HTMLSpanElement | undefined;

  const handleOutsideClick = (e: MouseEvent) => {
    if (wrapper && !wrapper.contains(e.target as Node)) setOpen(false);
  };
  const handleKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") setOpen(false);
  };

  onMount(() => {
    document.addEventListener("mousedown", handleOutsideClick);
    document.addEventListener("keydown", handleKey);
  });
  onCleanup(() => {
    document.removeEventListener("mousedown", handleOutsideClick);
    document.removeEventListener("keydown", handleKey);
  });

  return (
    <span class="relative inline-flex" ref={wrapper}>
      <button
        type="button"
        aria-label={props.label ?? "More info"}
        aria-expanded={open()}
        onClick={() => setOpen((v) => !v)}
        class="ml-1 inline-flex items-center justify-center w-4 h-4 rounded-full bg-muted text-muted-foreground text-[10px] font-semibold hover:bg-muted/80 focus:outline-none focus:ring-2 focus:ring-ring"
      >
        ?
      </button>
      <Show when={open()}>
        <span
          role="tooltip"
          class="absolute left-0 top-6 z-20 w-60 rounded-md border border-border bg-popover p-2 text-xs text-popover-foreground shadow-md"
        >
          {props.body}
        </span>
      </Show>
    </span>
  );
}
