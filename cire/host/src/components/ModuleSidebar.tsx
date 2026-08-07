import { Dialog } from "@kobalte/core/dialog";
import { createSignal, For, onCleanup } from "solid-js";

import type { Module } from "../lib/dashboard-route";
import { haptic } from "../lib/haptics";
import { MODULE_NAV, moduleDef } from "../lib/module-nav";
import { createSlidingPill } from "../lib/sliding-pill";

/** Shared row shape for both surfaces, so the rail and the sheet read as the
 *  same control at two sizes rather than as two different navs. */
const rowBase =
  "font-body flex w-full items-center gap-3 rounded-sm text-left tracking-[0.08em] uppercase " +
  "transition-colors duration-(--dur-fast) ease-(--ease-out)";

const rowIdle = "text-text-muted hover:text-text hover:bg-surface/50";
const rowActive = "text-gold bg-gold/10";

/** The rail's active row carries no background of its own — the pill behind it
 *  is the background, and it travels. Colour is all the row has to change. */
const railActive = "text-gold";

/**
 * The dashboard's module nav.
 *
 * Two surfaces, one source of truth ({@link MODULE_NAV}), switched by a
 * **container** query on the shell rather than a viewport query, so the nav
 * responds to the width it actually gets:
 *
 * - Wide container — a persistent vertical rail with a gold marker on the
 *   active module.
 * - Narrow container — a single trigger row naming the current module, opening
 *   a left-edge sheet. The sheet is a Kobalte dialog, so focus trapping,
 *   escape-to-close, background scroll lock, `aria-modal`, and focus restored
 *   to the trigger on close all come from the library.
 *
 * The previous narrow treatment was a horizontally scrolling strip: half the
 * modules sat off the right edge with nothing to say so. The sheet shows all
 * eight at once, each with its hint text.
 *
 * Only one surface is laid out at a time — the other is `display: none`, so
 * assistive tech sees one nav, never a duplicate.
 */
export default function ModuleSidebar(props: {
  active: Module;
  onSelect: (module: Module) => void;
}) {
  const [sheetOpen, setSheetOpen] = createSignal(false);

  const current = () => moduleDef(props.active);

  // The rail's marker. One box that moves to the active row, rather than eight
  // that switch on and off. It only drives the rail: the sheet is a modal the
  // host opens, picks from and closes, so nothing there is ever watched moving.
  const pill = createSlidingPill(() => props.active);

  const select = (module: Module) => {
    props.onSelect(module);
    setSheetOpen(false);
  };

  /**
   * Close the sheet when the container grows past the rail breakpoint.
   *
   * The two surfaces swap by container query, so widening the shell hides the
   * trigger with `display: none`. The sheet itself lives in a portal and would
   * survive that, leaving a modal open with no way back to its trigger. A
   * `ResizeObserver` reports a 0×0 box for a `display: none` element, which is
   * exactly the signal we want — and it reads the real container width rather
   * than duplicating the `@2xl` threshold in JS.
   */
  const watchNarrowSurface = (el: HTMLDivElement) => {
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      const box = entry?.contentRect;
      if (box && box.width === 0 && box.height === 0) setSheetOpen(false);
    });
    observer.observe(el);
    onCleanup(() => observer.disconnect());
  };

  return (
    <>
      {/* ── Wide container: persistent rail ────────────────────────────── */}
      {/* Sticky from the rail breakpoint up: on a tall panel (the invite
          builder, a long guest table) the modules used to scroll away, which is
          the one thing a persistent rail exists not to do. `self-start` keeps it
          from being stretched to the panel's height by the flex row — a
          full-height flex item has nothing to slide against. */}
      <nav
        ref={pill.track}
        aria-label="Wedding modules"
        class="relative hidden w-52 shrink-0 flex-col gap-0.5 @2xl/shell:sticky @2xl/shell:top-6 @2xl/shell:flex @2xl/shell:self-start @5xl/shell:w-56"
      >
        {/* The marker: one box, told where to be. It sits under the rows (they
            are `relative`, it is not stacked above them), so it reads as the
            active row's own background even though it belongs to the nav. */}
        <span
          aria-hidden="true"
          class="bg-gold/10 pointer-events-none absolute top-0 left-0 rounded-sm"
          style={pill.style()}
        >
          <span class="bg-gold absolute inset-y-1 left-0 w-[2px] rounded-full" />
        </span>
        <For each={MODULE_NAV}>
          {(mod) => {
            const isActive = () => props.active === mod.id;
            return (
              <button
                ref={pill.item(mod.id)}
                type="button"
                aria-current={isActive() ? "page" : undefined}
                title={mod.hint}
                onClick={() => props.onSelect(mod.id)}
                class={`${rowBase} relative px-3 py-2 text-[0.82rem] ${
                  isActive() ? railActive : rowIdle
                }`}
              >
                <span aria-hidden="true" class="w-4 shrink-0 text-center text-[0.95em] opacity-80">
                  {mod.glyph}
                </span>
                <span class="min-w-0 truncate">{mod.label}</span>
              </button>
            );
          }}
        </For>
      </nav>

      {/* ── Narrow container: trigger + sheet ──────────────────────────── */}
      <div class="@2xl/shell:hidden" ref={watchNarrowSurface}>
        {/* The dismiss haptic hangs off `onOpenChange` rather than off
            `setSheetOpen`, which is exactly the split we want: escape, the
            scrim and the close button all come through here, while picking a
            module (which closes the sheet by setting the signal directly) stays
            silent — a module switch is navigation, not a dismissal. */}
        <Dialog
          open={sheetOpen()}
          onOpenChange={(open) => {
            if (!open) haptic("dismiss");
            setSheetOpen(open);
          }}
        >
          <Dialog.Trigger
            class={`${rowBase} border-border bg-surface/40 text-text hover:border-gold-dim justify-between border px-4 py-3 text-[0.82rem]`}
          >
            <span class="flex min-w-0 items-center gap-3">
              <span aria-hidden="true" class="text-gold w-4 shrink-0 text-center text-[1em]">
                {current().glyph}
              </span>
              <span class="min-w-0 truncate">{current().label}</span>
            </span>
            <span class="text-text-muted flex shrink-0 items-center gap-2 text-[0.62rem] tracking-[0.18em]">
              Modules
              <span aria-hidden="true" class="text-gold text-[0.9rem] tracking-normal">
                ☰
              </span>
            </span>
          </Dialog.Trigger>

          <Dialog.Portal>
            <Dialog.Overlay class="sheet-scrim bg-bg/80 fixed inset-0 z-40" />
            {/* The dialog takes its accessible name from Dialog.Title below —
                Kobalte wires the aria-labelledby — so it carries no aria-label
                of its own. The name belongs on the element that owns the role. */}
            <Dialog.Content class="sheet-panel border-border bg-surface fixed inset-y-0 left-0 z-50 flex w-[min(19rem,86vw)] flex-col border-r">
              <div class="border-border flex items-center justify-between gap-4 border-b px-5 py-4">
                <Dialog.Title class="font-display text-text text-[1.15rem] leading-none font-light">
                  Wedding modules
                </Dialog.Title>
                <Dialog.CloseButton
                  aria-label="Close modules"
                  class="text-text-muted hover:text-gold hover:border-gold-dim border-border flex h-8 w-8 shrink-0 items-center justify-center rounded-sm border text-[0.9rem] transition-colors duration-(--dur-fast)"
                >
                  <span aria-hidden="true">✕</span>
                </Dialog.CloseButton>
              </div>

              <nav
                aria-label="Wedding modules"
                class="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto p-3"
              >
                <For each={MODULE_NAV}>
                  {(mod) => {
                    const isActive = () => props.active === mod.id;
                    return (
                      <button
                        type="button"
                        aria-current={isActive() ? "page" : undefined}
                        onClick={() => select(mod.id)}
                        class={`${rowBase} items-start px-3 py-2.5 text-[0.8rem] ${
                          isActive() ? rowActive : rowIdle
                        }`}
                      >
                        <span
                          aria-hidden="true"
                          class={`w-4 shrink-0 pt-0.5 text-center text-[1em] ${
                            isActive() ? "text-gold" : "text-gold-dim"
                          }`}
                        >
                          {mod.glyph}
                        </span>
                        <span class="flex min-w-0 flex-col gap-1">
                          <span class="truncate">{mod.label}</span>
                          <span class="text-text-muted text-[0.7rem] leading-snug tracking-normal normal-case">
                            {mod.hint}
                          </span>
                        </span>
                      </button>
                    );
                  }}
                </For>
              </nav>
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog>
      </div>
    </>
  );
}
