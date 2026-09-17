import Button from "@cire/ui/button";
import { Dialog } from "@kobalte/core/dialog";
import { HoverCard } from "@kobalte/core/hover-card";
import { createSignal, For, type JSX, onCleanup, Show } from "solid-js";

import type { Module } from "../lib/dashboard-route";
import { haptic } from "../lib/haptics";
import { isModuleLocked, MODULE_NAV, type ModuleDef, moduleDef } from "../lib/module-nav";
import { createSlidingPill } from "../lib/sliding-pill";

/** Shared row shape for both surfaces, so the rail and the sheet read as the
 *  same control at two sizes rather than as two different navs. */
const rowBase =
  "font-body flex w-full items-center gap-3 rounded-sm text-left tracking-ui-wider uppercase " +
  "transition-colors duration-(--dur-fast) ease-(--ease-out)";

const rowIdle = "text-text-muted hover:text-text hover:bg-surface/50";
const rowActive = "text-gold bg-gold/10";

/** The rail's active row carries no background of its own — the pill behind it
 *  is the background, and it travels. Colour is all the row has to change. */
const railActive = "text-gold";

/**
 * A locked row: dimmer than an idle one, and it changes nothing on hover
 * because it does not navigate.
 *
 * `text-faint` rather than `text-muted` with an `opacity` on top. Both text
 * tokens are already translucent (see the ink ramp in `styles/global.css`), so
 * stacking `opacity-50` on `text-muted` multiplies the two and lands the label
 * under every token on the ramp. One token is the whole fade, and the ramp's
 * own comment says what it buys: `text-faint` clears 3:1, not the 4.5:1 that
 * normal-size text wants. That is a deliberate trade for a control whose
 * purpose is to be de-emphasised, and the lock is carried in the row's
 * accessible name rather than by its colour, so nothing depends on reading it.
 */
const rowLocked = "text-text-faint cursor-default";

/** How long a pointer has to rest on a locked row before its upgrade popover
 *  opens. Kobalte's own default is 700ms, which is short enough to fire while
 *  the pointer is merely crossing the rail. */
const DWELL_MS = 3000;

/**
 * A nav row for a module this wedding is not entitled to.
 *
 * The row itself looks like every other row and carries the same content; what
 * changes is that it navigates nowhere, reads as locked to assistive tech, and
 * opens a popover offering the upgrade.
 *
 * Three ways in, because no one of them covers every surface:
 *
 * - A pointer resting on it for {@link DWELL_MS}, which is Kobalte's own
 *   `openDelay`.
 * - Keyboard focus held for the same delay (Kobalte's trigger treats focus and
 *   pointer-enter alike).
 * - A click or a tap, which is the only path a touch user has — Kobalte's
 *   trigger ignores touch pointers outright, so a hover-only row would be
 *   silently dead on the phone surface. That is also what makes the row a
 *   no-op rather than an unresponsive control: the click opens the offer
 *   instead of opening the module. It toggles, because a touch user has no
 *   pointer-leave to close the card with and tapping the row again is the
 *   obvious way out.
 *
 * The lock is announced in the accessible name, not in the popover, so a
 * screen-reader user hears it while tabbing rather than having to dwell.
 */
function LockedRow(props: {
  mod: ModuleDef;
  rowClass: string;
  placement: "right-start" | "bottom-start";
  children: JSX.Element;
}) {
  const [open, setOpen] = createSignal(false);
  const lock = () => props.mod.lock!;

  return (
    <HoverCard
      open={open()}
      onOpenChange={setOpen}
      openDelay={DWELL_MS}
      placement={props.placement}
      gutter={8}
      // The safe corridor between trigger and card costs two forced layouts per
      // document `pointermove` for as long as a card is open, and across an
      // 8px gutter it protects a gap the pointer crosses in one frame.
      ignoreSafeArea
    >
      {/* Never Kobalte's `disabled`: its trigger drops both the pointer-enter
          and the focus handler on a disabled trigger, so the card could not be
          opened by any path, and a disabled button takes no focus either.
          `aria-disabled` is wrong for the same reason it is tempting — the row
          *is* operable, it opens this card; a control that answers a click must
          not tell assistive tech it does nothing. What it does not do is
          navigate, and that is what the accessible name says.

          `role` is explicit because the trigger renders Kobalte's link, which
          would otherwise call a `<button>` a link. */}
      <HoverCard.Trigger
        as="button"
        type="button"
        // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role
        role="button"
        aria-expanded={open()}
        aria-label={`${props.mod.label} — locked. Upgrade to unlock.`}
        onClick={() => setOpen((was) => !was)}
        class={props.rowClass}
      >
        {props.children}
      </HoverCard.Trigger>

      {/* Portalled on both surfaces: the sheet's nav scrolls and would clip an
          in-flow card, and on the rail it keeps the card's own button out of
          the nav's control list. */}
      <HoverCard.Portal>
        <HoverCard.Content class="border-border bg-surface-raised z-50 flex w-64 flex-col gap-2 rounded-sm border p-3 shadow-lg outline-none">
          <p class="font-display text-text text-ui-md leading-tight font-light">{lock().title}</p>
          <p class="text-text-muted text-ui-sm leading-snug">{lock().blurb}</p>
          <Button
            variant="quiet"
            size="sm"
            type="button"
            disabled
            aria-disabled="true"
            class="tracking-ui-widest mt-1"
          >
            Upgrade — coming soon
          </Button>
        </HoverCard.Content>
      </HoverCard.Portal>
    </HoverCard>
  );
}

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
 *
 * A module the wedding is not entitled to keeps its row on both surfaces. It is
 * faded, navigates nowhere, and offers the upgrade instead — see
 * {@link LockedRow}.
 */
export default function ModuleSidebar(props: {
  active: Module;
  entitlements: readonly string[];
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
            const locked = () => isModuleLocked(mod.id, props.entitlements);
            const Body = () => (
              <>
                <span aria-hidden="true" class="w-4 shrink-0 text-center text-[0.95em] opacity-80">
                  {mod.glyph}
                </span>
                <span class="min-w-0 truncate">{mod.label}</span>
              </>
            );
            const railRow = `${rowBase} relative px-3 py-2 text-ui-sm`;
            // `Show`, not a ternary. `MODULE_NAV` never changes, so `For` runs
            // this callback once per module and a ternary between two elements
            // would be resolved once and for all — a wedding switched underneath
            // the rail, or an entitlement granted mid-session, would leave the
            // row showing the previous wedding's lock.
            return (
              <Show
                when={locked()}
                fallback={
                  <button
                    ref={pill.item(mod.id)}
                    type="button"
                    aria-current={isActive() ? "page" : undefined}
                    title={mod.hint}
                    onClick={() => props.onSelect(mod.id)}
                    class={`${railRow} ${isActive() ? railActive : rowIdle}`}
                  >
                    <Body />
                  </button>
                }
              >
                <LockedRow mod={mod} placement="right-start" rowClass={`${railRow} ${rowLocked}`}>
                  <Body />
                </LockedRow>
              </Show>
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
            class={`${rowBase} border-border bg-surface/40 text-text hover:border-gold-dim text-ui-sm justify-between border px-4 py-3`}
          >
            <span class="flex min-w-0 items-center gap-3">
              <span aria-hidden="true" class="text-gold w-4 shrink-0 text-center text-[1em]">
                {current().glyph}
              </span>
              <span class="min-w-0 truncate">{current().label}</span>
            </span>
            <span class="text-text-muted text-ui-xs tracking-ui-widest flex shrink-0 items-center gap-2">
              Modules
              <span aria-hidden="true" class="text-gold text-ui-base tracking-normal">
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
                <Dialog.Title class="font-display text-text text-ui-md leading-none font-light">
                  Wedding modules
                </Dialog.Title>
                <Dialog.CloseButton
                  aria-label="Close modules"
                  class="text-text-muted hover:text-gold hover:border-gold-dim border-border text-ui-base flex h-8 w-8 shrink-0 items-center justify-center rounded-sm border transition-colors duration-(--dur-fast)"
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
                    const locked = () => isModuleLocked(mod.id, props.entitlements);
                    const Body = () => (
                      <>
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
                          <span class="text-text-muted text-ui-xs leading-snug tracking-normal normal-case">
                            {mod.hint}
                          </span>
                        </span>
                      </>
                    );
                    const sheetRow = `${rowBase} items-start px-3 py-2.5 text-ui-sm`;
                    // `Show` for the same reason as the rail above.
                    return (
                      <Show
                        when={locked()}
                        fallback={
                          <button
                            type="button"
                            aria-current={isActive() ? "page" : undefined}
                            onClick={() => select(mod.id)}
                            class={`${sheetRow} ${isActive() ? rowActive : rowIdle}`}
                          >
                            <Body />
                          </button>
                        }
                      >
                        <LockedRow
                          mod={mod}
                          placement="bottom-start"
                          rowClass={`${sheetRow} ${rowLocked}`}
                        >
                          <Body />
                        </LockedRow>
                      </Show>
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
