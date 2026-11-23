import Button, { buttonClass } from "@cire/ui/button";
import Eyebrow from "@cire/ui/eyebrow";
import { createSlidingPill } from "@cire/ui/sliding-pill";
import { Dialog } from "@kobalte/core/dialog";
import { Popover } from "@kobalte/core/popover";
import { Tooltip } from "@kobalte/core/tooltip";
import LayoutGrid from "lucide-solid/icons/layout-grid";
import Lock from "lucide-solid/icons/lock";
import PanelLeftClose from "lucide-solid/icons/panel-left-close";
import PanelLeftOpen from "lucide-solid/icons/panel-left-open";
import X from "lucide-solid/icons/x";
import {
  type ComponentProps,
  createEffect,
  createSignal,
  createUniqueId,
  For,
  type JSX,
  on,
  onCleanup,
  Show,
  splitProps,
  untrack,
} from "solid-js";
import { Portal } from "solid-js/web";

import type { Module } from "../lib/dashboard-route";
import { type LockedExport as LockedExportSpec, lockedExportFor } from "../lib/locked-exports";
import { isModuleLocked, MODULE_NAV, type ModuleDef, moduleDef } from "../lib/module-nav";
import { createPointerDwell } from "../lib/pointer-dwell";
import { readRailCollapsed, writeRailCollapsed } from "../lib/rail-preference";
import { type Tier, TIER_LABEL } from "../lib/tiers";
import { haptic } from "../lib/touch-feedback";
import LockedExport from "./LockedExport";
import ModuleIcon from "./ModuleIcon";
import UpgradeDialog from "./UpgradeDialog";

/** Shared row shape for both surfaces, so the rail and the sheet read as the
 *  same control at two sizes rather than as two different navs. The gap
 *  between icon and label is each surface's own: the collapsed rail has none. */
const rowBase =
  "font-body flex w-full items-center rounded-sm text-left tracking-ui-wider uppercase " +
  "transition-ui-colors duration-(--dur-fast) ease-(--ease-out)";

const rowIdle = "text-text-muted hover:text-text hover:bg-surface/50";

/** The rail's active row carries no background of its own — the pill behind it
 *  is the background, and it travels. Colour is all the row has to change. */
const railActive = "text-gold-ink";

/**
 * A locked row: dimmer than an idle one, and it changes nothing on hover
 * because it does not navigate.
 *
 * The row's ink is `text-faint`, which its icon takes: a graphic, held to the
 * 3:1 that token clears. The row is still a control — it opens the module's
 * offer — so its name is a word a host reads and takes `text-muted`, 4.5:1,
 * where the row's `Body` sets it. The lock is carried in the row's accessible
 * name rather than by its colour. No `opacity` on top: both text tokens are
 * already translucent, and stacking one would multiply the two.
 */
const rowLocked = "text-text-faint cursor-default";

/**
 * The phone's bottom bar: the four modules a host opens most, then More.
 * None of the four is ever locked, so the bar never holds an offer; every
 * module, these four included, is also in the menu More opens.
 */
const PHONE_TABS = ["overview", "guests", "events", "invite"] as const satisfies readonly Module[];

/** A tab in the bottom bar: icon over a short label, the whole cell a target
 *  at least 44px square. Sentence case, unlike the rail: at 11px a tracked
 *  uppercase word does not fit a fifth of a phone. */
const tabBase =
  "font-body text-ui-xs tracking-ui-normal flex min-w-0 flex-1 flex-col items-center justify-center gap-1 " +
  "transition-ui-colors duration-(--dur-fast) ease-(--ease-out) touch-manipulation";

const tabIdle = "text-text-muted hover:text-text";

/** The tab where the host is: readable gold, and semibold, so the mark is
 *  not carried by colour alone (WCAG 1.4.1). The wash behind the icon is the
 *  rail's and the menus' 10%. */
const tabActive = "text-gold-ink font-semibold";

/** The pill behind a tab's icon, washed in gold when that tab is where the
 *  host is. Fixed size, so the icon never moves when the wash comes or goes. */
const tabMark =
  "grid h-7 w-12 place-items-center rounded-full transition-ui-colors duration-(--dur-fast) ease-(--ease-out)";

/** A tile in the module menu: a block pressed to choose, so the field corner. */
const menuTile =
  "font-body text-ui-xs tracking-ui-normal relative flex w-full flex-col items-center justify-center gap-2 " +
  "rounded-ui-field border px-2 py-4 text-center transition-ui-colors duration-(--dur-fast) ease-(--ease-out)";

const menuTileIdle = "border-border bg-surface/60 text-text hover:border-border-strong";

/** The open module's tile. Its word is `gold-ink`, not `gold`: gold is a metal
 *  with no contrast contract (`styles/global.css`), about 2.2:1 on its own
 *  wash in the light theme, and this word, the one that says where the host
 *  is, needs 4.5:1. Its icon stays `gold`: decoration, hidden from assistive
 *  tech, beside the word that names the tile. */
const menuTileActive = "border-gold-dim bg-gold/10 text-gold-ink font-semibold";

/** A locked tile: the same dim ink as a locked rail row, and a lock glyph in
 *  its corner, since a tile has no row of neighbours to look dimmer than. */
const menuTileLocked = "border-border bg-transparent text-text-faint cursor-default";

/** How long a pointer has to rest on a locked row before its card opens. Long
 *  enough that a pointer merely crossing the rail opens nothing. */
const DWELL_MS = 3000;

/** How long a pointer may be off both a previewed card and its row before the
 *  card closes — Kobalte's own hover-card default, long enough to cross the
 *  8px gutter between them. */
const LEAVE_MS = 300;

/** What Tab stops on inside a card, in document order. */
const CARD_CONTROLS = "button:not(:disabled), a[href]";

/** How long a pointer rests on a collapsed rail's row before its label shows.
 *  Long enough that a pointer crossing the rail on its way to the panel opens
 *  nothing; once one label has shown, Kobalte's skip delay shows the next row's
 *  at once, so running down the rail reads each label in turn. */
const TIP_DELAY_MS = 300;

/**
 * The label beside an icon on the collapsed rail, and beside the toggle.
 *
 * For the eye only. The panel is `aria-hidden` and no element points at it: a
 * row's accessible name is already its label, and its description is its hint
 * (see the rail below), so a screen reader hears each once whether the panel
 * is open or not. Keyboard focus shows it at once; a pointer after
 * {@link TIP_DELAY_MS}; touch never, because Kobalte ignores touch.
 *
 * `open` is held here rather than left to Kobalte, because Kobalte's `disabled`
 * only stops a label opening from a new hover or focus. A label shows only
 * while it is enabled, so expanding the rail or opening a card takes any label
 * off the screen. And a press that opens a card lands inside the open delay a
 * pointer started on the way in, which Kobalte lets run out; the open it asks
 * for then is refused, so the label does not appear once the card has closed
 * and the pointer has gone.
 *
 * `z-50`: Kobalte copies the content's computed `z-index` onto the element it
 * positions, so without one the label paints under the sticky top bar (`z-30`)
 * and the panel's own layers. It keeps pointer events, so a pointer can move
 * onto it without it closing.
 */
function RailTip(props: {
  enabled: boolean;
  label: string;
  /** A second, quieter line: the module's hint, or the tier a lock names. */
  detail?: JSX.Element;
  children: JSX.Element;
}) {
  const [open, setOpen] = createSignal(false);
  return (
    <Tooltip
      open={props.enabled && open()}
      onOpenChange={(next) => setOpen(next && props.enabled)}
      disabled={!props.enabled}
      placement="right"
      gutter={8}
      openDelay={TIP_DELAY_MS}
    >
      {props.children}
      <Tooltip.Portal>
        <Tooltip.Content
          aria-hidden="true"
          data-rail-tip=""
          class="rail-tip border-border bg-surface-raised z-50 flex max-w-64 flex-col gap-0.5 rounded-md border px-3 py-2 shadow-md"
        >
          <span class="font-body text-text text-ui-xs tracking-ui-wider uppercase">
            {props.label}
          </span>
          {props.detail}
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip>
  );
}

/**
 * The toggle's element: a plain `<button>` that declines `aria-describedby`.
 *
 * Kobalte's tooltip trigger points `aria-describedby` at its open panel, which
 * Chrome exposes as the trigger's description, so a screen reader would hear
 * "Expand sidebar" twice. Kobalte sets it before the caller's props and Solid's
 * `mergeProps` skips `undefined`, so only the element can decline it — the same
 * move as `TriggerSpan` in `@shared/ui`'s tooltip.
 */
function ToggleButton(props: ComponentProps<"button">) {
  const [, rest] = splitProps(props, ["aria-describedby"]);
  return <button {...rest} />;
}

/** A locked row's element: its card's trigger, which the label's trigger wears.
 *  It declines `aria-describedby` for the reason {@link ToggleButton} gives —
 *  a locked row carries no description on either rail, and its name already
 *  says what the label does. */
function LockedTrigger(props: ComponentProps<typeof Popover.Trigger>) {
  const [, rest] = splitProps(props, ["aria-describedby"]);
  return <Popover.Trigger {...rest} />;
}

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
 * - **A pointer resting on the row** for {@link DWELL_MS}, on the expanded rail
 *   only. That card is a preview: it takes no focus, and it closes once the
 *   pointer has been off the row and the card for {@link LEAVE_MS}. The moment
 *   focus goes into it, it is a card someone is using, and the pointer leaving
 *   no longer closes it. The sheet has no dwell: it is the phone's surface, and
 *   an open card stands down the sheet's focus trap, so a preview opened under
 *   a keyboard user would hand them a way out of the modal. The collapsed rail
 *   has none either: its row already shows a label naming the lock after
 *   {@link TIP_DELAY_MS}, and a card in the same place three seconds later
 *   would say it again.
 *
 * The card is portalled, so in the document it sits at the end of `<body>`,
 * nowhere near its row. Two key handlers put it back in the tab order straight
 * after the row: Tab on the open row goes into the card, Shift+Tab on the
 * card's first control comes back to the row, and Tab on its last control goes
 * to the row and lets the browser's own Tab carry on from there, to the next
 * row. That last step relies on a locked row never being the nav's last row —
 * Invite and Settings end `MODULE_NAV` and no tier locks them.
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
  placement: "right-start" | "top";
  /** Whether a pointer resting on the row opens the card. */
  dwell: boolean;
  /** Whether the row shows its label beside it — on the collapsed rail, while
   *  no card is open. */
  tip?: boolean;
  /** Told when the card opens and closes, so the rail can keep every label
   *  off the screen while a card is on it. */
  onCardChange?: (open: boolean) => void;
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

  createEffect(on(open, (isOpen) => props.onCardChange?.(isOpen)));

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
          navigate, and that is what the accessible name says.

          The label sits inside the card's root and outside its portal: both
          provide the context Kobalte positions a panel from, and each panel
          reads the nearest. Both triggers also write `data-expanded` and
          `data-closed` onto this one element, so nothing styles the row on
          them. */}
      <RailTip
        enabled={props.tip ?? false}
        label={props.mod.label}
        detail={<Eyebrow as="span">Included with {TIER_LABEL[lock().tier]}</Eyebrow>}
      >
        <Tooltip.Trigger
          as={LockedTrigger}
          ref={row}
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
        </Tooltip.Trigger>
      </RailTip>

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
          class="border-border bg-surface-raised menu-pop z-50 flex w-64 flex-col gap-2 rounded-md border p-3 shadow-(--elev-2) outline-none"
        >
          {/* `gold-ink`, not `gold`: this is small text that has to be read,
              and gold has no contrast contract (`styles/global.css`). */}
          <Eyebrow>Included with {TIER_LABEL[lock().tier]}</Eyebrow>
          {/* Title and description name the card's `role="dialog"`; `as="p"`
              keeps a heading out of the end of `<body>`. */}
          <Popover.Title
            as="p"
            class="font-display text-text text-ui-md leading-ui-tight font-light"
          >
            {lock().title}
          </Popover.Title>
          <Popover.Description as="p" class="text-text-muted text-ui-sm leading-ui-snug">
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
 * - Narrow container — a bar fixed to the foot of the screen, in reach of a
 *   thumb: Overview, Guests, Events and Invite, then More. More opens every
 *   module as a grid of tiles in a sheet that rises from the bar, all of them
 *   on one screen with no scrolling. The sheet is a Kobalte dialog, so focus
 *   trapping, escape-to-close, background scroll lock, `aria-modal`, and focus
 *   restored to More on close all come from the library. When the open module
 *   is not one of the bar's four, More wears its icon and name.
 *
 * Only one surface is laid out at a time — the other is `display: none`, so
 * assistive tech sees one nav, never a duplicate.
 *
 * A module the wedding's tier does not include keeps its row on both surfaces.
 * It is faded, navigates nowhere, and offers the upgrade instead — see
 * {@link LockedRow}.
 *
 * The rail collapses to its icons and back from a toggle at its top, and the
 * browser remembers the choice (`lib/rail-preference.ts`). Collapsed, every row
 * is still one click away and still marked when active; its label moves into
 * {@link RailTip}. The sheet ignores the choice: a phone has no room to give.
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
  /** Whether the shell is below the rail breakpoint, so the bottom bar shows.
   *  Starts true: the probe's first report lands after layout and before
   *  paint, so a wide shell never paints the bar, and a test DOM with no
   *  layout keeps it. */
  const [narrow, setNarrow] = createSignal(true);
  // Tells what lives outside the shell — a view's save bar, the toasts — that
  // the bar holds the foot of the screen (`--foot-h` in `global.css`).
  createEffect(() => {
    if (typeof document === "undefined") return;
    document.documentElement.toggleAttribute("data-tab-bar", narrow());
  });
  onCleanup(() => {
    if (typeof document !== "undefined") document.documentElement.removeAttribute("data-tab-bar");
  });
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

  // Read as the signal's first value, not on mount, so a rail the organiser
  // left collapsed paints collapsed and never slides in on load.
  const [collapsed, setCollapsed] = createSignal(readRailCollapsed());
  /** Set by the first press of the toggle, and only then: the labels fade in
   *  as the rail widens, never on a page that loads expanded. */
  const [moved, setMoved] = createSignal(false);
  /** A press's slide is running. The width transition is on the rail only
   *  then: the expanded width also steps when the shell crosses `@5xl/shell`
   *  (a resize, zoom, a scrollbar arriving), and that should land at once,
   *  as everything else in the shell does, not slide the panel for 200ms. */
  const [sliding, setSliding] = createSignal(false);
  /** A locked row's card is open on the rail. While one is, no label shows
   *  anywhere on the rail. One flag serves every row: a card closes on the
   *  pointer-down or the focus leaving it, before another row's press opens
   *  the next. */
  const [cardOpen, setCardOpen] = createSignal(false);
  const railTips = () => collapsed() && !cardOpen();
  const navId = createUniqueId();

  const toggleRail = () => {
    const next = !collapsed();
    setSliding(true);
    setCollapsed(next);
    setMoved(true);
    writeRailCollapsed(next);
  };

  /** Any transition ending in the rail clears it, a row's hover colour
   *  included: a slide already running carries on when the class goes, since
   *  the default `transition-property`, `all`, still names `width`. Only an end
   *  clears it, never a cancel: a second press mid-slide cancels the first
   *  transition and starts the reverse, which has to start with the class on. */
  const slideEnded = () => setSliding(false);

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

  /** The open module lives only in the menu, not on the bar: More then wears
   *  its icon and name, so the bar still says where the host is. */
  const inMenu = () => !(PHONE_TABS as readonly Module[]).includes(props.active);
  /** More's visible word: the open module's name when the bar lacks it. Its
   *  accessible name starts with this word, so a voice command that says what
   *  it sees reaches it (WCAG 2.5.3). */
  const moreWord = () => (inMenu() ? current().label : "More");

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
   * Close the menu when the container grows past the rail breakpoint.
   *
   * The two surfaces swap by container query, so widening the shell hides the
   * bottom bar with `display: none`. The menu itself lives in a portal and
   * would survive that, leaving a modal open with no way back to its trigger. A
   * `ResizeObserver` reports a 0×0 box for a `display: none` element, which is
   * exactly the signal we want — and it reads the real container width rather
   * than duplicating the `@2xl` threshold in JS.
   */
  const watchNarrowSurface = (el: HTMLElement) => {
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      const box = entry?.contentRect;
      if (!box) return;
      const shown = box.width > 0 || box.height > 0;
      setNarrow(shown);
      if (!shown) setSheetOpen(false);
    });
    observer.observe(el);
    onCleanup(() => observer.disconnect());
  };

  return (
    <>
      {/* ── Wide container: persistent rail ────────────────────────────── */}
      {/* Sticky from the rail breakpoint up: on a tall panel (the invite
          builder, a long guest table) the modules used to scroll away, which is
          the one thing a persistent rail exists not to do. It sticks just under
          the page's sticky top bar, whose height is `--chrome-h`, plus the
          1.5rem of air it had at the top of the page. `self-start` keeps it
          from being stretched to the panel's height by the flex row — a
          full-height flex item has nothing to slide against.

          Two widths, swapped whole: a collapsed width beside `w-52` would lose
          to `@5xl/shell:w-56`, which is a container-query variant. Collapsed,
          the rail is the row's own padding around the icon — `px-3` twice and
          the 1.125rem icon, 2.625rem, which is `w-10.5` on the spacing scale —
          so no icon moves as it narrows; the panel takes the width it gives
          up. The width slides only while a press's slide runs ({@link
          sliding}). */}
      <div
        data-rail=""
        onTransitionEnd={slideEnded}
        class={`hidden shrink-0 flex-col @2xl/shell:sticky @2xl/shell:top-[calc(var(--chrome-h)+1.5rem)] @2xl/shell:flex @2xl/shell:self-start ${
          sliding() ? "transition-[width] duration-(--dur-base) ease-(--ease-in-out)" : ""
        } ${collapsed() ? "w-10.5" : "w-52 @5xl/shell:w-56"}`}
      >
        {/* The toggle: at the top of the rail, above the first module and a
            hairline, in the icons' own column, so it does not move between
            the two states and a second click undoes the first. It comes
            first in the tab order because it comes first on screen: focus
            follows what the eye reads, and a control placed before the list
            it changes is met before that list. Icon-only in both states,
            never a row with a label, so it is not read as one more module,
            and outside the `<nav>`, which holds the modules alone. Its name
            changes with the state and it also carries `aria-expanded`: the
            name is the words its label shows, and a state change is
            announced where a renamed focused button often is not. */}
        <div class="border-border mb-2 border-b pb-2">
          <RailTip
            enabled={!cardOpen()}
            label={collapsed() ? "Expand sidebar" : "Collapse sidebar"}
          >
            <Tooltip.Trigger
              as={ToggleButton}
              aria-label={collapsed() ? "Expand sidebar" : "Collapse sidebar"}
              aria-expanded={!collapsed()}
              aria-controls={navId}
              onClick={toggleRail}
              class={`${rowIdle} transition-ui-colors flex w-fit items-center rounded-sm px-3 py-2 duration-(--dur-fast) ease-(--ease-out)`}
            >
              <ModuleIcon icon={collapsed() ? PanelLeftOpen : PanelLeftClose} class="opacity-80" />
            </Tooltip.Trigger>
          </RailTip>
        </div>
        <nav
          id={navId}
          ref={pill.track}
          aria-label="Wedding modules"
          class="relative flex flex-col gap-0.5"
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
              const hintId = createUniqueId();
              // Collapsed, the label stays the row's accessible name and stays
              // in the row's flow at no width, with the gap before it gone. Not
              // `sr-only`: that takes the label's line box out of the row, which
              // is taller than the icon, and every row below would rise a
              // little — Settings, the last, by about 17px. Expanding after a
              // press, the label fades in as the rail makes room rather than
              // appearing cut short.
              //
              // Collapsed, the icon is all a row shows, so it is held to the 3:1
              // a graphic that identifies a control needs: no `opacity-80` fade,
              // and no `gold` of its own, so the active one takes the row's
              // `gold-ink`, which reads on the pill's wash where `gold` does
              // not. Expanded, the label carries the row and the icon keeps its
              // quieter look.
              const Body = () => (
                <>
                  <ModuleIcon
                    icon={mod.icon}
                    class={collapsed() ? "" : isActive() ? "text-gold opacity-80" : "opacity-80"}
                  />
                  <span
                    class={
                      collapsed()
                        ? "w-0 overflow-hidden whitespace-nowrap"
                        : `min-w-0 truncate ${moved() ? "rail-label" : ""} ${locked() ? "text-text-muted" : ""}`
                    }
                  >
                    {mod.label}
                  </span>
                </>
              );
              const railRow = () =>
                `${rowBase} ${collapsed() ? "" : "gap-3"} relative px-3 py-2 text-ui-sm`;
              // `Show`, not a ternary. `MODULE_NAV` never changes, so `For` runs
              // this callback once per module and a ternary between two elements
              // would be resolved once and for all — a wedding switched underneath
              // the rail, or a tier raised mid-session, would leave the row
              // showing the previous lock.
              return (
                <Show
                  when={locked()}
                  fallback={
                    <RailTip
                      enabled={railTips()}
                      label={mod.label}
                      detail={
                        <span class="font-body text-text-muted text-ui-xs leading-ui-snug">
                          {mod.hint}
                        </span>
                      }
                    >
                      {/* The hint is the row's description on both rails: the
                          native `title` while expanded, and a hidden copy the
                          row points at while collapsed, where a `title` would
                          be a second tooltip over the label. A described-by
                          the row sets beats the one Kobalte would point at the
                          label's panel. */}
                      <Tooltip.Trigger
                        ref={pill.item(mod.id)}
                        aria-current={isActive() ? "page" : undefined}
                        aria-describedby={collapsed() ? hintId : undefined}
                        title={collapsed() ? undefined : mod.hint}
                        onClick={() => props.onSelect(mod.id)}
                        class={`${railRow()} ${isActive() ? railActive : rowIdle}`}
                      >
                        <Body />
                        <Show when={collapsed()}>
                          <span id={hintId} hidden>
                            {mod.hint}
                          </span>
                        </Show>
                      </Tooltip.Trigger>
                    </RailTip>
                  }
                >
                  <LockedRow
                    mod={mod}
                    placement="right-start"
                    rowClass={`${railRow()} ${rowLocked}`}
                    dwell={!collapsed()}
                    tip={railTips()}
                    onCardChange={setCardOpen}
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
      </div>

      {/* ── Narrow container: bottom bar + module menu ─────────────────── */}
      {/* The probe is what the shell's container query hides: a 1px box,
          out of the flow, that is laid out only below the rail breakpoint.
          The bar itself is portalled to <body>, because a `fixed` element
          inside a `container-type` box pins to that box rather than to the
          screen. The shell pads its own foot by the bar, so the last row of
          a view is never under it. */}
      <span
        ref={watchNarrowSurface}
        aria-hidden="true"
        class="pointer-events-none invisible absolute size-px @2xl/shell:hidden"
      />
      <Show when={narrow()}>
        <Portal>
          <nav
            aria-label="Main modules"
            data-tab-bar=""
            class="border-border bg-bg/95 fixed inset-x-0 bottom-0 z-30 border-t pb-[env(safe-area-inset-bottom)] backdrop-blur-md"
          >
            <ul class="mx-auto grid h-(--tabbar-h) max-w-lg grid-cols-5 px-1">
              <For each={PHONE_TABS}>
                {(id) => {
                  const mod = moduleDef(id);
                  const isActive = () => props.active === id;
                  return (
                    <li class="flex">
                      <button
                        type="button"
                        aria-current={isActive() ? "page" : undefined}
                        onClick={() => select(id)}
                        class={`${tabBase} ${isActive() ? tabActive : tabIdle}`}
                      >
                        <span class={`${tabMark} ${isActive() ? "bg-gold/10" : ""}`}>
                          <ModuleIcon icon={mod.icon} />
                        </span>
                        <span class="max-w-full truncate">{mod.label}</span>
                      </button>
                    </li>
                  );
                }}
              </For>
              <li class="flex">
                {/* The dismiss haptic hangs off `onOpenChange` rather than off
                  `setSheetOpen`: escape, the scrim and the close button all
                  come through here, while picking a module (which closes the
                  menu by setting the signal directly) stays silent — a module
                  switch is navigation, not a dismissal. */}
                <Dialog
                  open={sheetOpen()}
                  onOpenChange={(open) => {
                    if (!open) haptic("dismiss");
                    setSheetOpen(open);
                  }}
                >
                  <Dialog.Trigger
                    ref={sheetTrigger}
                    aria-label={`${moreWord()}, open wedding navigation`}
                    class={`${tabBase} ${inMenu() ? tabActive : sheetOpen() ? "text-gold-ink" : tabIdle}`}
                  >
                    <span class={`${tabMark} ${inMenu() ? "bg-gold/10" : ""}`}>
                      <ModuleIcon icon={inMenu() ? current().icon : LayoutGrid} />
                    </span>
                    <span aria-hidden="true" class="max-w-full truncate">
                      {moreWord()}
                    </span>
                  </Dialog.Trigger>

                  <Dialog.Portal>
                    <Dialog.Overlay class="sheet-scrim bg-ui-scrim fixed inset-0 z-40" />
                    {/* The dialog takes its accessible name from Dialog.Title —
                      Kobalte wires the aria-labelledby. */}
                    <Dialog.Content class="sheet-rise border-border bg-surface-raised rounded-t-ui-sheet @container/menu fixed inset-x-0 bottom-0 z-50 mx-auto flex max-h-[calc(100dvh-var(--chrome-h))] max-w-lg flex-col border-x border-t shadow-(--elev-2) outline-none">
                      <div class="flex items-center justify-between gap-4 px-5 pt-4 pb-2">
                        <Dialog.Title class="font-display text-text text-ui-md leading-ui-tight font-light">
                          Wedding modules
                        </Dialog.Title>
                        <Dialog.CloseButton
                          aria-label="Close modules"
                          class={buttonClass({ variant: "bare", size: "icon" })}
                        >
                          <X aria-hidden="true" strokeWidth={1.75} class="size-4" />
                        </Dialog.CloseButton>
                      </div>

                      <nav
                        aria-label="All wedding modules"
                        class="min-h-0 flex-1 overflow-y-auto px-4 pt-2 pb-[calc(env(safe-area-inset-bottom)+1.25rem)]"
                      >
                        <ul class="grid grid-cols-3 gap-2 @md/menu:grid-cols-4">
                          <For each={MODULE_NAV}>
                            {(mod) => {
                              const isActive = () => props.active === mod.id;
                              const locked = () => isModuleLocked(mod.id, props.tier);
                              const Body = () => (
                                <>
                                  <Show when={locked()}>
                                    <Lock
                                      aria-hidden="true"
                                      strokeWidth={1.75}
                                      class="absolute top-2 right-2 size-3"
                                    />
                                  </Show>
                                  <ModuleIcon
                                    icon={mod.icon}
                                    class={
                                      isActive() ? "text-gold" : locked() ? "" : "text-gold-dim"
                                    }
                                  />
                                  <span class={locked() ? "text-text-muted" : ""}>{mod.label}</span>
                                </>
                              );
                              // `Show` for the same reason as the rail above.
                              return (
                                <li class="flex">
                                  <Show
                                    when={locked()}
                                    fallback={
                                      <button
                                        type="button"
                                        aria-current={isActive() ? "page" : undefined}
                                        onClick={() => select(mod.id)}
                                        class={`${menuTile} ${isActive() ? menuTileActive : menuTileIdle}`}
                                      >
                                        <Body />
                                      </button>
                                    }
                                  >
                                    <LockedRow
                                      mod={mod}
                                      placement="top"
                                      rowClass={`${menuTile} ${menuTileLocked}`}
                                      dwell={false}
                                      weddingId={props.weddingId}
                                      weddingSlug={props.weddingSlug}
                                      lockedExport={lockedExport(mod.id)}
                                      onUpgrade={() => {
                                        // The menu is a modal; leaving it open behind
                                        // the dialog would trap focus in the wrong
                                        // layer. Its tiles go with it, so focus comes
                                        // back to the bar's More tab.
                                        setSheetOpen(false);
                                        offerUpgrade(mod, sheetTrigger);
                                      }}
                                    >
                                      <Body />
                                    </LockedRow>
                                  </Show>
                                </li>
                              );
                            }}
                          </For>
                        </ul>
                      </nav>
                    </Dialog.Content>
                  </Dialog.Portal>
                </Dialog>
              </li>
            </ul>
          </nav>
        </Portal>
      </Show>

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
