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
        class="bg-muted text-muted-foreground hover:bg-muted/80 focus:ring-ring ml-1 inline-flex h-4 w-4 items-center justify-center rounded-full text-[10px] font-semibold focus:ring-2 focus:outline-none"
      >
        ?
      </button>
      <Show when={open()}>
        <span
          role="tooltip"
          class="border-border bg-popover text-popover-foreground absolute top-6 left-0 z-20 w-60 rounded-md border p-2 text-xs shadow-md"
        >
          {props.body}
        </span>
      </Show>
    </span>
  );
}
