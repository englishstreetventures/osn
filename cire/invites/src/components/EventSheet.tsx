import { batch, createSignal, createUniqueId, Show, splitProps } from "solid-js";

import { AnimatedModal } from "./AnimatedModal";
import { DetailsPanel } from "./DetailsPanel";
import { RsvpPanel, type RsvpPanelProps } from "./RsvpPanel";
import type { EventSummary } from "./types";

/** The sheet's two panels: everything about the event, and the reply to it. */
export type EventPanel = "details" | "rsvp";

/** What the RSVP panel needs from the page, passed through unchanged. */
type RsvpData = Omit<
  RsvpPanelProps,
  "event" | "onClose" | "active" | "titleId" | "headingRef" | "onShowDetails"
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

/**
 * One dialog per event holding two panels side by side in the guest's mind:
 * the event's details and its RSVP form. A button on each moves to the other
 * without closing anything.
 *
 * ## A panel mounts the first time it shows and stays mounted
 *
 * The other one is `hidden`, never disposed. That is what keeps a half-given
 * reply across a look at the details: the form's state lives in the one
 * `RsvpPanel` instance the sheet ever builds. And it is what keeps the
 * details' consent-gated embeds — the map and the moodboard — from loading for
 * a guest who opened the form and never asked for the details.
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
 *   whatever control sits under the button just pressed. And the panels'
 *   wrapper clips sideways overflow, because the sliding RSVP panel carries its
 *   full-bleed action bar past the scrollport's edge and would flash a
 *   horizontal scrollbar. Only then: clipped all the time, the wrapper would
 *   also hide a real overflow inside a panel.
 *
 * Under `prefers-reduced-motion` the global clamp cuts the slide to 0.01ms,
 * and the resize reads that same duration, so the switch is instant.
 */
export function EventSheet(props: EventSheetProps) {
  const [own, rsvp] = splitProps(props, ["event", "panel", "siteUrl", "themeVars", "onClose"]);

  const [active, setActive] = createSignal<EventPanel>(own.panel);
  const [shown, setShown] = createSignal<ReadonlySet<EventPanel>>(new Set([own.panel]));
  // False until the guest first switches; see "The switch" above.
  const [switched, setSwitched] = createSignal(false);
  // The panel whose slide is still running, if any.
  const [entering, setEntering] = createSignal<EventPanel | null>(null);

  const titleIds = {
    details: createUniqueId(),
    rsvp: createUniqueId(),
  } satisfies Record<EventPanel, string>;
  const headings: Partial<Record<EventPanel, HTMLHeadingElement>> = {};
  const wrappers: Partial<Record<EventPanel, HTMLDivElement>> = {};
  let scroller: HTMLDivElement | undefined;
  let resize: Animation | undefined;
  // Which switch is current, so a slide that settles after a later switch
  // cannot clear that later one's state.
  let switchToken = 0;

  /** Lift the arriving panel's switch-time limits once its slide has ended. */
  async function settleEntry(token: number, slide: readonly Animation[]) {
    await Promise.allSettled(slide.map((a) => a.finished));
    if (token === switchToken) setEntering(null);
  }

  function show(next: EventPanel) {
    if (next === active()) return;
    const dialog = scroller?.parentElement ?? null;
    // Measured before anything moves, and before a resize still running from
    // a quick earlier switch is cancelled: this is the height on screen now.
    const from = dialog?.offsetHeight ?? 0;
    resize?.cancel();
    const token = ++switchToken;

    batch(() => {
      setShown((panels) => new Set(panels).add(next));
      setSwitched(true);
      setEntering(next);
      setActive(next);
    });

    if (scroller) scroller.scrollTop = 0;
    headings[next]?.focus({ preventScroll: true });

    const panel = wrappers[next];
    // The panel's own slide only — not its subtree, where a loading spinner
    // can run for as long as an embed takes. Waited on before anything else
    // here can go wrong, so nothing can leave the panel unclickable.
    const slide = panel && typeof panel.getAnimations === "function" ? panel.getAnimations() : [];
    void settleEntry(token, slide);

    if (!panel || !dialog || typeof dialog.animate !== "function") return;
    const style = getComputedStyle(panel);
    const duration = cssTimeMs(style.animationDuration);
    const to = dialog.offsetHeight;
    if (duration > 0 && Math.abs(to - from) >= 1) {
      resize = dialog.animate([{ height: `${from}px` }, { height: `${to}px` }], {
        duration,
        easing: firstOfCssList(style.animationTimingFunction) || "ease",
      });
    }
  }

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
    >
      {/* `-mx-6 px-6` puts this box's edge on the scrollport's own padding
          edge, so the clip lands exactly where the full-bleed bar ends — and
          the bar's `-mx-6` cancels this `px-6` as it did the scrollport's. */}
      <div class="-mx-6 px-6" classList={{ "overflow-x-clip": entering() !== null }}>
        <Show when={shown().has("details")}>
          <div
            ref={(el) => (wrappers.details = el)}
            data-panel="details"
            hidden={active() !== "details"}
            classList={{
              "animate-panel-from-start": switched(),
              "pointer-events-none": entering() === "details",
            }}
          >
            <DetailsPanel
              event={own.event}
              siteUrl={own.siteUrl}
              onRsvp={() => show("rsvp")}
              rsvpClosed={rsvp.closed}
              rsvpClosedOn={rsvp.closedOn}
              active={active() === "details"}
              titleId={titleIds.details}
              headingRef={(el) => (headings.details = el)}
            />
          </div>
        </Show>
        <Show when={shown().has("rsvp")}>
          <div
            ref={(el) => (wrappers.rsvp = el)}
            data-panel="rsvp"
            hidden={active() !== "rsvp"}
            classList={{
              "animate-panel-from-end": switched(),
              "pointer-events-none": entering() === "rsvp",
            }}
          >
            <RsvpPanel
              {...rsvp}
              event={own.event}
              onClose={own.onClose}
              active={active() === "rsvp"}
              titleId={titleIds.rsvp}
              headingRef={(el) => (headings.rsvp = el)}
              onShowDetails={() => show("details")}
            />
          </div>
        </Show>
      </div>
    </AnimatedModal>
  );
}
