import { toast } from "@shared/toast";
import {
  batch,
  createEffect,
  createMemo,
  createSignal,
  createUniqueId,
  onCleanup,
  Show,
  For,
} from "solid-js";

import { AnimatedModal } from "./AnimatedModal";
import { hasHouseholdResponded } from "./rsvp-responded";
import { savedDwellMs } from "./rsvp-saved";
import type { EventSummary, FamilyMember, RsvpSummary } from "./types";

interface RsvpModalProps {
  event: EventSummary;
  members: ReadonlyArray<FamilyMember>;
  existingRsvps?: ReadonlyArray<RsvpSummary>;
  apiUrl: string;
  /**
   * Organiser host preview — the RSVP stays fully interactive (pick, type,
   * submit) but is a deliberate NO-OP: a valid submit never hits the API and
   * nothing is saved. Lets a host feel the guest flow without polluting their
   * own RSVP data. A banner makes the no-op explicit.
   */
  preview?: boolean;
  /**
   * The wedding's RSVP deadline has passed — the sheet becomes a read-only view
   * of whatever this household already answered: every control is disabled and
   * the submit button is gone, so there is nothing to send. The events section
   * disables "Respond" too, so this normally can't be opened; it exists because
   * the deadline can pass with the sheet ALREADY open, and because the server
   * would refuse the write anyway (403 `rsvp_closed`).
   */
  closed?: boolean;
  /** The deadline day in words, for the closed banner ("RSVPs closed on …"). */
  closedOn?: string;
  /**
   * "Details"-section tone map (`sectionVars(theme, "details")`) so the
   * RSVP sheet follows the events section it belongs to — see
   * AnimatedModal.themeVars.
   */
  themeVars?: Record<string, string>;
  onClose: () => void;
  onSubmitted?: (updated: RsvpSummary[]) => void;
  /**
   * Fired as this sheet closes itself after the save that CROSSES INTO a
   * complete response for this event — every invited member now has a reply on
   * file, and at least one of them did not before. That crossing is the thing
   * the Respond-button sweep exists to mark (see `rsvp-responded.ts`), so this
   * fires at most once per household per event, and it fires paired with
   * `onClose` precisely because the sweep is only watchable once this sheet is
   * out of the way.
   *
   * Two kinds of save deliberately do NOT fire it, and both still get the toast
   * and still close the sheet:
   *
   *  - a save that leaves the party still incomplete (the household may submit
   *    with only some members answered — see `handleSubmit`), since they have
   *    not finished responding to this event yet;
   *  - an EDIT to a reply that was already complete when the sheet opened,
   *    since nothing about completeness changed. Re-running the sweep there
   *    would animate a transition into a state the button is already in.
   *
   * The host preview is the one place this fires repeatedly, and correctly so:
   * preview writes no rows, so from its point of view every save is the first.
   *
   * Deliberately separate from `onSubmitted`, which fires only on the real
   * path, at submit time, and is what actually persists the reply. Preview's
   * celebration is real; preview's data write is not.
   *
   * A guest who dismisses the sheet early (Escape, the close chip, a backdrop
   * tap) cancels the dwell timer and so never gets the celebration — correctly:
   * they have already moved on. The permanent tick still appears, because it
   * is driven by the recorded data (`responded`), not by this cue.
   */
  onConfirmed?: () => void;
}

type Attending = "attending" | "declined" | null;

interface MemberState {
  attending: Attending;
  dietary: string;
  // Explicit Art. 9(2)(a) opt-in for the special-category dietary free-text.
  // Unticked by default; gates submit when `dietary` is non-empty. Prefilled
  // true when an existing RSVP already carries dietary text (consent was
  // captured at the prior submit). See cire-guest-data DPIA → C-H2.
  dietaryConsent: boolean;
}

export function RsvpModal(props: RsvpModalProps) {
  const eventMembers = createMemo(() =>
    props.members.filter((m) => m.eventIds.includes(props.event.id)),
  );

  /**
   * The household's rows as they stood when this sheet opened, captured ONCE.
   *
   * Both the per-member prefill (`initialResponses`) and the celebration gate
   * (`handleSubmit`'s `wasComplete`) read from this rather than from the live
   * prop, so the two are provably the same data. Reading the live prop at submit
   * time was safe only by way of three unrelated invariants — the confirmed
   * state being terminal, `AnimatedModal`'s focus trap keeping the cards behind
   * the backdrop unreachable, and the parent's `<Show when={rsvpEvent()}>` being
   * unkeyed so an event swap remounts rather than reuses this instance. A
   * snapshot is cheaper than that reasoning and cannot drift from the prefill.
   */
  const priorRsvps = props.existingRsvps ?? [];

  function initialResponses() {
    const map: Record<string, MemberState> = {};
    const prior = priorRsvps;
    for (const m of eventMembers()) {
      const existing = prior.find((r) => r.guestId === m.guestId && r.eventId === props.event.id);
      let attending: Attending = null;
      if (existing) {
        if (existing.status === "attending") attending = "attending";
        else if (existing.status === "declined") attending = "declined";
        // "maybe" → null (UX is binary now)
      }
      const dietary = existing?.dietary ?? "";
      map[m.guestId] = {
        attending,
        dietary,
        // Existing dietary text was only stored because consent was given, so
        // a prefilled value implies prior consent — keep the box ticked so an
        // unchanged response re-submits cleanly.
        dietaryConsent: dietary.length > 0,
      };
    }
    return map;
  }

  const [responses, setResponses] = createSignal<Record<string, MemberState>>(initialResponses());
  const [error, setError] = createSignal<string | null>(null);
  const [loading, setLoading] = createSignal(false);
  // Terminal success state: the reply is recorded, the Save button is filling
  // gold behind a drawn tick, and the sheet is counting down to closing itself.
  const [saved, setSaved] = createSignal(false);
  const titleId = createUniqueId();

  // Abort the in-flight submit if the modal unmounts mid-request — keeps the
  // setError / setLoading writes from landing on a disposed instance.
  let inFlight: AbortController | null = null;
  onCleanup(() => inFlight?.abort());

  // Same reasoning for the dwell timer: a guest who dismisses the confirmation
  // early (Escape, the close chip, a backdrop tap) unmounts this component, and
  // a surviving timer would then call `onClose` a second time on a disposed
  // instance.
  let dwellTimer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => {
    if (dwellTimer !== undefined) clearTimeout(dwellTimer);
  });

  /**
   * Enter the confirmed state and hand the sheet a deadline to close itself.
   *
   * The toast fires immediately, for EVERY successful save — partial, complete
   * or an edit to something already complete. It is the one confirmation a
   * guest gets regardless of how much of the party they just answered for, and
   * it says only that a response was captured.
   *
   * `celebrate` (the Respond-button sweep) is much narrower: see
   * `handleSubmit`, which grants it only for the save that CROSSES INTO a
   * complete response. The sweep marks that transition, so it plays once and
   * not again on later edits.
   *
   * Deliberately does NOT call `onSubmitted` — the host preview reaches this
   * too, and a preview must show the guest's confirmation without ever claiming
   * data was written. The real success path calls `onSubmitted` itself.
   *
   * `requestMs` is how long the guest has ALREADY been waiting — click to reply
   * — and is deducted from the dwell rather than added to it, so the sheet
   * closes a roughly fixed time after the click however slow the round-trip
   * was. `savedDwellMs` holds a floor under that so a slow reply still gets a
   * readable confirmed state. Preview passes 0: it never leaves the browser.
   */
  function enterSavedState(celebrate: boolean, requestMs: number) {
    setSaved(true);
    toast.success(`Your RSVP for ${props.event.name} has been recorded.`);
    dwellTimer = setTimeout(() => {
      dwellTimer = undefined;
      // Fired WITH the close, not at the top of the dwell. The celebration this
      // cues plays on the Respond button *behind* this sheet, so starting it
      // here — on the frame the sheet stops covering that button — is what
      // makes it visible. Cueing it at `setSaved` instead spends the sweep-in
      // and the tick draw under a sheet that is still up — the dwell is a
      // sizeable fraction of `TOTAL_DURATION_MS`, so the guest is uncovered
      // onto a celebration already most of the way through, which reads as
      // nothing having happened at all. Shortening the dwell reduces how much
      // of the celebration that mistake would burn; it does not make it safe.
      if (celebrate) props.onConfirmed?.();
      props.onClose();
    }, savedDwellMs(requestMs));
  }

  function setAttending(guestId: string, attending: Attending) {
    setResponses((prev) => ({
      ...prev,
      [guestId]: { ...prev[guestId]!, attending },
    }));
  }

  function setDietary(guestId: string, dietary: string) {
    setResponses((prev) => ({
      ...prev,
      [guestId]: { ...prev[guestId]!, dietary },
    }));
  }

  function setDietaryConsent(guestId: string, dietaryConsent: boolean) {
    setResponses((prev) => ({
      ...prev,
      [guestId]: { ...prev[guestId]!, dietaryConsent },
    }));
  }

  // Disable every control while a submit is in flight, once it has succeeded,
  // and once the RSVP deadline has passed — the three reasons a guest can't
  // change their answer. (After a success the sheet is already closing; letting
  // the fields stay live would invite edits that could never be sent.)
  const locked = () => loading() || saved() || (props.closed ?? false);

  // C-L2: the deadline can pass with this sheet open, and closing it unmounts
  // the submit button. If focus was ON that button, the browser drops focus to
  // `<body>` — outside an `aria-modal` dialog, with no keyboard way back in.
  //
  // The rescue detects the LOSS rather than trying to pre-empt it: this effect
  // runs after the DOM update, by which point a destroyed focus has already
  // reverted to `<body>`, so "activeElement is body/null" is precisely the
  // condition worth fixing. Focus resting on any real element means the guest
  // is somewhere deliberate and we leave them there. The closed banner is
  // `role="status"`, so the change itself is announced either way.
  let dismissRef: HTMLButtonElement | undefined;
  let wasClosed = props.closed ?? false;
  createEffect(() => {
    const nowClosed = props.closed ?? false;
    const justClosed = nowClosed && !wasClosed;
    wasClosed = nowClosed;
    if (!justClosed || !dismissRef) return;
    const active = document.activeElement;
    if (!active || active === document.body) dismissRef.focus();
  });

  async function handleSubmit(e: SubmitEvent) {
    e.preventDefault();
    setError(null);

    // The guest's clock starts HERE, not when the fetch is issued: everything
    // between is synchronous validation, and what the dwell budget is spending
    // is the wait a guest actually perceives after pressing Save. See
    // `savedDwellMs`.
    //
    // `performance.now()`, not `Date.now()`: this is a DURATION, and a
    // monotonic clock cannot step backwards mid-request the way wall-clock can
    // under an NTP correction. `savedDwellMs` clamps a negative anyway, but the
    // clamp should be insurance rather than the thing holding the invariant up.
    const submittedAt = performance.now();

    // The confirmed state is terminal — the sheet is already closing itself and
    // a second POST would rewrite the same rows. The Save button advertises
    // this with `aria-disabled` rather than `disabled`, precisely so it can
    // keep focus (disabling the focused control drops focus to `<body>`,
    // outside this `aria-modal` dialog — the C-L2 failure below), which leaves
    // the guard here as the thing that actually stops the resubmit.
    //
    // `loading()` is guarded here too (S-L1), even though the button carries a
    // real `disabled` in that state. The attribute only stops paths that route
    // through the button — a programmatic `form.requestSubmit()` or a dispatched
    // `submit` event reaches this handler regardless, and a second concurrent
    // POST would overwrite `inFlight`, orphaning the first request's
    // AbortController so unmount could no longer cancel it. Guarding both states
    // here makes this function the single authority on when a submit may run,
    // rather than splitting that between JS and browser behaviour.
    if (saved() || loading()) return;

    // Past the deadline there is no submit button to press; a form-level Enter
    // could still fire this, and the server would refuse it anyway.
    if (props.closed) return;

    // The household no longer has to finish the whole party in one sitting —
    // whichever members have an answer get sent, and anyone left at `null` is
    // simply left out of the batch (their existing reply, if any, is untouched
    // server-side). `current[m.guestId]?.attending` already reflects a PRIOR
    // reply too, since `initialResponses` prefills it — so `answered` counts
    // both a fresh answer this session and one already on file. At least one
    // member must be answered, or there is nothing worth sending.
    const current = responses();
    const visible = eventMembers();
    const answered = visible.filter((m) => current[m.guestId]?.attending !== null);
    if (answered.length === 0) {
      setError("Please respond for at least one person in your party.");
      return;
    }
    // Whether THIS save leaves every invited member answered.
    const nowComplete = answered.length === visible.length;
    // …and whether the party was ALREADY complete when this sheet opened.
    // Reuses `hasHouseholdResponded`, the same all-or-nothing rule that drives
    // the permanent mark on Respond, against `priorRsvps` — the snapshot the
    // prefill above was built from, so the gate and the form can never disagree
    // about what was already on file.
    const wasComplete = hasHouseholdResponded(props.event, props.members, priorRsvps);
    // The sweep marks the moment a whole response is captured, so it belongs to
    // the save that CROSSES that line — not to every save that happens to leave
    // the party complete. An edit to an already-complete reply captures nothing
    // new about completeness, so it gets the toast and nothing else.
    //
    // Host preview is unaffected: its family is the synthetic `kind: "host"`
    // one, which is barred from RSVP and so has no rows for `wasComplete` to be
    // true from — a host trying the flow still sees the full confirmation.
    const celebrate = nowComplete && !wasComplete;

    // Art. 9(2)(a) gate: dietary free-text is special-category data and may only
    // be sent with the guest's explicit opt-in. Block submit if anyone entered
    // dietary text but left the consent box unticked. (The server also enforces
    // this with a 422 — see cire-guest-data DPIA → C-H2.)
    const missingConsent = visible.some((m) => {
      const state = current[m.guestId]!;
      return (
        state.attending === "attending" && state.dietary.trim().length > 0 && !state.dietaryConsent
      );
    });
    if (missingConsent) {
      setError("Please tick the box to let us store your dietary requirements.");
      return;
    }

    // Host preview: the form validated like the real thing, but we stop here —
    // no network call, nothing persisted. It still plays the confirmation,
    // because the point of preview is to let a host feel exactly what a guest
    // feels; a preview that skipped straight to a closed sheet would hide the
    // one piece of feedback this change exists to add.
    if (props.preview) {
      enterSavedState(celebrate, 0);
      return;
    }

    setLoading(true);

    const body = {
      rsvps: answered.map((m) => {
        const state = current[m.guestId]!;
        const attending = state.attending === "attending";
        const dietary = attending ? state.dietary : "";
        return {
          guestId: m.guestId,
          eventId: props.event.id,
          status: state.attending!,
          dietary,
          dietaryConsent: dietary.trim().length > 0 && state.dietaryConsent,
        };
      }),
    };

    inFlight = new AbortController();
    try {
      const res = await fetch(`${props.apiUrl}/api/rsvp`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: inFlight.signal,
      });

      if (res.status === 200) {
        const data = (await res.json()) as { rsvps: RsvpSummary[] };
        // All three writes in one `batch` (P-I1). We are past an `await`, so
        // without it each is its own synchronous graph walk: `locked()` is a
        // plain accessor rather than a memo, so every `disabled={locked()}`
        // site subscribes individually — both toggles per member, the dietary
        // field, the consent box, Cancel, and the submit button's own
        // disabled/aria-disabled/classList. Unbatched, `setLoading(false)`
        // re-enables all of them and `setSaved(true)` immediately locks them
        // again: double the attribute writes, and a fully-unlocked
        // intermediate state, on the exact frame the button's label flips to
        // "Saved".
        //
        // Order inside the batch is load-bearing (S-L2): `enterSavedState`
        // registers the dwell timer BEFORE `onSubmitted` hands rows to the
        // parent. A parent that responded by unmounting this sheet would
        // otherwise run `onCleanup` first and leave the timer to be registered
        // afterwards — never cleared, firing `onClose` on a disposed instance
        // one dwell later. Registering first keeps the timer's lifetime strictly
        // inside the component's, whatever the parent does.
        //
        // `onClose` is not called here — `enterSavedState` holds the sheet open
        // for the confirmation and then closes it. The rows still reach the
        // page immediately, so the events section behind the confirmation is
        // already showing the new answer when the sheet lifts off it.
        batch(() => {
          setLoading(false);
          enterSavedState(celebrate, performance.now() - submittedAt);
          props.onSubmitted?.(data.rsvps);
        });
        return;
      }

      if (res.status === 401) {
        setError("Your session expired. Please re-enter your code.");
      } else if (res.status === 403) {
        // The deadline can pass while this sheet is open, so a 403 here is as
        // likely to be "too late" as "not your guest" — the body's code tells
        // us which, and the two need very different copy.
        const failure = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(
          failure?.error === "rsvp_closed"
            ? "RSVPs have closed for this wedding. Please contact the couple directly."
            : "You're not authorised to RSVP for one of those guests.",
        );
      } else if (res.status === 429) {
        setError("Too many requests. Please try again in a moment.");
      } else {
        setError("Something went wrong. Please try again.");
      }
      setLoading(false);
    } catch (err) {
      // Abort-on-unmount is silent; only surface real network failures.
      if ((err as { name?: string } | undefined)?.name === "AbortError") return;
      setError("Could not connect. Please check your connection.");
      setLoading(false);
    } finally {
      inFlight = null;
    }
  }

  return (
    <AnimatedModal
      onClose={props.onClose}
      labelledBy={titleId}
      themeVars={props.themeVars}
      // The action bar below is a full-bleed sticky footer that owns the
      // sheet's bottom edge (and its safe-area padding), so the panel must not
      // add its own bottom padding underneath it.
      flushBottom
    >
      <p class="font-body text-gold-ink mb-3 text-[0.72rem] tracking-[0.2em] uppercase">Respond</p>
      <h3
        id={titleId}
        class="font-display text-text text-[1.6rem] font-light italic"
        classList={{
          "mb-6": !props.preview && !props.closed,
          "mb-3": props.preview || props.closed,
        }}
      >
        {props.event.name}
      </h3>

      <Show when={props.closed}>
        <p
          class="border-border bg-surface-raised text-text-muted mb-6 rounded-sm border px-3.5 py-2.5 text-[0.74rem] leading-relaxed"
          role="status"
        >
          {props.closedOn ? `RSVPs closed on ${props.closedOn}.` : "RSVPs have closed."} This is
          your household&apos;s reply as it stands — please contact the couple directly if anything
          needs to change.
        </p>
      </Show>

      <Show when={props.preview}>
        <p
          class="border-gold/40 bg-gold/5 text-gold-ink mb-6 rounded-sm border px-3.5 py-2.5 text-[0.74rem] leading-relaxed"
          role="status"
        >
          Preview — try the RSVP as a guest would. Nothing you send here is saved.
        </p>
      </Show>

      <form class="flex flex-col gap-5" onSubmit={handleSubmit}>
        <For each={eventMembers()}>
          {(member) => {
            const guestId = member.guestId;
            return (
              // `pt-0`: a <legend> is laid out in the fieldset's top border and
              // the block-start padding is added BELOW it, so `p-5` stacked the
              // legend's own height + margin on top of 20px and left the card
              // top-heavy (58px above the buttons vs 21px below). Zero top
              // padding puts the first control ~25px under the border — level
              // with the 20px inset on the other three sides.
              <fieldset class="border-border m-0 rounded-sm border px-5 pt-0 pb-5">
                <legend class="font-display text-text mb-3 text-[1.1rem] font-normal italic">
                  {member.firstName} {member.lastName}
                </legend>

                <div class="flex gap-2">
                  <button
                    type="button"
                    class="font-body flex-1 cursor-pointer rounded-sm border px-3 py-2.5 text-[0.82rem] tracking-[0.06em] uppercase transition-colors duration-200"
                    classList={{
                      "border-gold text-gold-ink bg-gold/8":
                        responses()[guestId]?.attending === "attending",
                      "border-border text-text-muted hover:border-gold-dim hover:text-text":
                        responses()[guestId]?.attending !== "attending",
                    }}
                    aria-pressed={responses()[guestId]?.attending === "attending"}
                    onClick={() => setAttending(guestId, "attending")}
                    disabled={locked()}
                  >
                    Attending
                  </button>
                  <button
                    type="button"
                    class="font-body flex-1 cursor-pointer rounded-sm border px-3 py-2.5 text-[0.82rem] tracking-[0.06em] uppercase transition-colors duration-200"
                    classList={{
                      "border-gold text-gold-ink bg-gold/8":
                        responses()[guestId]?.attending === "declined",
                      "border-border text-text-muted hover:border-gold-dim hover:text-text":
                        responses()[guestId]?.attending !== "declined",
                    }}
                    aria-pressed={responses()[guestId]?.attending === "declined"}
                    onClick={() => setAttending(guestId, "declined")}
                    disabled={locked()}
                  >
                    Not attending
                  </button>
                </div>

                <Show when={responses()[guestId]?.attending === "attending"}>
                  <label class="font-body text-text-muted mt-3 block text-[0.78rem] tracking-[0.06em] uppercase">
                    Dietary requirements
                    <input
                      type="text"
                      // No `focus:outline-none` here: it sits in Tailwind's
                      // utilities layer and would beat the base-layer
                      // `:focus-visible` ring, leaving a border tint as the
                      // only focus cue on the invite's main data-entry field.
                      class="border-border font-body text-text placeholder:text-text-muted focus:border-gold mt-1.5 block w-full rounded-sm border bg-transparent px-3 py-2.5 text-base transition-colors duration-200 sm:text-[0.9rem]"
                      placeholder="e.g. Vegetarian, no nuts"
                      value={responses()[guestId]?.dietary ?? ""}
                      onInput={(e) => setDietary(guestId, e.currentTarget.value)}
                      maxLength={200}
                      disabled={locked()}
                    />
                  </label>

                  {/* Explicit, unticked-by-default consent — only shown once the
                      guest has actually entered dietary text (special-category
                      data). See cire-guest-data DPIA → C-H2. */}
                  <Show when={(responses()[guestId]?.dietary.trim().length ?? 0) > 0}>
                    <label class="font-body text-text-muted mt-3 flex items-start gap-2.5 text-[0.78rem] leading-relaxed normal-case">
                      <input
                        type="checkbox"
                        class="accent-gold mt-0.5 h-4 w-4 shrink-0 cursor-pointer"
                        checked={responses()[guestId]?.dietaryConsent ?? false}
                        onChange={(e) => setDietaryConsent(guestId, e.currentTarget.checked)}
                        disabled={locked()}
                      />
                      <span>
                        I agree to my dietary requirements above being stored and shared with the
                        caterers for this wedding. See our{" "}
                        <a
                          href="/privacy"
                          target="_blank"
                          rel="noopener noreferrer"
                          class="text-gold-ink underline underline-offset-2"
                        >
                          privacy notice
                        </a>
                        .
                      </span>
                    </label>
                  </Show>
                </Show>
              </fieldset>
            );
          }}
        </For>

        <Show when={error()}>
          <p class="font-body text-error py-1 text-[0.82rem]" role="alert">
            {error()}
          </p>
        </Show>

        {/* The confirmation, spoken. The visible cue is a label swap on a
            button a screen reader has no reason to re-read (and, once the
            sheet closes, a colour sweep and a tick on a DIFFERENT button
            behind it — see `EventCard`), so the success needs saying
            somewhere it will be announced.

            Rendered unconditionally with its text swapped, rather than wrapped
            in a `<Show>`: assistive tech announces a CHANGE inside a live
            region it was already watching, and a region that springs into
            existence alongside its content is frequently missed. */}
        <p class="sr-only" role="status">
          {saved() ? `Your RSVP for ${props.event.name} has been saved.` : ""}
        </p>

        {/* Sits flush on the sheet's bottom edge — the panel drops its own
            bottom padding (`flushBottom`) rather than this bar cancelling it
            with a negative margin: `bottom: 0` resolves against the scrollport,
            so a negative bottom margin lifts the bar up over the last card
            instead of stretching it down into the padding. */}
        <div class="border-border bg-surface sticky bottom-0 -mx-6 flex gap-3 border-t px-6 pt-4 pb-[max(1rem,env(safe-area-inset-bottom))] md:pb-4">
          <button
            type="button"
            class="border-border font-body text-text-muted hover:border-gold-dim hover:text-text flex-1 cursor-pointer rounded-sm border bg-transparent px-4 py-3 text-[0.82rem] tracking-[0.1em] uppercase transition-colors duration-200 disabled:opacity-40"
            ref={dismissRef}
            onClick={() => props.onClose()}
            // Nothing left to cancel once the reply is in and the sheet is
            // closing itself — and an early `onClose` here would race the
            // dwell timer for the same call.
            //
            // `&& !props.closed` is load-bearing, not defensive (T-M2). Past the
            // deadline this button relabels to "Close" and becomes the sheet's
            // ONLY control — and it is the target of the C-L2 focus rescue
            // above, which calls `.focus()` on it. `.focus()` is a no-op on a
            // disabled button. The deadline can flip INSIDE the dwell,
            // unmounting the focused submit button; without this clause the
            // rescue would fire into a disabled control and strand focus on
            // `<body>`, outside an `aria-modal` dialog with no keyboard way
            // back in. That is exactly the failure C-L2 exists to prevent, so
            // the confirmed state must not be able to reintroduce it.
            disabled={(loading() || saved()) && !props.closed}
          >
            {/* Past the deadline there is nothing to cancel — the sheet is a
                view, so its one button says so. */}
            {props.closed ? "Close" : "Cancel"}
          </button>
          {/* No submit button once RSVPs are closed: a disabled Save invites a
              guest to keep clicking at a door that won't open. */}
          <Show when={!props.closed}>
            {/* The animated confirmation — a fill sweep and a drawn tick —
                used to live on this button. It moved to the events section's
                Respond button (`onConfirmed` above, choreography in
                `rsvp-responded.ts`), which is still on screen once this sheet
                closes and this one is not. What stays here is the label swap
                and the lock, so the sheet still visibly holds its result for
                the dwell (`savedDwellMs`) rather than just vanishing. */}
            <button
              type="submit"
              class="border-gold font-body text-gold-ink hover:bg-gold hover:text-bg disabled:hover:text-gold-ink flex-1 rounded-sm border bg-transparent px-4 py-3 text-[0.82rem] tracking-[0.1em] uppercase transition-colors duration-200 disabled:cursor-not-allowed disabled:hover:bg-transparent"
              classList={{
                // The in-flight fade, spelled out rather than left to
                // `disabled:opacity-40`: the confirmed state also needs the
                // button non-submittable, and a variant keyed on `disabled`
                // would drag a 40% fade onto the one state that must look
                // most alive.
                "opacity-40": loading(),
                "cursor-pointer": !saved(),
                "cursor-default": saved(),
              }}
              disabled={loading()}
              // Not `disabled`: this button holds keyboard focus at the moment
              // the reply lands, and disabling a focused control drops focus to
              // `<body>` — outside an `aria-modal` dialog, with no keyboard way
              // back in (the same failure C-L2 documents below). `aria-disabled`
              // states the same thing without moving focus; `handleSubmit`
              // enforces it.
              aria-disabled={saved() || undefined}
            >
              {saved() ? "Saved" : loading() ? "Saving…" : "Save"}
            </button>
          </Show>
        </div>
      </form>
    </AnimatedModal>
  );
}
