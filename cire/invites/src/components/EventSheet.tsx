import Button from "@cire/ui/button";
import { animate } from "motion";
import {
  batch,
  createEffect,
  createSignal,
  createUniqueId,
  on,
  onCleanup,
  Show,
  splitProps,
} from "solid-js";

import { AnimatedModal } from "./AnimatedModal";
import { DetailsPanel } from "./DetailsPanel";
import { moveFocus, pressedByPointer } from "./quiet-focus";
import { RsvpPanel, type RsvpPanelProps } from "./RsvpPanel";
import {
  bandOffset,
  bandSlope,
  beginsBand,
  beginsDrag,
  clampOffset,
  pastSlop,
  SETTLE_SPRING,
  shouldCommit,
  startsInside,
  velocityOf,
  type SwipeSample,
} from "./sheet-swipe";
import type { EventSummary } from "./types";

/** The sheet's two panels: everything about the event, and the reply to it. */
export type EventPanel = "details" | "rsvp";

/** What the RSVP panel needs from the page, passed through unchanged. */
type RsvpData = Omit<RsvpPanelProps, "event" | "onClose" | "active" | "onBusyChange">;

export interface EventSheetProps extends RsvpData {
  event: EventSummary;
  /**
   * The panel the sheet opens on — the one whose button the guest pressed.
   * Read once: after that the guest moves between the panels, and the page
   * mounts a fresh sheet for every open, so nothing carries over between opens.
   */
  panel: EventPanel;
  /** Origin used to stamp the calendar invite's "Invite:" link. */
  siteUrl: string;
  /**
   * "Details"-section tone map (`sectionVars(theme, "details")`) so the sheet
   * follows the events section it belongs to — see AnimatedModal.themeVars.
   */
  themeVars?: Record<string, string>;
  /**
   * Any invited member of the household has a reply on file for this event.
   * Past the deadline it keeps the details' way into the read-only form, the
   * badge relabelled "View your RSVP"; with none, the form is out of reach.
   */
  replied?: boolean;
  onClose: () => void;
}

/** The panel a guest leaving `panel` arrives on. */
function otherPanel(panel: EventPanel): EventPanel {
  return panel === "details" ? "rsvp" : "details";
}

/** `panels` less `panel`, as a new set. */
function without(panels: ReadonlySet<EventPanel>, panel: EventPanel): ReadonlySet<EventPanel> {
  const next = new Set(panels);
  next.delete(panel);
  return next;
}

/**
 * The sheet's title in its bar: the event's name in the display face, whole.
 * It wraps onto as many lines as it needs rather than being cut short, and the
 * bar grows with it. It breaks between words, and inside a word only when the
 * word is longer than a whole line (`break-word`), hyphenated there where the
 * engine has the page's language (`hyphens-auto`, the invite's `lang="en"`).
 * A phone narrower than 380px takes it a type step down, where the badge
 * leaves the title least room: that is what keeps most names' words, and the
 * comma after one, on a line together. A word longer than a whole line still
 * breaks where the line ends, and with no hyphenation dictionary to hand
 * (Chromium on Linux has none) that can be just before its comma.
 */
const TITLE =
  "font-display text-text text-ui-md min-[380px]:text-ui-lg wrap-break-word hyphens-auto leading-tight font-light italic";

/**
 * One of the badge's two labels. Both sit in the same grid cell, so the badge
 * is as wide as the wider of them whichever shows, and a swipe that moves them
 * through it never changes its width. Each is the cell's full width, so the
 * two stay exactly one width apart wherever the swipe has them, and never
 * overlap.
 */
const BADGE_LABEL =
  "transition-badge-settle col-start-1 row-start-1 flex items-center justify-center gap-2";

/** A touch on the panels, from the moment it goes down. */
interface Touch {
  id: number;
  /** Where the finger would have gone down for the panels to sit at `dx`. */
  x0: number;
  y0: number;
  samples: SwipeSample[];
  /**
   * Undecided inside the slop; then the sheet's swipe, a pull toward the side
   * with no panel (`banding`), or not ours. `caught` is a touch that landed on
   * a settling swipe and stopped it, undecided until it leaves the slop.
   */
  state: "pending" | "dragging" | "banding" | "caught" | "refused";
  /** The panels' offset (`clampOffset`, or `bandOffset` while banding). */
  dx: number;
  width: number;
  /** A caught touch: where it went down, which the slop is measured from. */
  catchX?: number;
  catchY?: number;
  /** A caught touch that moved off sideways is no swipe; it only resumes. */
  held?: boolean;
  /** A caught touch: where the settle it stopped was going. */
  commit?: boolean;
}

/** What the swipe is doing, from a touch's slop to its settle. */
type SwipePhase = "idle" | "dragging" | "banding" | "caught" | "springing";

/** A settle in flight, and what to do when it lands. */
interface Settle {
  controls: ReturnType<typeof animate> | null;
  /** The panels' offset at its last frame. */
  x: number;
  to: number;
  /** A swipe's settle can be caught; a band's runs on. */
  kind: "swipe" | "band";
  /** A swipe's: whether it is carrying on to the other panel. */
  commit: boolean;
  /** Set when a catch takes it over: its completion must not run. */
  dropped: boolean;
  paint: (x: number) => void;
  done: () => void;
}

/**
 * One dialog per event holding two panels side by side in the guest's mind:
 * the event's details on the start side, its RSVP form on the end side, in the
 * order of the event card's buttons. The sheet's bar, which stays put while the
 * panel scrolls under it ({@link AnimatedModal}'s `toolbar`), holds the event's
 * name as the title, then a badge that moves to the other panel without
 * closing anything — "Give RSVP →" on the details, "← See details" on the
 * form, each arrow pointing the way the guest can also swipe — then the close
 * button. The badge's words follow a swipe's finger rather than changing when
 * the panels land. The panels carry no title of their own.
 *
 * ## One title per panel
 *
 * The bar holds two titles, the details' and the form's, and shows the one for
 * the panel on screen. Each reads as the event's name and says its panel's name
 * to assistive technology only — "Details, Mehndi", "Respond, Mehndi" ("Your
 * RSVP, Mehndi" past the deadline) — and the dialog takes its name from the one
 * shown. Two elements rather than one relabelled, because a switch moves focus
 * to the arriving panel's title: focus sent to the element already holding it
 * is no move, and nothing would be announced.
 *
 * ## A panel mounts the first time it is asked for and stays mounted
 *
 * The other one is `hidden`, never disposed. That is what keeps a half-given
 * reply across a look at the details: the form's state lives in the one
 * `RsvpPanel` instance the sheet ever builds. And it is what keeps the
 * details' consent-gated embeds — the map and the moodboard — from loading for
 * a guest who opened the form and never pressed or swiped toward the details.
 *
 * ## When the guest may move
 *
 * From the details whenever RSVPs are open, and past the deadline only for a
 * household with a reply on file (the badge reads "View your RSVP"); with
 * none there is no badge and no swipe, and if focus was on the badge as it
 * went it moves to the details' title. From the form whenever it is not busy:
 * not while a save is in flight, nor while the sheet closes itself on a saved
 * reply, when the badge is disabled. One rule, {@link EventSheet}'s
 * `leavable`, gates the badge and the swipe alike.
 *
 * ## One height
 *
 * The sheet keeps one height whichever panel shows and whatever it holds:
 * {@link AnimatedModal} sets it from the viewport alone, and a panel taller
 * than that scrolls inside it. So a switch never moves the
 * sheet's edge, in either direction, and nor does a form that grows as the
 * guest answers. Nothing is measured, which matters here: the details' height
 * cannot be known without mounting them, and mounting them would load the
 * consent-gated embeds for a guest who never asked.
 *
 * The RSVP panel's wrapper, and the panels' own wrapper around it, grow to
 * fill the scrollport, and the form's action bar sits at the foot of its
 * column, so the bar is on the sheet's bottom edge however short the form is.
 * The details wrapper does not grow: nothing in it sits at a foot. It carries
 * the sheet's bottom padding itself, so the scrollport has none for either
 * panel, and the action bar — a sticky box, which keeps inside its
 * scrollport's padding — reaches the edge even while a swipe draws the form
 * in beside the details.
 *
 * ## The badge
 *
 * One button, whose two labels — the details' and the form's — share one grid
 * cell, so it is always as wide as the wider. The one for the panel on screen
 * shows; the other waits outside the window the cell clips to, transparent
 * and `aria-hidden`, so the button's name is "Give RSVP", "See details" or
 * "View your RSVP" and never both. A press goes to the other panel. A custom
 * property on the button, `--badge-progress`, is 0 on the details and 1 on
 * the form, and the labels move on it like a ticker, the way the panels go:
 * toward the form the details' words leave by the start as the form's come in
 * from the end, a whole label's width apart, fading as they go. It has one
 * writer,
 * `setBadgeProgress`: as the badge is built, from the panel on screen, so a
 * sheet opened on the form does not fade its words in; on every switch, when
 * the words ease on the panels' 280ms (`transition-badge-settle`); and during a
 * swipe and its settle, which write the panels' share of their width on every
 * frame with the easing off (`data-dragging`), held between 0 and 1, and at
 * rest the value there. Inline `transform`s rather than Tailwind's
 * `translate-x-*`, which writes the separate `translate` property: one
 * transition list then covers the opacity and the slide.
 *
 * ## The switch
 *
 * Everything that matters happens at once, on the press: the panel swaps, the
 * scroll goes back to the top, and focus moves to the new panel's title in the
 * bar, whose words say which panel it is. After a tap, a click or a swipe that
 * move is quiet (`quiet-focus.ts`): nobody reached the title by keyboard, and a
 * ring on it would read as the title being selected. A key press keeps the
 * ring, so a keyboard user sees where focus went. The motion runs after and
 * changes nothing a guest can act on:
 *
 * - The new panel slides the last 1.5rem in from its own side as it fades in
 *   (`animate-panel-from-*` in `global.css`). A CSS animation restarts each
 *   time its element goes from `display: none` to shown, so no script times
 *   it. The panel the sheet opens on gets no class until the first switch, or
 *   it would play on top of the sheet's own entry.
 * - Until the slide settles the new panel takes no pointer input: it is still
 *   transparent, and a second tap of a double tap would otherwise land on
 *   whatever control sits under the badge just pressed. The badge ignores
 *   such a tap too (`pressBadge`), since it sits in the same place on both
 *   panels and would go straight back. And the panels' wrapper clips
 *   sideways overflow,
 *   because the sliding RSVP panel carries its full-bleed action bar past the
 *   scrollport's edge and would flash a horizontal scrollbar. Only then:
 *   clipped all the time, the wrapper would also hide a real overflow inside a
 *   panel.
 *
 * Under `prefers-reduced-motion` the global clamp cuts the slide to 0.01ms,
 * so the switch is instant.
 *
 * ## The swipe
 *
 * A touch that moves sideways toward the other panel drags both: the one on
 * screen follows the finger, and the other is drawn beside it, a panel's width
 * away, where it will rest under the bar. The decisions — when a touch is a
 * swipe, how far it may go, whether a release carries on or springs back — are
 * `sheet-swipe.ts`'s; this component only moves the boxes. The bar is no part
 * of either panel, so it never moves with them and a touch on it starts no
 * swipe.
 *
 * - Touch only. A mouse drag on a desktop is text selection.
 * - The wrapper is `touch-action: pan-y pinch-zoom`, so the browser keeps the
 *   vertical scroll and the zoom and leaves sideways movement to us; a touch
 *   it takes for a scroll arrives here as `pointercancel` and springs back.
 * - Not while the guest has pinch-zoomed in. A sideways drag then pans the
 *   zoomed view, which a guest who zoomed to read needs, so the wrapper goes
 *   back to `touch-action: auto` and the swipe stands down; the badge still
 *   moves between the panels.
 * - A touch in a text field, or in a box that scrolls sideways of its own
 *   (the dietary chips, the moodboard), belongs to that, not to the sheet.
 * - The arriving panel is held to the height it will have at rest, from where
 *   the panels start under the bar to the sheet's bottom edge, so the form's
 *   action bar is drawn where it will rest rather than under a short form,
 *   which would drop to the edge as the form landed.
 * - The arriving panel is `inert` until it has arrived, and its entry slide
 *   is suppressed (`quiet`) for as long as it is on screen: it is already in
 *   place, and adding the animation class to a shown element would play it.
 *   That holds for the panel under the finger too, when it arrived by an
 *   earlier swipe and the guest is now swiping it away.
 * - Both panels are `will-change: transform` while they move, so the drag
 *   moves two composited layers rather than repainting the sheet each frame.
 * - The badge's words move with the panels, by the share of their width they
 *   have covered (see "The badge").
 * - Past either end — back past where the drag started, or beyond the other
 *   panel's rest — the panels follow the finger on a rubber band
 *   (`rubberBand`): they give less the further it goes, as content dragged
 *   past its end does on iOS, rather than stopping dead.
 * - A sideways pull toward the side with no panel is a band of its own: the
 *   panel on screen gives a little under the finger and springs back. It
 *   draws nothing in — the other panel is never mounted for it, so a pull
 *   loads no map or board the guest swiped away from.
 * - Released, both panels spring to their resting places (`SETTLE_SPRING`,
 *   through `motion`), starting at the speed the finger had, so a flick
 *   carries on rather than braking and a slow release does not jump. A
 *   spring is script, which no stylesheet clamp reaches: under reduced motion
 *   the panels land at once. A committed swipe then switches exactly as the
 *   badge does, less the slide.
 * - A touch on a settling swipe catches it: the panels stop under the finger,
 *   which drags on from there. A catch that turns out to be a tap, a held
 *   finger or a vertical scroll lets the settle go on to where it was going.
 *   The click such a tap fires is swallowed — it would land on whatever the
 *   moving panel had under the finger — matched by time, not by pointer, as
 *   Safari's `click` carries none. A band's settle, or a swipe's inside its
 *   rubber band, is not caught: there the panels and the finger are not one to
 *   one.
 */
export function EventSheet(props: EventSheetProps) {
  const [own, rsvp] = splitProps(props, [
    "event",
    "panel",
    "siteUrl",
    "themeVars",
    "replied",
    "onClose",
  ]);

  const [active, setActive] = createSignal<EventPanel>(own.panel);
  const [shown, setShown] = createSignal<ReadonlySet<EventPanel>>(new Set([own.panel]));
  // False until the guest first switches; see "The switch" above.
  const [switched, setSwitched] = createSignal(false);
  // The panel whose slide is still running, if any.
  const [entering, setEntering] = createSignal<EventPanel | null>(null);
  // The form is saving, or closing on a saved reply.
  const [busy, setBusy] = createSignal(false);
  // The panel a swipe is drawing in, from the drag's start to its settle.
  const [gesture, setGesture] = createSignal<{ target: EventPanel } | null>(null);
  // The panels whose entry slide is suppressed: each arrived by a swipe, or is
  // arriving, and is still on screen. One leaves the set in the same update
  // that hides it.
  const [quiet, setQuiet] = createSignal<ReadonlySet<EventPanel>>(new Set());
  // The guest has pinch-zoomed in; see "The swipe".
  const [zoomed, setZoomed] = createSignal(false);

  const titleIds = {
    details: createUniqueId(),
    rsvp: createUniqueId(),
  } satisfies Record<EventPanel, string>;
  // Filled by the titles' refs as the sheet renders. Both titles are always
  // mounted, whichever panels are, so both are set before anything reads them.
  const titles = {} as Record<EventPanel, HTMLHeadingElement>;
  const wrappers: Partial<Record<EventPanel, HTMLDivElement>> = {};
  let scroller: HTMLDivElement | undefined;
  let rail: HTMLDivElement | undefined;
  let badgeEl: HTMLButtonElement | undefined;
  // Which switch is current, so a slide that settles after a later switch
  // cannot clear that later one's state.
  let switchToken = 0;

  /** The details lead to the form while RSVPs are open, or to a reply on file. */
  const rsvpReachable = () => rsvp.closed !== true || own.replied === true;
  /** Whether the guest may move off the panel on screen; see the component doc. */
  const leavable = () => (active() === "details" ? rsvpReachable() : !busy());

  // The deadline can pass while the details are open, and for a household with
  // no reply the badge goes with it. (One with a reply keeps it under a new
  // label, so its focus never moves.) If focus was ON the badge, the browser
  // drops it to `<body>` — outside a modal dialog, with no keyboard way back in
  // — so focus goes to the details' title instead. It acts only on that loss:
  // focus resting on any real element is left where the guest put it.
  let wasReachable = rsvpReachable();
  createEffect(() => {
    const reachable = rsvpReachable();
    const withdrawn = wasReachable && !reachable;
    wasReachable = reachable;
    if (!withdrawn || active() !== "details") return;
    const focused = document.activeElement;
    if (!focused || focused === document.body) titles.details.focus();
  });

  /** Lift the arriving panel's switch-time limits once its slide has ended. */
  async function settleEntry(token: number, slide: readonly Animation[]) {
    await Promise.allSettled(slide.map((a) => a.finished));
    if (token === switchToken) setEntering(null);
  }

  /**
   * Switch to `next`. `arrived` is a swipe's: the panel is already in place,
   * so it gets no slide of its own. `quietly` is a touch's or a click's: the
   * title takes focus without the keyboard's ring (`quiet-focus.ts`). A swipe
   * is always a touch.
   */
  function show(next: EventPanel, arrived = false, quietly = arrived) {
    if (next === active() || (!arrived && (gesture() || moving()))) return;
    const token = ++switchToken;
    const leaving = active();

    batch(() => {
      setShown((panels) => new Set(panels).add(next));
      setSwitched(true);
      setGesture(null);
      setQuiet((panels) => without(panels, leaving));
      if (!arrived) setEntering(next);
      setActive(next);
    });

    if (scroller) scroller.scrollTop = 0;
    moveFocus(titles[next], quietly, { preventScroll: true });

    if (!arrived) {
      // The panel's own slide only — not its subtree, where a loading spinner
      // can run for as long as an embed takes, so a slow embed cannot leave
      // the panel unclickable.
      const panel = wrappers[next];
      const slide = panel && typeof panel.getAnimations === "function" ? panel.getAnimations() : [];
      void settleEntry(token, slide);
    }
  }

  // ── The swipe ───────────────────────────────────────────────────────────

  // A pinch-zoom shows on the visual viewport as a scale above 1.
  const viewport = typeof window === "undefined" ? undefined : window.visualViewport;
  if (viewport) {
    const readZoom = () => setZoomed(viewport.scale > 1);
    readZoom();
    viewport.addEventListener("resize", readZoom);
    onCleanup(() => viewport.removeEventListener("resize", readZoom));
  }

  let touch: Touch | null = null;
  const [phase, setPhase] = createSignal<SwipePhase>("idle");
  /** A finger or a settle is moving the panels, or a caught touch holds them. */
  const moving = () => phase() !== "idle";
  let settle: Settle | null = null;
  let disposed = false;

  // The click a catching tap would fire: it lands on whatever the moving panel
  // had under the finger, which the guest never aimed at. Armed by the catch,
  // spent by the next click, and lapsing 300ms after the touch ends — after a
  // drag no click comes. Matched by time, never by pointer: Safari sends
  // `click` as a plain `MouseEvent`, with no `pointerId`.
  let swallowArmed = false;
  let swallowToken = 0;
  let swallowTimer: ReturnType<typeof setTimeout> | undefined;
  function armSwallow() {
    swallowToken++;
    clearTimeout(swallowTimer);
    swallowArmed = true;
  }
  function lapseSwallow() {
    const token = swallowToken;
    clearTimeout(swallowTimer);
    swallowTimer = setTimeout(() => {
      if (token === swallowToken) swallowArmed = false;
    }, 300);
  }
  function swallowClick(e: MouseEvent) {
    if (!swallowArmed) return;
    swallowArmed = false;
    clearTimeout(swallowTimer);
    // Default too: a radio or a label still toggles, and a link still follows,
    // when only the handlers are stopped.
    e.preventDefault();
    e.stopImmediatePropagation();
  }

  onCleanup(() => {
    disposed = true;
    if (settle) {
      settle.dropped = true;
      settle.controls?.stop();
    }
    clearTimeout(swallowTimer);
    rail?.removeEventListener("click", swallowClick, true);
  });

  const reducedMotion = () =>
    typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

  /** Where the panel coming in sits, relative to the one on screen. */
  const incomingSide = (target: EventPanel) => (target === "rsvp" ? 1 : -1);

  /** The badge's `--badge-progress` at rest on `panel`: 0 on the details, 1 on the form. */
  const restOf = (panel: EventPanel) => (panel === "details" ? 0 : 1);

  /**
   * The one writer of the badge's `--badge-progress` (see "The badge").
   * `dragging` holds its words to the finger with no easing; otherwise they
   * ease there on the panels' settle timing.
   */
  function setBadgeProgress(progress: number, dragging: boolean) {
    if (!badgeEl) return;
    badgeEl.toggleAttribute("data-dragging", dragging);
    badgeEl.style.setProperty("--badge-progress", String(progress));
  }

  // On every switch, by the badge or by a swipe. A committed swipe's settle has
  // already written the same value, so its words do not move twice.
  createEffect(
    on(active, (panel) => setBadgeProgress(restOf(panel), false), {
      defer: true,
    }),
  );

  /**
   * A painter for the swipe in progress: both panels, and the badge's words,
   * for the panels at `dx`. Its elements are taken now, so a settle that
   * outlives a change of `active()` keeps drawing the panels it started with.
   */
  function painter(width: number): ((dx: number) => void) | null {
    const from = active();
    const target = gesture()?.target;
    const current = wrappers[from];
    const incoming = target && wrappers[target];
    if (!target || !current || !incoming) return null;
    const side = incomingSide(target);
    return (dx) => {
      current.style.transform = `translateX(${dx}px)`;
      incoming.style.transform = `translateX(${dx + side * width}px)`;
      // Toward the form is toward the start (`dx < 0`), and the badge's 1.
      // Held inside its two rests: a pull past either end moves the panels,
      // not the words.
      setBadgeProgress(Math.min(1, Math.max(0, restOf(from) - dx / width)), true);
    };
  }

  /**
   * Spring the panels from `from` to `to`, starting at `velocity` px/ms, then
   * run `done`. A critically damped spring can still pass its target when it
   * starts fast enough toward it; once it has crossed, it is held there, so no
   * empty rail shows beyond the panel's rest. Under reduced motion it lands at
   * once — no stylesheet clamp reaches a scripted spring.
   */
  function spring(
    kind: Settle["kind"],
    commit: boolean,
    from: number,
    to: number,
    velocity: number,
    paint: (x: number) => void,
    done: () => void,
  ) {
    const run: Settle = { controls: null, x: from, to, kind, commit, dropped: false, paint, done };
    settle = run;
    setPhase("springing");
    rail?.setAttribute("data-settling", "");
    const land = () => {
      if (run.dropped || disposed) return;
      settle = null;
      rail?.removeAttribute("data-settling");
      // Idle before `done`, so the commit's own `show` is not refused.
      setPhase("idle");
      done();
    };
    if (reducedMotion() || from === to) {
      paint(to);
      land();
      return;
    }
    const toward = Math.sign(to - from);
    let crossed = false;
    run.controls = animate(from, to, {
      type: "spring",
      ...SETTLE_SPRING,
      // motion takes units per second; the finger is measured per ms.
      velocity: velocity * 1000,
      onUpdate: (value: number) => {
        if (run.dropped) return;
        if (!crossed && Math.sign(to - value) === -toward) crossed = true;
        run.x = crossed ? to : value;
        paint(run.x);
      },
      onComplete: land,
    });
  }

  /** Whether the panels at `dx` sit between their two rests on `panel`. */
  const inTravel = (dx: number, panel: EventPanel, width: number) =>
    clampOffset(dx, panel, width) === dx;

  /**
   * Stop a settling swipe where it is and hand it to the finger. Only a
   * swipe's settle, and only between its two rests: inside a rubber band the
   * finger and the panels are not one-to-one. Returns the offset it stopped
   * at and where it was going, or null when there is nothing to catch.
   */
  function catchSettle(width: number): { x: number; commit: boolean } | null {
    const run = settle;
    if (!run || run.kind !== "swipe" || !inTravel(run.x, active(), width)) return null;
    // `stop()` ticks to now, which can paint once more and can finish the
    // spring: the frame is taken, the completion is not.
    run.controls?.stop();
    run.dropped = true;
    settle = null;
    rail?.removeAttribute("data-settling");
    setPhase("caught");
    return { x: run.x, commit: run.commit };
  }

  /** Spring the swipe from `dx` back to rest on its own panel, or on to the other. */
  function settleSwipe(commit: boolean, dx: number, velocity: number, width: number) {
    const target = gesture()?.target;
    const paint = painter(width);
    if (!target || !paint) return;
    const current = wrappers[active()];
    const incoming = wrappers[target];
    const to = commit ? -incomingSide(target) * width : 0;
    // Released inside a rubber band, the panels were moving at the band's
    // share of the finger's speed.
    const travel = dx * -incomingSide(target);
    const over = travel < 0 ? travel : travel > width ? travel - width : 0;
    const speed = over === 0 ? velocity : velocity * bandSlope(over, width);
    spring("swipe", commit, dx, to, speed, paint, () => {
      for (const el of [current, incoming]) {
        if (!el) continue;
        el.style.transform = "";
        el.style.top = "";
        el.style.minHeight = "";
      }
      if (commit && !rail?.closest("[data-closing]")) {
        show(target, true);
      } else {
        batch(() => {
          setGesture(null);
          setQuiet((panels) => without(panels, target));
        });
      }
      setBadgeProgress(restOf(active()), false);
    });
  }

  function beginDrag(state: Touch) {
    const target = otherPanel(active());
    // Read before the batch shows the incoming panel, so they force no layout.
    // The rail starts under the bar, its own height and gap above it in the
    // scroll content, so the panel at rest runs from there to the sheet's
    // bottom edge. `offsetTop` is layout, unmoved by the scroll.
    const top = scroller?.scrollTop ?? 0;
    const tall = scroller && rail ? scroller.clientHeight - rail.offsetTop : 0;
    batch(() => {
      setShown((panels) => new Set(panels).add(target));
      setQuiet((panels) => new Set(panels).add(target));
      setGesture({ target });
    });
    // A long press before the drag may have begun a selection; dragged along,
    // it would sweep highlighted text across the sheet. The rail is
    // `select-none` from here to the settle, and not before the slop, so a
    // still long press can still select the address to copy it.
    window.getSelection()?.removeAllRanges();
    state.state = "dragging";
    setPhase("dragging");
    const incoming = wrappers[target];
    if (!incoming) return;
    // Where it will rest, under the bar, wherever the panel on screen is
    // scrolled to: the wrapper's own top is the rail's, in the scroll content.
    // And down to the scrollport's bottom edge, so the form's action bar is
    // drawn where it will rest (see "The swipe").
    incoming.style.top = `${top}px`;
    incoming.style.minHeight = `${tall}px`;
  }

  function onPointerDown(e: PointerEvent) {
    if (e.pointerType !== "touch" || touch || entering() !== null || zoomed()) return;
    if (!(e.target instanceof Element) || !rail) return;
    const width = rail.clientWidth;
    if (settle) {
      // A band's settle runs on; a swipe's, between its rests, is caught.
      const caught = catchSettle(width);
      if (caught === null) return;
      // No compatibility `mousedown`, so nothing under the finger takes focus.
      e.preventDefault();
      armSwallow();
      touch = {
        id: e.pointerId,
        x0: e.clientX - caught.x,
        y0: e.clientY,
        samples: [{ x: e.clientX, t: e.timeStamp }],
        state: "caught",
        dx: caught.x,
        width,
        catchX: e.clientX,
        catchY: e.clientY,
        commit: caught.commit,
      };
      return;
    }
    if (startsInside(e.target, rail, (el) => getComputedStyle(el))) return;
    touch = {
      id: e.pointerId,
      x0: e.clientX,
      y0: e.clientY,
      samples: [{ x: e.clientX, t: e.timeStamp }],
      state: "pending",
      dx: 0,
      width,
    };
  }

  function onPointerMove(e: PointerEvent) {
    const state = touch;
    if (!state || e.pointerId !== state.id || state.state === "refused") return;
    const dx = e.clientX - state.x0;
    const dy = e.clientY - state.y0;
    if (state.state === "caught") {
      // The slop runs from where this finger went down, not from where the
      // panels' offset puts it: a jitter is still a tap.
      const sx = e.clientX - (state.catchX ?? e.clientX);
      const sy = e.clientY - (state.catchY ?? e.clientY);
      if (state.held || !pastSlop(sx, sy)) return;
      if (Math.abs(sx) <= Math.abs(sy)) {
        state.held = true;
        return;
      }
      state.state = "dragging";
      setPhase("dragging");
      state.samples = [{ x: e.clientX, t: e.timeStamp }];
    }
    if (state.state === "pending") {
      if (!pastSlop(dx, dy)) return;
      if (beginsBand({ dx, dy, panel: active() })) {
        window.getSelection()?.removeAllRanges();
        state.state = "banding";
        setPhase("banding");
      } else if (leavable() && beginsDrag({ dx, dy, panel: active() })) {
        beginDrag(state);
      } else {
        state.state = "refused";
        return;
      }
    }
    state.samples.push({ x: e.clientX, t: e.timeStamp });
    if (state.samples.length > 16) state.samples.shift();
    if (state.state === "banding") {
      state.dx = bandOffset(dx, active(), state.width);
      const panel = wrappers[active()];
      if (panel) panel.style.transform = `translateX(${state.dx}px)`;
      return;
    }
    state.dx = clampOffset(dx, active(), state.width);
    painter(state.width)?.(state.dx);
  }

  function onPointerEnd(e: PointerEvent) {
    const state = touch;
    if (!state || e.pointerId !== state.id) return;
    touch = null;
    if (state.state === "caught") {
      // Not a swipe after all — a tap, a held finger, or a scroll the browser
      // took: the settle goes on to where it was going, from here.
      lapseSwallow();
      resumeCaught(state);
      return;
    }
    if (state.state === "banding") {
      const panel = wrappers[active()];
      const raw = e.clientX - state.x0;
      // Where the band has run back to 0 the panel is still; it has no speed
      // to carry.
      const speed =
        state.dx === 0 ? 0 : velocityOf([...state.samples, { x: e.clientX, t: e.timeStamp }]);
      spring(
        "band",
        false,
        state.dx,
        0,
        speed * bandSlope(raw, state.width),
        (x) => {
          if (panel) panel.style.transform = `translateX(${x}px)`;
        },
        () => {
          if (panel) panel.style.transform = "";
        },
      );
      return;
    }
    if (state.state !== "dragging") return;
    // Where and when the finger lifted: a finger that rested before lifting
    // is no flick, however fast it moved before it stopped.
    state.samples.push({ x: e.clientX, t: e.timeStamp });
    const velocity = velocityOf(state.samples);
    const commit =
      e.type === "pointerup" &&
      shouldCommit({ dx: state.dx, velocity, width: state.width, panel: active() });
    settleSwipe(commit, state.dx, e.type === "pointerup" ? velocity : 0, state.width);
  }

  /** A caught swipe that never became a drag: on to its target, from rest. */
  function resumeCaught(state: Touch) {
    settleSwipe(state.commit === true, state.dx, 0, state.width);
  }

  /**
   * A press of the badge, which goes to the other panel. A tap or click is
   * ignored while a slide or a swipe is still running: the badge sits in the
   * same place on both panels, so the second tap of a double tap lands on it
   * again and would go straight back. A key press is deliberate and goes
   * through, and leaves the title's ring on.
   */
  function pressBadge(e: MouseEvent) {
    const byPointer = pressedByPointer(e);
    if (byPointer && (entering() !== null || gesture() !== null || moving())) return;
    show(otherPanel(active()), false, byPointer);
  }

  /**
   * Keeps the rail, and listens on it, in the capture phase, for the click a
   * catching tap would fire (`swallowClick`). A named function for the same
   * reason as `holdBadge`.
   */
  function holdRail(el: HTMLDivElement) {
    rail = el;
    el.addEventListener("click", swallowClick, true);
  }

  /**
   * Keeps the badge, and writes its words' place before the first paint. A
   * named function rather than an arrow in the JSX: Solid drops a component's
   * `ref` that is any other kind of expression, and the mutation run's
   * instrumenter wraps every arrow in one.
   */
  function holdBadge(el: HTMLButtonElement) {
    badgeEl = el;
    setBadgeProgress(restOf(active()), false);
  }

  /**
   * The badge, in the sheet's bar: on the details only while the form can be
   * reached, on the form always. Disabled while the form is busy, which it can
   * only be while it is the panel on screen: the form cannot be left then.
   */
  const badge = (
    <Show when={active() === "rsvp" || rsvpReachable()}>
      <Button
        ref={holdBadge}
        variant="chip"
        size="sm"
        class="min-h-11"
        disabled={busy()}
        onClick={pressBadge}
      >
        {/* The window the labels move through: clipped, so a label on its way
            in or out shows only the part inside the badge's padding, which
            the button keeps around it with its pill and hairline. */}
        <span class="grid overflow-clip">
          <span
            class={BADGE_LABEL}
            aria-hidden={active() !== "details" || undefined}
            style={{
              opacity: "calc(1 - var(--badge-progress))",
              transform: "translateX(calc(var(--badge-progress) * -100%))",
            }}
          >
            {rsvp.closed ? "View your RSVP" : "Give RSVP"}
            <span aria-hidden="true">→</span>
          </span>
          <span
            class={BADGE_LABEL}
            aria-hidden={active() !== "rsvp" || undefined}
            style={{
              opacity: "var(--badge-progress)",
              transform: "translateX(calc((1 - var(--badge-progress)) * 100%))",
            }}
          >
            <span aria-hidden="true">←</span>
            See details
          </span>
        </span>
      </Button>
    </Show>
  );

  /**
   * The bar's two titles, one per panel, the inactive one hidden. Each is
   * focusable by script only (`tabindex="-1"`), the place a switch sends
   * focus, and names the dialog while its panel shows. The panel's name is
   * for the ear; the eye has the badge. The comma is inside the hidden words,
   * so no engine reads a space before it; the space after it is a text node
   * of its own, because a name is built from each element's trimmed text, and
   * on screen it is collapsed away at the start of the line.
   */
  const sheetTitles = (
    <>
      <h2
        id={titleIds.details}
        ref={(el) => (titles.details = el)}
        tabindex="-1"
        hidden={active() !== "details"}
        class={TITLE}
      >
        <span class="sr-only">Details,</span> {own.event.name}
      </h2>
      <h2
        id={titleIds.rsvp}
        ref={(el) => (titles.rsvp = el)}
        tabindex="-1"
        hidden={active() !== "rsvp"}
        class={TITLE}
      >
        <span class="sr-only">{rsvp.closed ? "Your RSVP," : "Respond,"}</span> {own.event.name}
      </h2>
    </>
  );

  return (
    <AnimatedModal
      onClose={own.onClose}
      labelledBy={titleIds[active()]}
      themeVars={own.themeVars}
      // The RSVP form ends in a full-bleed sticky bar that owns the sheet's
      // bottom edge. A sticky box keeps inside its scrollport's padding, so
      // the scrollport has none at the bottom, whichever panel shows: were it
      // the details', the form a swipe draws in beside them would hold its bar
      // above the edge and drop it there on landing. The details carry the
      // same padding on their own wrapper instead.
      flushBottom
      scrollRef={(el) => (scroller = el)}
      toolbar
      title={sheetTitles}
      action={badge}
    >
      {/* `-mx-6 px-6` puts this box's edge on the scrollport's own padding
          edge, so the clip lands exactly where the full-bleed bar ends — and
          the bar's `-mx-6` cancels this `px-6` as it did the scrollport's.
          The arriving panel of a swipe is laid against the same edge with
          `inset-x-6`. A column that grows to fill the scrollport, so the RSVP
          panel can too; see "One height". */}
      <div
        ref={holdRail}
        class="-mx-6 flex grow flex-col px-6"
        classList={{
          "touch-pan-y": !zoomed(),
          "touch-pinch-zoom": !zoomed(),
          "overflow-x-clip": entering() !== null || gesture() !== null || moving(),
          relative: gesture() !== null || moving(),
          "select-none": gesture() !== null || moving(),
        }}
        // Bound on the element rather than delegated: Solid delegates pointer
        // events to `document`, where every pointer move on the page would
        // run its dispatcher for a gesture that only happens here.
        on:pointerdown={onPointerDown}
        on:pointermove={onPointerMove}
        on:pointerup={onPointerEnd}
        on:pointercancel={onPointerEnd}
      >
        <Show when={shown().has("details")}>
          <div
            ref={(el) => (wrappers.details = el)}
            data-panel="details"
            // The sheet's own bottom padding, which the scrollport gives up
            // for the form's bar (`flushBottom` above).
            class="pb-[max(2.5rem,env(safe-area-inset-bottom))] md:pb-10"
            hidden={active() !== "details" && gesture()?.target !== "details"}
            inert={gesture()?.target === "details"}
            classList={{
              "animate-panel-from-start": switched() && !quiet().has("details"),
              "pointer-events-none": entering() === "details",
              absolute: gesture()?.target === "details",
              "inset-x-6": gesture()?.target === "details",
              "will-change-transform": gesture() !== null || moving(),
            }}
          >
            <DetailsPanel
              event={own.event}
              siteUrl={own.siteUrl}
              members={rsvp.members}
              replied={own.replied}
              rsvpClosed={rsvp.closed}
              rsvpClosedOn={rsvp.closedOn}
            />
          </div>
        </Show>
        <Show when={shown().has("rsvp")}>
          <div
            ref={(el) => (wrappers.rsvp = el)}
            data-panel="rsvp"
            class="flex grow flex-col"
            hidden={active() !== "rsvp" && gesture()?.target !== "rsvp"}
            inert={gesture()?.target === "rsvp"}
            classList={{
              "animate-panel-from-end": switched() && !quiet().has("rsvp"),
              "pointer-events-none": entering() === "rsvp",
              absolute: gesture()?.target === "rsvp",
              "inset-x-6": gesture()?.target === "rsvp",
              "will-change-transform": gesture() !== null || moving(),
            }}
          >
            <RsvpPanel
              {...rsvp}
              event={own.event}
              onClose={own.onClose}
              active={active() === "rsvp"}
              onBusyChange={setBusy}
            />
          </div>
        </Show>
      </div>
    </AnimatedModal>
  );
}
