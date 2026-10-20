import Button from "@cire/ui/button";
import {
  batch,
  createEffect,
  createSignal,
  createUniqueId,
  onCleanup,
  Show,
  splitProps,
} from "solid-js";

import { AnimatedModal } from "./AnimatedModal";
import { DetailsPanel } from "./DetailsPanel";
import { RsvpPanel, type RsvpPanelProps } from "./RsvpPanel";
import {
  beginsDrag,
  clampOffset,
  pastSlop,
  shouldCommit,
  startsInside,
  velocityOf,
  type SwipeSample,
} from "./sheet-swipe";
import type { EventSummary } from "./types";

/** The sheet's two panels: everything about the event, and the reply to it. */
export type EventPanel = "details" | "rsvp";

/** What the RSVP panel needs from the page, passed through unchanged. */
type RsvpData = Omit<
  RsvpPanelProps,
  "event" | "onClose" | "active" | "titleId" | "headingRef" | "onBusyChange"
>;

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

/**
 * The first item of a computed comma-separated list, such as
 * `animation-timing-function`. Split at top level only: a `cubic-bezier(…)`
 * carries commas of its own.
 */
export function firstOfCssList(value: string): string {
  let depth = 0;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "," && depth === 0) return value.slice(0, i).trim();
  }
  return value.trim();
}

/**
 * Seconds or milliseconds, as `getComputedStyle` writes an animation's
 * duration, in milliseconds. The first of a list; 0 for anything else.
 */
export function cssTimeMs(value: string): number {
  const first = firstOfCssList(value);
  const amount = Number.parseFloat(first);
  if (!Number.isFinite(amount)) return 0;
  return first.endsWith("ms") ? amount : amount * 1000;
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

/** A touch on the panels, from the moment it goes down. */
interface Touch {
  id: number;
  x0: number;
  y0: number;
  samples: SwipeSample[];
  /** Undecided inside the slop; then either the sheet's swipe, or not ours. */
  state: "pending" | "dragging" | "refused";
  /** The panels' offset, clamped (`clampOffset`). */
  dx: number;
  width: number;
}

/**
 * One dialog per event holding two panels side by side in the guest's mind:
 * the event's details on the start side, its RSVP form on the end side, in the
 * order of the event card's buttons. A badge in the sheet's chrome, beside the
 * close button, moves to the other panel without closing anything — "Give
 * RSVP →" on the details, "← See details" on the form, each arrow pointing the
 * way the guest can also swipe.
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
 * went it moves to the details heading. From the form whenever it is not busy:
 * not while a save is in flight, nor while the sheet closes itself on a saved
 * reply. One rule, {@link EventSheet}'s `leavable`, gates the badge and the
 * swipe alike.
 *
 * ## The switch
 *
 * Everything that matters happens at once, on the press: the panel swaps, the
 * scroll goes back to the top, and focus moves to the new panel's heading,
 * whose words say which panel it is. The motion runs after and changes
 * nothing a guest can act on:
 *
 * - The new panel slides the last 1.5rem in from its own side as it fades in
 *   (`animate-panel-from-*` in `global.css`). A CSS animation restarts each
 *   time its element goes from `display: none` to shown, so no script times
 *   it. The panel the sheet opens on gets no class until the first switch, or
 *   it would play on top of the sheet's own entry.
 * - The sheet's height eases from the old panel's to the new one's, in step,
 *   instead of jumping. That is the Web Animations API on the `<dialog>`, timed
 *   by reading the panel's computed animation back, so `global.css` is the one
 *   place the timing is written and the reduced-motion clamp reaches both.
 * - Until the slide settles the new panel takes no pointer input: it is still
 *   transparent, and a second tap of a double tap would otherwise land on
 *   whatever control sits under the button just pressed. The badge ignores
 *   such a tap too (`pressBadge`), since it sits in the same corner on both
 *   panels and would go straight back. And the panels' wrapper clips sideways overflow,
 *   because the sliding RSVP panel carries its full-bleed action bar past the
 *   scrollport's edge and would flash a horizontal scrollbar. Only then:
 *   clipped all the time, the wrapper would also hide a real overflow inside a
 *   panel.
 *
 * Under `prefers-reduced-motion` the global clamp cuts the slide to 0.01ms,
 * and the resize reads that same duration, so the switch is instant.
 *
 * ## The swipe
 *
 * A touch that moves sideways toward the other panel drags both: the one on
 * screen follows the finger, and the other is drawn beside it, a panel's width
 * away, level with the top of the scrollport. The decisions — when a touch is
 * a swipe, how far it may go, whether a release carries on or springs back —
 * are `sheet-swipe.ts`'s; this component only moves the boxes.
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
 * - The arriving panel is `inert` until it has arrived, and its entry slide
 *   is suppressed (`quiet`) for as long as it is on screen: it is already in
 *   place, and adding the animation class to a shown element would play it.
 *   That holds for the panel under the finger too, when it arrived by an
 *   earlier swipe and the guest is now swiping it away.
 * - Both panels are `will-change: transform` while they move, so the drag
 *   moves two composited layers rather than repainting the sheet each frame.
 * - Released, both panels ease to their resting places on
 *   `transition-panel-settle`, the slide's own duration and curve, read back
 *   from the computed style so the reduced-motion clamp reaches it. A
 *   committed swipe then switches exactly as the badge does, with the height
 *   easing after the panels land.
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
  const headings: Partial<Record<EventPanel, HTMLHeadingElement>> = {};
  const wrappers: Partial<Record<EventPanel, HTMLDivElement>> = {};
  let scroller: HTMLDivElement | undefined;
  let rail: HTMLDivElement | undefined;
  let resize: Animation | undefined;
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
  // — so focus goes to the details heading instead. It acts only on that loss:
  // focus resting on any real element is left where the guest put it.
  let wasReachable = rsvpReachable();
  createEffect(() => {
    const reachable = rsvpReachable();
    const withdrawn = wasReachable && !reachable;
    wasReachable = reachable;
    if (!withdrawn || active() !== "details") return;
    const focused = document.activeElement;
    if (!focused || focused === document.body) headings.details?.focus();
  });

  /** Lift the arriving panel's switch-time limits once its slide has ended. */
  async function settleEntry(token: number, slide: readonly Animation[]) {
    await Promise.allSettled(slide.map((a) => a.finished));
    if (token === switchToken) setEntering(null);
  }

  /**
   * Switch to `next`. `arrived` is a swipe's: the panel is already in place,
   * so it gets no slide of its own, and the resize takes the swipe's timing.
   */
  function show(next: EventPanel, arrived?: { duration: number; easing: string; from: number }) {
    if (next === active() || (!arrived && gesture())) return;
    const dialog = scroller?.parentElement ?? null;
    // Measured before anything moves, and before a resize still running from
    // a quick earlier switch is cancelled: this is the height on screen now.
    // A swipe measured it before its own style writes, so nothing forces a
    // layout to read it here.
    const from = arrived?.from ?? dialog?.offsetHeight ?? 0;
    resize?.cancel();
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
    headings[next]?.focus({ preventScroll: true });

    const panel = wrappers[next];
    if (!arrived) {
      // The panel's own slide only — not its subtree, where a loading spinner
      // can run for as long as an embed takes. Waited on before anything else
      // here can go wrong, so nothing can leave the panel unclickable.
      const slide = panel && typeof panel.getAnimations === "function" ? panel.getAnimations() : [];
      void settleEntry(token, slide);
    }

    if (!panel || !dialog || typeof dialog.animate !== "function") return;
    const style = getComputedStyle(panel);
    const duration = arrived?.duration ?? cssTimeMs(style.animationDuration);
    const easing = arrived?.easing ?? firstOfCssList(style.animationTimingFunction);
    const to = dialog.offsetHeight;
    if (duration > 0 && Math.abs(to - from) >= 1) {
      resize = dialog.animate([{ height: `${from}px` }, { height: `${to}px` }], {
        duration,
        easing: easing || "ease",
      });
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
  let settling = false;
  let settleTimer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  onCleanup(() => {
    disposed = true;
    clearTimeout(settleTimer);
  });

  /** Where the panel coming in sits, relative to the one on screen. */
  const incomingSide = (target: EventPanel) => (target === "rsvp" ? 1 : -1);

  /** Draw both panels for a finger at `dx`. */
  function paint(dx: number, width: number) {
    const target = gesture()?.target;
    const current = wrappers[active()];
    const incoming = target && wrappers[target];
    if (!target || !current || !incoming) return;
    current.style.transform = `translateX(${dx}px)`;
    incoming.style.transform = `translateX(${dx + incomingSide(target) * width}px)`;
  }

  function beginDrag(state: Touch) {
    const target = otherPanel(active());
    // Read before the batch shows the incoming panel, so it forces no layout.
    const top = scroller?.scrollTop ?? 0;
    batch(() => {
      setShown((panels) => new Set(panels).add(target));
      setQuiet((panels) => new Set(panels).add(target));
      setGesture({ target });
    });
    state.state = "dragging";
    const incoming = wrappers[target];
    // Level with the scrollport's top, wherever the panel on screen is
    // scrolled to: the wrapper's own top is the scroll content's.
    if (incoming) incoming.style.top = `${top}px`;
  }

  function onPointerDown(e: PointerEvent) {
    if (e.pointerType !== "touch" || touch || settling || entering() !== null || zoomed()) {
      return;
    }
    if (!(e.target instanceof Element) || !rail) return;
    if (startsInside(e.target, rail, (el) => getComputedStyle(el))) return;
    touch = {
      id: e.pointerId,
      x0: e.clientX,
      y0: e.clientY,
      samples: [{ x: e.clientX, t: e.timeStamp }],
      state: "pending",
      dx: 0,
      width: rail.clientWidth,
    };
  }

  function onPointerMove(e: PointerEvent) {
    const state = touch;
    if (!state || e.pointerId !== state.id || state.state === "refused") return;
    const dx = e.clientX - state.x0;
    const dy = e.clientY - state.y0;
    if (state.state === "pending") {
      if (!pastSlop(dx, dy)) return;
      if (!leavable() || !beginsDrag({ dx, dy, panel: active() })) {
        state.state = "refused";
        return;
      }
      beginDrag(state);
    }
    state.samples.push({ x: e.clientX, t: e.timeStamp });
    if (state.samples.length > 16) state.samples.shift();
    state.dx = clampOffset(dx, active(), state.width);
    paint(state.dx, state.width);
  }

  function onPointerEnd(e: PointerEvent) {
    const state = touch;
    if (!state || e.pointerId !== state.id) return;
    touch = null;
    if (state.state !== "dragging") return;
    // Where and when the finger lifted: a finger that rested before lifting
    // is no flick, however fast it moved before it stopped.
    state.samples.push({ x: e.clientX, t: e.timeStamp });
    const commit =
      e.type === "pointerup" &&
      shouldCommit({
        dx: state.dx,
        velocity: velocityOf(state.samples),
        width: state.width,
        panel: active(),
      });
    settle(commit, state.width);
  }

  /** Ease both panels to rest: on to the other panel, or back where they were. */
  function settle(commit: boolean, width: number) {
    const target = gesture()?.target;
    const current = wrappers[active()];
    const incoming = target && wrappers[target];
    if (!target || !current || !incoming) return;
    settling = true;

    const moving = [current, incoming];
    for (const el of moving) el.classList.add("transition-panel-settle");
    const style = getComputedStyle(incoming);
    const duration = cssTimeMs(style.transitionDuration);
    const easing = firstOfCssList(style.transitionTimingFunction);
    const side = incomingSide(target);
    current.style.transform = `translateX(${commit ? -side * width : 0}px)`;
    incoming.style.transform = `translateX(${commit ? 0 : side * width}px)`;

    const onEnd = (e: TransitionEvent) => {
      if (e.target === incoming && e.propertyName === "transform") finish();
    };
    function finish() {
      clearTimeout(settleTimer);
      incoming?.removeEventListener("transitionend", onEnd);
      if (disposed || !settling) return;
      settling = false;
      // Before the writes below, which would force a layout to read it after.
      const from = scroller?.parentElement?.offsetHeight ?? 0;
      for (const el of moving) {
        el.classList.remove("transition-panel-settle");
        el.style.transform = "";
        el.style.top = "";
      }
      if (commit) {
        show(target as EventPanel, { duration, easing, from });
      } else {
        batch(() => {
          setGesture(null);
          setQuiet((panels) => without(panels, target as EventPanel));
        });
      }
    }
    incoming.addEventListener("transitionend", onEnd);
    // A transition that has nowhere to go fires no `transitionend`.
    settleTimer = setTimeout(finish, duration + 50);
  }

  /**
   * A press of the badge. A tap or click (`detail > 0`) is ignored while a
   * slide or a swipe is still running: the badge sits in the same corner on
   * both panels, so the second tap of a double tap lands on its twin and
   * would go straight back. Not by taking its pointer input away — the tap
   * would fall through to the dialog's own box and close the sheet. A key
   * press is deliberate and goes through.
   */
  function pressBadge(e: MouseEvent, next: EventPanel) {
    if (e.detail > 0 && (entering() !== null || gesture() !== null)) return;
    show(next);
  }

  /** The badge: the way to the other panel, drawn in the sheet's chrome. */
  const badge = (
    <Show
      when={active() === "details"}
      fallback={
        <Button
          variant="chip"
          size="sm"
          class="min-h-11"
          onClick={(e) => pressBadge(e, "details")}
          disabled={busy()}
        >
          <span aria-hidden="true">←</span>
          See details
        </Button>
      }
    >
      <Show when={rsvpReachable()}>
        <Button variant="chip" size="sm" class="min-h-11" onClick={(e) => pressBadge(e, "rsvp")}>
          {rsvp.closed ? "View your RSVP" : "Give RSVP"}
          <span aria-hidden="true">→</span>
        </Button>
      </Show>
    </Show>
  );

  return (
    <AnimatedModal
      onClose={own.onClose}
      labelledBy={titleIds[active()]}
      themeVars={own.themeVars}
      // The RSVP form ends in a full-bleed sticky bar that owns the sheet's
      // bottom edge; the details end in ordinary content that needs the
      // sheet's own bottom padding.
      flushBottom={active() === "rsvp"}
      scrollRef={(el) => (scroller = el)}
      toolbar
      action={badge}
      holdOpen={entering() !== null || gesture() !== null}
    >
      {/* `-mx-6 px-6` puts this box's edge on the scrollport's own padding
          edge, so the clip lands exactly where the full-bleed bar ends — and
          the bar's `-mx-6` cancels this `px-6` as it did the scrollport's.
          The arriving panel of a swipe is laid against the same edge with
          `inset-x-6`. */}
      <div
        ref={(el) => (rail = el)}
        class="-mx-6 px-6"
        classList={{
          "touch-pan-y": !zoomed(),
          "touch-pinch-zoom": !zoomed(),
          "overflow-x-clip": entering() !== null || gesture() !== null,
          relative: gesture() !== null,
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
            hidden={active() !== "details" && gesture()?.target !== "details"}
            inert={gesture()?.target === "details"}
            classList={{
              "animate-panel-from-start": switched() && !quiet().has("details"),
              "pointer-events-none": entering() === "details",
              absolute: gesture()?.target === "details",
              "inset-x-6": gesture()?.target === "details",
              "will-change-transform": gesture() !== null,
            }}
          >
            <DetailsPanel
              event={own.event}
              siteUrl={own.siteUrl}
              rsvpClosed={rsvp.closed}
              rsvpClosedOn={rsvp.closedOn}
              titleId={titleIds.details}
              headingRef={(el) => (headings.details = el)}
            />
          </div>
        </Show>
        <Show when={shown().has("rsvp")}>
          <div
            ref={(el) => (wrappers.rsvp = el)}
            data-panel="rsvp"
            hidden={active() !== "rsvp" && gesture()?.target !== "rsvp"}
            inert={gesture()?.target === "rsvp"}
            classList={{
              "animate-panel-from-end": switched() && !quiet().has("rsvp"),
              "pointer-events-none": entering() === "rsvp",
              absolute: gesture()?.target === "rsvp",
              "inset-x-6": gesture()?.target === "rsvp",
              "will-change-transform": gesture() !== null,
            }}
          >
            <RsvpPanel
              {...rsvp}
              event={own.event}
              onClose={own.onClose}
              active={active() === "rsvp"}
              titleId={titleIds.rsvp}
              headingRef={(el) => (headings.rsvp = el)}
              onBusyChange={setBusy}
            />
          </div>
        </Show>
      </div>
    </AnimatedModal>
  );
}
