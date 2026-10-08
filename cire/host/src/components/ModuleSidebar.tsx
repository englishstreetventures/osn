import Button from "@cire/ui/button";
import { Dialog } from "@kobalte/core/dialog";
import { Popover } from "@kobalte/core/popover";
import Menu from "lucide-solid/icons/menu";
import { createSignal, For, type JSX, onCleanup, Show, untrack } from "solid-js";
import { Portal } from "solid-js/web";

import type { Module } from "../lib/dashboard-route";
import { haptic } from "../lib/haptics";
import { type LockedExport as LockedExportSpec, lockedExportFor } from "../lib/locked-exports";
import { isModuleLocked, MODULE_NAV, type ModuleDef, moduleDef } from "../lib/module-nav";
import { createPointerDwell } from "../lib/pointer-dwell";
import { createSlidingPill } from "../lib/sliding-pill";
import { type Tier, TIER_LABEL } from "../lib/tiers";
import LockedExport from "./LockedExport";
import ModuleIcon from "./ModuleIcon";
import UpgradeDialog from "./UpgradeDialog";

/** Shared row shape for both surfaces, so the rail and the sheet read as the
 *  same control at two sizes rather than as two different navs. */
const rowBase =
  "font-body flex w-full items-center gap-3 rounded-sm text-left tracking-ui-wider uppercase " +
  "transition-colors duration-(--dur-fast) ease-(--ease-out)";

const rowIdle = "text-text-muted hover:text-text hover:bg-surface/50";

/**
 * The selected row's label is `gold-ink`, not `gold`. Gold is a metal with no
 * contrast contract (`styles/global.css`): in the light theme it paints about
 * 2.2:1 on its own wash, and this label, the one that says where the organiser
 * is, is normal-size text that needs 4.5:1. `gold-ink` clears that on the wash
 * in both themes. The icon beside it stays gold, set on the icon itself: it is
 * decoration (hidden from assistive tech, the label names the row), so no
 * contrast floor applies to it.
 */
const rowActive = "text-gold-ink bg-gold/10";

/** The rail's active row carries no background of its own — the pill behind it
 *  is the background, and it travels. Colour is all the row has to change. */
const railActive = "text-gold-ink";

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

/** How long a pointer has to rest on a locked row before its card opens. Long
 *  enough that a pointer merely crossing the rail opens nothing. */
const DWELL_MS = 3000;

/** How long a pointer may be off both a previewed card and its row before the
 *  card closes — Kobalte's own hover-card default, long enough to cross the
 *  8px gutter between them. */
const LEAVE_MS = 300;

/** What Tab stops on inside a card, in document order. */
const CARD_CONTROLS = "button:not(:disabled), a[href]";

/**
 * A nav row for a module this wedding's tier does not include.
 *
 * The row itself looks like every other row and carries the same content; what
 * changes is that it navigates nowhere, reads as locked to assistive tech, and
 * opens a card naming the tier that includes it and offering the upgrade.
 *
 * Two ways in:
 *
 * - **A press** — a click, a tap, Enter or Space. This is the row's action: it
 *   opens the offer instead of the module, and focus moves into the card, onto
 *   "Upgrade to …". Escape closes it and puts focus back on the row; a click
 *   outside closes it. Pressing the row again closes it too, which is the
 *   obvious way out for a touch user, who has no pointer to move away.
 * - **A pointer resting on the row** for {@link DWELL_MS}, on the rail only.
 *   That card is a preview: it takes no focus, and it closes once the pointer
 *   has been off the row and the card for {@link LEAVE_MS}. The moment focus
 *   goes into it, it is a card someone is using, and the pointer leaving no
 *   longer closes it. The sheet has no dwell: it is the phone's surface, and an
 *   open card stands down the sheet's focus trap, so a preview opened under a
 *   keyboard user would hand them a way out of the modal.
 *
 * The card is portalled, so in the document it sits at the end of `<body>`,
 * nowhere near its row. Two key handlers put it back in the tab order straight
 * after the row: Tab on the open row goes into the card, Shift+Tab on the
 * card's first control comes back to the row, and Tab on its last control goes
 * to the row and lets the browser's own Tab carry on from there, to the next
 * row. That last step relies on a locked row never being the nav's last row —
 * Guests, Invite and Settings end `MODULE_NAV` and no tier locks them.
 *
 * The lock, and the tier that lifts it, are announced in the accessible name,
 * not only in the card, so a screen-reader user hears both while tabbing.
 *
 * For an owner, the Budget, Checklist and Registry cards also offer the rows
 * the wedding holds there, as a CSV download ({@link LockedExport}).
 */
function LockedRow(props: {
  mod: ModuleDef;
  rowClass: string;
  placement: "right-start" | "bottom-start";
  /** Whether a pointer resting on the row opens the card. */
  dwell: boolean;
  /** Opens the upgrade dialog, given the row that asked. Lifted to the sidebar
   *  so there is ONE dialog rather than one per locked row. */
  onUpgrade: (row: HTMLElement) => void;
  weddingId: string;
  weddingSlug: string;
  /** The module's download, when the card should offer one: an owner's
   *  Budget, Checklist or Registry card. */
  lockedExport?: LockedExportSpec;
  children: JSX.Element;
}) {
  const [open, setOpen] = createSignal(false);
  /** The open card is a pointer's preview: opened by a dwell, and not yet
   *  used. Only a preview closes when the pointer leaves. */
  const [preview, setPreview] = createSignal(false);
  /** The close in flight is the pointer leaving a preview, so focus stays
   *  wherever it is rather than jumping to the row. */
  let closingOnLeave = false;
  let row: HTMLButtonElement | undefined;
  let card: HTMLDivElement | undefined;
  const lock = () => props.mod.lock!;

  const dwell = createPointerDwell({
    openDelay: DWELL_MS,
    closeDelay: LEAVE_MS,
    onDwell: () => {
      if (open()) return;
      setPreview(true);
      setOpen(true);
    },
    // Checked again when the delay is up: focus may have gone into the card
    // in the meantime, and a card in use stays.
    onLeave: () => {
      if (!open() || !preview()) return;
      closingOnLeave = true;
      setOpen(false);
    },
    armLeave: () => open() && preview(),
  });

  const controls = () => (card ? [...card.querySelectorAll<HTMLElement>(CARD_CONTROLS)] : []);

  const onRowKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Tab" || event.shiftKey || !open()) return;
    const first = controls()[0];
    if (!first) return;
    event.preventDefault();
    first.focus();
  };

  const onCardKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Tab") return;
    const list = controls();
    const edge = event.shiftKey ? list[0] : list.at(-1);
    if (!edge || document.activeElement !== edge) return;
    row?.focus();
    // Backwards, the row is where focus stops. Forwards, the row is where the
    // browser's Tab starts from, so the default is left to run.
    if (event.shiftKey) event.preventDefault();
  };

  return (
    <Popover
      open={open()}
      onOpenChange={(next) => {
        dwell.cancel();
        setPreview(false);
        setOpen(next);
      }}
      placement={props.placement}
      gutter={8}
    >
      {/* A real `<button>`, and never `disabled`: a disabled button takes no
          focus and answers no press, so the card could not be opened at all.
          `aria-disabled` is wrong for the same reason it is tempting — the row
          *is* operable, it opens this card; a control that answers a press
          must not tell assistive tech it does nothing. What it does not do is
          navigate, and that is what the accessible name says. */}
      <Popover.Trigger
        ref={row}
        type="button"
        aria-label={`${props.mod.label} — locked. Included with ${TIER_LABEL[lock().tier]}.`}
        onKeyDown={onRowKeyDown}
        onPointerEnter={(event: PointerEvent) => {
          if (props.dwell) dwell.enterTrigger(event);
        }}
        onPointerLeave={(event: PointerEvent) => {
          if (props.dwell) dwell.leave(event);
        }}
        class={props.rowClass}
      >
        {props.children}
      </Popover.Trigger>

      {/* Portalled on both surfaces: the sheet's nav scrolls and would clip an
          in-flow card, and on the rail it keeps the card's own button out of
          the nav's control list. */}
      <Popover.Portal>
        <Popover.Content
          ref={card}
          // The sheet is a modal Dialog, which hides from assistive tech every
          // node added to `<body>` outside it; this marks the card as one to
          // leave visible.
          data-kb-top-layer=""
          onOpenAutoFocus={(event) => {
            // Untracked: Kobalte dispatches this inside its focus scope's own
            // effect, so a tracked read would rerun that effect when the
            // preview ends — and its cleanup hands focus back to the row.
            if (untrack(preview)) event.preventDefault();
          }}
          onCloseAutoFocus={(event) => {
            if (!closingOnLeave) return;
            closingOnLeave = false;
            event.preventDefault();
          }}
          onFocusIn={() => setPreview(false)}
          onPointerEnter={(event: PointerEvent) => {
            if (props.dwell) dwell.enterCard(event);
          }}
          onPointerLeave={(event: PointerEvent) => {
            if (props.dwell) dwell.leave(event);
          }}
          onKeyDown={onCardKeyDown}
          class="border-border bg-surface-raised z-50 flex w-64 flex-col gap-2 rounded-sm border p-3 shadow-lg outline-none"
        >
          {/* `gold-ink`, not `gold`: this is small text that has to be read,
              and gold has no contrast contract (`styles/global.css`). */}
          <p class="font-body text-gold-ink text-ui-xs tracking-ui-widest uppercase">
            Included with {TIER_LABEL[lock().tier]}
          </p>
          {/* Title and description name the card's `role="dialog"`; `as="p"`
              keeps a heading out of the end of `<body>`. */}
          <Popover.Title as="p" class="font-display text-text text-ui-md leading-tight font-light">
            {lock().title}
          </Popover.Title>
          <Popover.Description as="p" class="text-text-muted text-ui-sm leading-snug">
            {lock().blurb}
          </Popover.Description>
          <Button
            variant="quiet"
            size="sm"
            type="button"
            onClick={() => {
              // Close the card first: it is anchored to a row that the dialog
              // is about to cover, and two layers of overlay on a phone leaves
              // the card floating over the scrim.
              setOpen(false);
              if (row) props.onUpgrade(row);
            }}
            class="mt-1"
          >
            Upgrade to {TIER_LABEL[lock().tier]}
          </Button>
          <Show when={props.lockedExport}>
            {(spec) => (
              <LockedExport
                weddingId={props.weddingId}
                weddingSlug={props.weddingSlug}
                spec={spec()}
              />
            )}
          </Show>
        </Popover.Content>
      </Popover.Portal>
    </Popover>
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
 * A module the wedding's tier does not include keeps its row on both surfaces.
 * It is faded, navigates nowhere, and offers the upgrade instead — see
 * {@link LockedRow}.
 */
export default function ModuleSidebar(props: {
  active: Module;
  weddingId: string;
  /** Names the locked modules' downloads (`cire-budget-<slug>.csv`). */
  weddingSlug: string;
  /** The wedding's plan tier — what decides which rows are locked. */
  tier: Tier;
  /** An owner of this wedding? Only an owner's locked cards offer a download:
   *  every export is owner-only. */
  canManage: boolean;
  onSelect: (module: Module) => void;
}) {
  const [sheetOpen, setSheetOpen] = createSignal(false);
  // Which locked module's offer is open, or null. One dialog for the whole nav:
  // every locked row would otherwise mount its own, and each would price itself
  // on open.
  const [upgrading, setUpgrading] = createSignal<ModuleDef | null>(null);
  /** Where focus goes when the upgrade dialog closes: the row that asked, or
   *  the sheet's trigger when the row went with the sheet. A plain variable
   *  rather than part of `upgrading`, because it is read as the dialog's
   *  `Show` tears down. */
  let upgradeOpener: HTMLElement | undefined;
  let sheetTrigger: HTMLButtonElement | undefined;

  const offerUpgrade = (mod: ModuleDef, opener: HTMLElement | undefined) => {
    upgradeOpener = opener;
    setUpgrading(mod);
  };

  const endUpgrade = () => {
    setUpgrading(null);
    upgradeOpener?.focus();
    upgradeOpener = undefined;
  };

  const current = () => moduleDef(props.active);

  /** The download a locked module's card offers this caller, if any. Read
   *  through a function so a role change reaches a row already rendered. */
  const lockedExport = (module: Module): LockedExportSpec | undefined =>
    props.canManage ? lockedExportFor(module) : undefined;

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
          <span class="bg-gold absolute inset-y-1 left-0 w-0.5 rounded-full" />
        </span>
        <For each={MODULE_NAV}>
          {(mod) => {
            const isActive = () => props.active === mod.id;
            const locked = () => isModuleLocked(mod.id, props.tier);
            const Body = () => (
              <>
                <ModuleIcon
                  icon={mod.icon}
                  class={isActive() ? "text-gold opacity-80" : "opacity-80"}
                />
                <span class="min-w-0 truncate">{mod.label}</span>
              </>
            );
            const railRow = `${rowBase} relative px-3 py-2 text-ui-sm`;
            // `Show`, not a ternary. `MODULE_NAV` never changes, so `For` runs
            // this callback once per module and a ternary between two elements
            // would be resolved once and for all — a wedding switched underneath
            // the rail, or a tier raised mid-session, would leave the row
            // showing the previous lock.
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
                <LockedRow
                  mod={mod}
                  placement="right-start"
                  rowClass={`${railRow} ${rowLocked}`}
                  dwell
                  onUpgrade={(row) => offerUpgrade(mod, row)}
                  weddingId={props.weddingId}
                  weddingSlug={props.weddingSlug}
                  lockedExport={lockedExport(mod.id)}
                >
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
            ref={sheetTrigger}
            aria-label={`Open wedding navigation, currently ${current().label}`}
            class={`${rowBase} border-border bg-surface/40 text-text hover:border-gold-dim text-ui-sm justify-between border px-4 py-3`}
          >
            <span class="flex min-w-0 items-center gap-3">
              <ModuleIcon icon={current().icon} class="text-gold" />
              <span class="min-w-0 truncate">{current().label}</span>
            </span>
            <span class="text-text-muted text-ui-xs tracking-ui-widest flex shrink-0 items-center gap-2">
              <ModuleIcon icon={Menu} class="text-gold" />
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
                    const locked = () => isModuleLocked(mod.id, props.tier);
                    const Body = () => (
                      <>
                        <ModuleIcon
                          icon={mod.icon}
                          class={isActive() ? "text-gold" : "text-gold-dim"}
                        />
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
                          dwell={false}
                          weddingId={props.weddingId}
                          weddingSlug={props.weddingSlug}
                          lockedExport={lockedExport(mod.id)}
                          onUpgrade={() => {
                            // The sheet is a modal; leaving it open behind the
                            // dialog would trap focus in the wrong layer. Its
                            // rows go with it, so focus comes back to the
                            // trigger that opens it.
                            setSheetOpen(false);
                            offerUpgrade(mod, sheetTrigger);
                          }}
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

      {/* One dialog for the whole nav, driven by which row asked for it.
          Mounted per offer: closing clears `upgrading`, so every open starts
          a fresh dialog rather than one still holding the last offer's
          submitting state. It sells the tier the row's lock names, and sends
          the organiser back to the module they asked for.

          Portalled to `<body>`, though a `<dialog>` in the top layer needs no
          portal to paint: the sheet marks the app root `aria-hidden` while it
          is open and lifts that a frame after it closes, and an offer from
          the sheet opens this dialog in that frame. A node added to `<body>`
          after the sheet has closed is outside what it hid. */}
      <Show when={upgrading()}>
        {(mod) => (
          <Portal>
            <UpgradeDialog
              open
              weddingId={props.weddingId}
              tier={mod().lock!.tier}
              module={mod().id}
              title={TIER_LABEL[mod().lock!.tier]}
              blurb={mod().lock!.blurb}
              onClose={endUpgrade}
            />
          </Portal>
        )}
      </Show>
    </>
  );
}
