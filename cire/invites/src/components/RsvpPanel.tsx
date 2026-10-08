import { PLUS_ONE_DIETARY_ATTESTATION } from "@cire/dietary";
import Button from "@cire/ui/button";
import DietaryPresets from "@cire/ui/dietary-presets";
import Reveal from "@cire/ui/reveal";
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
  type Accessor,
} from "solid-js";

import { isPlusOne } from "./plus-one";
import { hasHouseholdResponded } from "./rsvp-responded";
import { savedDwellMs } from "./rsvp-saved";
import type { EventSummary, FamilyMember, RsvpSummary } from "./types";
import { formatNames, isValidRsvpSaveResponse } from "./utils";

export interface RsvpPanelProps {
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
   * disables "Respond" and the details panel offers no way here once it has
   * passed, so this normally can't be opened; it exists because the deadline
   * can pass with the sheet ALREADY open, and because the server would refuse
   * the write anyway (403 `rsvp_closed`).
   */
  closed?: boolean;
  /** The deadline day in words, for the closed banner ("RSVPs closed on …"). */
  closedOn?: string;
  /** Closes the whole sheet: Cancel, and the end of the saved dwell. */
  onClose: () => void;
  /**
   * Whether this panel is the one on screen. Default true. `EventSheet` keeps a
   * panel mounted, hidden, after the guest moves to the other one; a hidden
   * panel must not take focus for itself (see the deadline focus rescue).
   */
  active?: boolean;
  /** `id` for the heading, which names the sheet while this panel shows. */
  titleId?: string;
  /** Receives the heading, which takes focus when the guest switches here. */
  headingRef?: (el: HTMLHeadingElement) => void;
  /**
   * Moves the sheet to the event's details. Absent ⇒ no "View event details"
   * button (a panel rendered on its own).
   */
  onShowDetails?: () => void;
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
  /**
   * The household has the member step on and has not said who is answering
   * ("Who are you?" in the welcome panel). Save stays disabled, with a line
   * pointing there; the server refuses the write the same way (409).
   */
  memberRequired?: boolean;
  /**
   * The server refused the save with 409 `member_required`: the page shows
   * the member step. Only reached when the payload's flag read and the
   * write's disagreed.
   */
  onMemberRequired?: () => void;
}

type Attending = "attending" | "declined" | null;

/** What the sheet says while nobody has said who is answering. */
const MEMBER_REQUIRED_COPY = "Choose who you are under the welcome above, then reply.";

/** Who sent this member's stored reply to this event, for "Answered by". */
function answeredBy(
  rsvps: ReadonlyArray<RsvpSummary>,
  guestId: string,
  eventId: string,
): string | null {
  const row = rsvps.find((r) => r.guestId === guestId && r.eventId === eventId);
  return row?.submittedBy?.firstName ?? null;
}

/** The machine-readable `error` code of a refusal, if its body has one. */
async function failureCode(res: Response): Promise<string | undefined> {
  const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
  return typeof body?.error === "string" ? body.error : undefined;
}

/**
 * One consent checkbox: its state, and the rule for when it may open ticked.
 *
 * The sheet has two — the household's own consent for its members, and its
 * attestation that its plus-ones agreed — and each is built from this, over
 * its own people, so neither can ever be seeded from the other's records.
 *
 * **May it open ticked?** Only if EVERY person it covers already has a stored,
 * current record for this box. A box is one per submission rather than one per
 * guest — a household of four should not tick four boxes saying the same thing
 * — and that collapse is exactly where a prefill can go wrong: if Ana consented
 * last month and Ravi is answering for the first time, a box ticked on Ana's
 * behalf would stamp Ravi's first-ever Art. 9(2)(a) record from a control
 * nobody touched for him. One person's record never carries another's, so
 * anyone new makes the box open empty and blocks submit until a human ticks it.
 *
 * **ONE signal, and the box's only source.** Emphatically not
 * `given() || alreadyCovers()`. Under that form a pre-ticked box could not be
 * unticked: `given` is already `false`, so writing `false` is a no-op, Solid's
 * equality check suppresses the notification, the `checked` binding never
 * re-runs, and the DOM keeps the browser's own unticked state while the
 * derived value stays `true`. The guest sees an unticked box and the request
 * carries consent — a record stamped against an affirmation that was actively
 * withdrawn (Art. 7(3)).
 *
 * **Seed and re-ask** as the covered set changes: the effect ticks the box
 * when everyone it covers is already covered, and un-ticks it the moment that
 * stops being true — someone newly offering dietary data, or a record that
 * predates a wording change. It reacts only to that verdict changing, so it
 * never fights a guest who has just made a choice about the same set.
 */
function createConsentBox(
  covered: Accessor<readonly FamilyMember[]>,
  hadConsent: (guestId: string) => boolean,
) {
  const alreadyCovers = createMemo(() => {
    const people = covered();
    return people.length > 0 && people.every((m) => hadConsent(m.guestId));
  });
  const [checked, setChecked] = createSignal(false);
  let lastCovered: boolean | null = null;
  createEffect(() => {
    const now = alreadyCovers();
    if (now === lastCovered) return;
    lastCovered = now;
    setChecked(now);
  });
  return { checked, setChecked };
}

interface MemberState {
  attending: Attending;
  /** What this member typed under "Other". Everything nameable is a preset. */
  dietary: string;
  /** May hold a key this build does not know; see `RsvpSummary`. */
  dietaryPresets: readonly string[];
  /**
   * Whether this member's dietary data is already covered by a stored, current
   * Art. 9(2)(a) record for their box — the household's own consent for a
   * member, its attestation for a plus-one (the server decides which, and
   * whether it is current).
   *
   * Not a control — each box is one per submission, in the footer. This is
   * what decides whether a box may open ticked: see `createConsentBox`.
   */
  hadConsent: boolean;
}

/**
 * The RSVP form for one event: a fieldset per invited member, the dietary
 * consent boxes, and a sticky Cancel / Save bar. One of `EventSheet`'s two
 * panels; the sheet supplies the dialog, its theme and its close.
 */
export function RsvpPanel(props: RsvpPanelProps) {
  const eventMembers = createMemo(() =>
    props.members.filter((m) => m.eventIds.includes(props.event.id)),
  );

  /**
   * The household's rows as they stood when this panel mounted, captured ONCE.
   *
   * The panel mounts the first time its sheet shows it — as the sheet opens, or
   * at the guest's first move over from the details — and stays mounted until
   * the sheet closes, so this is one snapshot per visit to the sheet.
   *
   * Both the per-member prefill (`initialResponses`) and the celebration gate
   * (`handleSubmit`'s `wasComplete`) read from this rather than from the live
   * prop, so the two are provably the same data. Reading the live prop at
   * submit time would rest on unrelated guarantees — the confirmed state being
   * terminal, the modal sheet keeping the cards behind it unreachable, and the
   * page mounting a fresh sheet for every open. A snapshot is cheaper than that
   * reasoning and cannot drift from the prefill.
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
      map[m.guestId] = {
        attending,
        dietary: existing?.dietary ?? "",
        dietaryPresets: existing?.dietaryPresets ?? [],
        // The server's own verdict, not an inference from the text. A row can
        // carry presets and no text at all, so "they typed something, therefore
        // they consented" stopped being a safe proxy — and a record against
        // superseded consent wording is not consent to the wording on screen.
        hadConsent: existing?.dietaryConsentCurrent === true,
      };
    }
    return map;
  }

  const [responses, setResponses] = createSignal<Record<string, MemberState>>(initialResponses());
  /**
   * Which attending members are offering dietary data on this submission.
   *
   * One predicate behind the consent boxes' visibility, their wording, the
   * submit gate and what goes on the wire, so those can never disagree about
   * whose data is being authorised.
   */
  const membersWithDietaryData = createMemo(() =>
    eventMembers().filter((m) => {
      const state = responses()[m.guestId];
      if (!state || state.attending !== "attending") return false;
      return state.dietary.trim().length > 0 || state.dietaryPresets.length > 0;
    }),
  );

  /** The household's own members among them: covered by its own consent. */
  const ownWithDietaryData = createMemo(() =>
    membersWithDietaryData().filter((m) => !isPlusOne(m)),
  );

  /**
   * The plus-ones among them: covered by the household's attestation that
   * they agreed. A plus-one never holds the code or sees the invite, so the
   * household cannot give their consent — only confirm it — and the wording
   * and its version say so (`PLUS_ONE_DIETARY_ATTESTATION` in `@cire/dietary`).
   */
  const plusOnesWithDietaryData = createMemo(() =>
    membersWithDietaryData().filter((m) => isPlusOne(m)),
  );

  const hadConsent = (guestId: string) => responses()[guestId]?.hadConsent === true;
  const consent = createConsentBox(ownWithDietaryData, hadConsent);
  const attestation = createConsentBox(plusOnesWithDietaryData, hadConsent);

  /** "Bo's guest", for a plus-one's fieldset; null for everyone else. */
  const guestOf = (member: FamilyMember): string | null => {
    if (!isPlusOne(member)) return null;
    const inviter = props.members.find((m) => m.guestId === member.plusOneOf);
    return inviter ? `${inviter.firstName}'s guest` : "Guest";
  };

  const [error, setError] = createSignal<string | null>(null);
  const [loading, setLoading] = createSignal(false);
  // Terminal success state: the reply is recorded, the Save button is filling
  // gold behind a drawn tick, and the sheet is counting down to closing itself.
  const [saved, setSaved] = createSignal(false);
  const titleId = props.titleId ?? createUniqueId();

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

  function setDietaryPresets(guestId: string, dietaryPresets: readonly string[]) {
    setResponses((prev) => ({
      ...prev,
      [guestId]: { ...prev[guestId]!, dietaryPresets },
    }));
  }

  // Disable every control while a submit is in flight, once it has succeeded,
  // and once the RSVP deadline has passed — the three reasons a guest can't
  // change their answer. (After a success the sheet is already closing; letting
  // the fields stay live would invite edits that could never be sent.)
  const locked = () => loading() || saved() || (props.closed ?? false);
  // Save waits for "Who are you?"; preview never writes, so never waits.
  const blockedByMember = () => props.memberRequired === true && props.preview !== true;

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
  //
  // Only while this panel is the one on screen. Hidden behind the details
  // panel, it holds no focus to lose, and a rescue here would pull focus into
  // a panel the guest cannot see.
  let dismissRef: HTMLButtonElement | undefined;
  let wasClosed = props.closed ?? false;
  createEffect(() => {
    const nowClosed = props.closed ?? false;
    const justClosed = nowClosed && !wasClosed;
    wasClosed = nowClosed;
    if (!justClosed || !dismissRef || props.active === false) return;
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
    // Nobody has said who is answering; the line above Save says where to.
    if (blockedByMember()) return;

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
    // Counted over the household's own members, as `hasHouseholdResponded`
    // counts: the tick does not wait for a plus-one's reply, so neither does
    // the celebration of crossing into it.
    const own = visible.filter((m) => !isPlusOne(m));
    const nowComplete = own.length > 0 && own.every((m) => current[m.guestId]?.attending !== null);
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

    // Art. 9(2)(a) gate: dietary data is special-category — presets as much as
    // free text, since `halal` and `nuts` name a belief and a health condition
    // outright — and may only be sent with explicit consent. (The server also
    // enforces this with a 422 — see
    // `wiki/compliance/dpia/cire-guest-data.md`.)
    if (ownWithDietaryData().length > 0 && !consent.checked()) {
      setError("Please tick the box to let us store your dietary requirements.");
      return;
    }
    if (plusOnesWithDietaryData().length > 0 && !attestation.checked()) {
      const names = formatNames(plusOnesWithDietaryData().map((m) => m.firstName));
      setError(`Please confirm that ${names} agreed to their dietary requirements being stored.`);
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
        // A member who switched to "not attending" sends no dietary data at all,
        // and so nothing to consent to — the server clears their stored record.
        const dietary = attending ? state.dietary : "";
        const dietaryPresets = attending ? state.dietaryPresets : [];
        const hasDietaryData = dietary.trim().length > 0 || dietaryPresets.length > 0;
        const guestId = m.guestId;
        const eventId = props.event.id;
        const status = state.attending!;
        if (!isPlusOne(m)) {
          const dietaryConsent = hasDietaryData && consent.checked();
          return { guestId, eventId, status, dietary, dietaryPresets, dietaryConsent };
        }
        // A plus-one's reply carries the household's attestation: the box,
        // the version of the words beside it, and the name it was shown for.
        // The API stamps that version or refuses it, and refuses a name the
        // plus-one no longer has, so a page opened before a rename cannot
        // attest for the person named since.
        const dietaryConsent = hasDietaryData && attestation.checked();
        const dietaryAttestation = dietaryConsent ? PLUS_ONE_DIETARY_ATTESTATION.version : "";
        const dietaryAttestedName = dietaryConsent ? `${m.firstName} ${m.lastName}`.trim() : "";
        return {
          guestId,
          eventId,
          status,
          dietary,
          dietaryPresets,
          dietaryConsent,
          dietaryAttestation,
          dietaryAttestedName,
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
        // A 200 means the write happened, so the sheet confirms it whatever the
        // body holds. Rows the guard cannot vouch for stay out of the page,
        // which keeps the answers it already has until the next claim.
        const data: unknown = await res.json().catch(() => null);
        const rows = isValidRsvpSaveResponse(data) ? data.rsvps : null;
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
          if (rows) props.onSubmitted?.(rows);
        });
        return;
      }

      if (res.status === 401) {
        setError("Your session expired. Please re-enter your code.");
      } else if (res.status === 403) {
        // The deadline can pass while this sheet is open, so a 403 here is as
        // likely to be "too late" as "not your guest" — the body's code tells
        // us which, and the two need very different copy.
        setError(
          (await failureCode(res)) === "rsvp_closed"
            ? "RSVPs have closed for this wedding. Please contact the couple directly."
            : "You're not authorised to RSVP for one of those guests.",
        );
      } else if (res.status === 409) {
        const code = await failureCode(res);
        if (code === "member_required") {
          setError(MEMBER_REQUIRED_COPY);
          props.onMemberRequired?.();
        } else if (code === "plus_one_changed") {
          setError("Your guest's name has changed since this page opened. Please reload the page.");
        } else {
          setError("Something went wrong. Please try again.");
        }
      } else if (
        res.status === 422 &&
        (await failureCode(res)) === "plus_one_dietary_unavailable"
      ) {
        // The API did not take the attestation this sheet showed: an API older
        // than this page, or newer wording than it carries. A reload brings
        // the page level with the API.
        setError(
          "Your guest's dietary requirements couldn't be saved. Please reload the page and try again.",
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

  // The action bar at the foot of the form is a full-bleed sticky footer that
  // owns the sheet's bottom edge (and its safe-area padding), so the sheet
  // drops its own bottom padding while this panel shows (`EventSheet`'s
  // `flushBottom`).
  return (
    <>
      <header
        classList={{
          "mb-6": !props.preview && !props.closed,
          "mb-3": props.preview || props.closed,
        }}
      >
        {/* The eyebrow is part of the heading, not a paragraph above it. The
            sheet moves focus here when the guest switches panels, and both
            panels' titles are the event's name — so "Respond" is what tells a
            screen-reader user which panel they have arrived on. The comma is
            for the ear only. */}
        <h3
          id={titleId}
          ref={(el) => props.headingRef?.(el)}
          tabindex="-1"
          class="font-display text-text text-ui-xl font-light italic"
        >
          <span class="font-body text-gold-ink text-ui-xs tracking-ui-widest mb-3 block leading-normal [font-weight:var(--invite-body-weight,400)] uppercase [font-style:var(--invite-body-style,normal)]">
            Respond
            <span class="sr-only">,</span>
          </span>{" "}
          {props.event.name}
        </h3>
        <Show when={props.onShowDetails}>
          {(showDetails) => (
            // Not while a save is in flight or the sheet is already closing
            // itself on a saved reply: there is nothing to come back to.
            <Button
              variant="touchLink"
              class="mt-1 min-h-11"
              onClick={() => showDetails()()}
              disabled={loading() || saved()}
            >
              <span aria-hidden="true">←</span>
              View event details
            </Button>
          )}
        </Show>
      </header>

      <Show when={props.closed}>
        <p
          class="border-border bg-surface-raised text-text-muted text-ui-xs mb-6 rounded-sm border px-3.5 py-2.5 leading-relaxed"
          role="status"
        >
          {props.closedOn ? `RSVPs closed on ${props.closedOn}.` : "RSVPs have closed."} This is
          your household&apos;s reply as it stands — please contact the couple directly if anything
          needs to change.
        </p>
      </Show>

      <Show when={props.preview}>
        <p
          class="border-gold/40 bg-gold/5 text-gold-ink text-ui-xs mb-6 rounded-sm border px-3.5 py-2.5 leading-relaxed"
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
              // `min-w-0` overrides a `<fieldset>`'s default `min-width: min-content`,
              // which would otherwise let its content set the sheet's width — the
              // dietary picker's scrolling track can only overflow inside a box
              // that is allowed to be narrower than what it holds.
              <fieldset class="border-border m-0 min-w-0 rounded-sm border px-5 pt-0 pb-5">
                <legend class="font-display text-text text-ui-md mb-3 font-normal italic">
                  {member.firstName} {member.lastName}
                  <Show when={answeredBy(priorRsvps, guestId, props.event.id)}>
                    {(name) => (
                      <>
                        {" "}
                        <span class="font-body text-text-muted text-ui-xs block not-italic">
                          Answered by {name()}
                        </span>
                      </>
                    )}
                  </Show>
                  <Show when={guestOf(member)}>
                    {(label) => (
                      <>
                        {" "}
                        <span class="font-body text-text-muted text-ui-xs block not-italic">
                          {label()}
                        </span>
                      </>
                    )}
                  </Show>
                </legend>

                <div class="flex gap-2">
                  <button
                    type="button"
                    class="font-body text-ui-sm tracking-ui-wide flex-1 cursor-pointer rounded-sm border px-3 py-2.5 uppercase transition-colors duration-200"
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
                    class="font-body text-ui-sm tracking-ui-wide flex-1 cursor-pointer rounded-sm border px-3 py-2.5 uppercase transition-colors duration-200"
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
                  <div class="mt-3">
                    <DietaryPresets
                      value={responses()[guestId]?.dietaryPresets ?? []}
                      onChange={(next) => setDietaryPresets(guestId, next)}
                      disabled={locked()}
                      label={`Dietary requirements for ${member.firstName}`}
                    />
                  </div>

                  {/* The free-text box lives here rather than inside the picker,
                      so it stays visible while the desktop popover is closed and
                      a guest can see what they typed without reopening anything.
                      Shown for a selected `other` OR for text already on file:
                      a reply written before the picker existed carries prose and
                      no presets, and that is how it opens intact.

                      `Reveal` rather than a bare `<Show>`: ticking "Other" adds
                      a field to a sheet the guest is already reading, and a box
                      that appears between two frames shoves everything below it
                      without saying why. A reply that already carries prose
                      opens with the field at full height and no animation — the
                      wrapper mounts open, so there is nothing to transition
                      from. */}
                  <Reveal
                    when={
                      responses()[guestId]?.dietaryPresets.includes("other") ||
                      (responses()[guestId]?.dietary.trim().length ?? 0) > 0
                    }
                  >
                    <label class="font-body text-text-muted text-ui-sm tracking-ui-wide mt-3 block uppercase">
                      Anything else
                      <input
                        type="text"
                        // No `focus:outline-none` here: it sits in Tailwind's
                        // utilities layer and would beat the base-layer
                        // `:focus-visible` ring, leaving a border tint as the
                        // only focus cue on the invite's main data-entry field.
                        class="border-border font-body text-text placeholder:text-text-muted focus:border-gold sm:text-ui-base mt-1.5 block w-full rounded-sm border bg-transparent px-3 py-2.5 text-base transition-colors duration-200"
                        placeholder="e.g. no onion or garlic"
                        value={responses()[guestId]?.dietary ?? ""}
                        onInput={(e) => setDietary(guestId, e.currentTarget.value)}
                        maxLength={500}
                        disabled={locked()}
                      />
                    </label>
                  </Reveal>
                </Show>
              </fieldset>
            );
          }}
        </For>

        {/* ONE consent for the household's own members, for the whole
            submission. A household of four typing dietary notes used to tick
            four boxes saying the same thing. Collapsing them is only safe
            because the box names exactly who it covers and refuses to open
            ticked unless every one of those people already has a stored
            consent record — see `createConsentBox`. Unticked by default, and
            the submit gate blocks on it. See
            `wiki/compliance/dpia/cire-guest-data.md`. */}
        <Show when={ownWithDietaryData().length > 0}>
          <label class="font-body text-text-muted text-ui-sm flex items-start gap-2.5 leading-relaxed normal-case">
            <input
              type="checkbox"
              class="accent-gold mt-0.5 h-4 w-4 shrink-0 cursor-pointer"
              checked={consent.checked()}
              onChange={(e) => consent.setChecked(e.currentTarget.checked)}
              disabled={locked()}
            />
            <span>
              I agree to the dietary requirements above — for{" "}
              {formatNames(ownWithDietaryData().map((m) => m.firstName))} — being stored and shared
              with the caterers for this wedding. See our{" "}
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

        {/* The household's attestation for its plus-ones: a separate box,
            because it says something different — not "I agree" but "they
            agreed" — and is stored under its own version. Same rules as the
            box above, over its own people. */}
        <Show when={plusOnesWithDietaryData().length > 0}>
          <label class="font-body text-text-muted text-ui-sm flex items-start gap-2.5 leading-relaxed normal-case">
            <input
              type="checkbox"
              class="accent-gold mt-0.5 h-4 w-4 shrink-0 cursor-pointer"
              checked={attestation.checked()}
              onChange={(e) => attestation.setChecked(e.currentTarget.checked)}
              disabled={locked()}
            />
            <span>
              {PLUS_ONE_DIETARY_ATTESTATION.text(
                formatNames(plusOnesWithDietaryData().map((m) => m.firstName)),
              )}{" "}
              See our{" "}
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

        <Show when={error()}>
          <p class="font-body text-error text-ui-sm py-1" role="alert">
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

        <Show when={blockedByMember() && !props.closed}>
          <p class="text-text-muted text-ui-sm" id="rsvp-member-required">
            {MEMBER_REQUIRED_COPY}
          </p>
        </Show>

        {/* Sits flush on the sheet's bottom edge — the sheet drops its own
            bottom padding (`flushBottom`) rather than this bar cancelling it
            with a negative margin: `bottom: 0` resolves against the scrollport,
            so a negative bottom margin lifts the bar up over the last card
            instead of stretching it down into the padding. */}
        <div class="border-border bg-surface sticky bottom-0 -mx-6 flex gap-3 border-t px-6 pt-4 pb-[max(1rem,env(safe-area-inset-bottom))] md:pb-4">
          <Button
            variant="quiet"
            type="button"
            class="flex-1"
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
          </Button>
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
            {/* Deliberately not `@cire/ui`'s `Button`.
                That component fades anything carrying `aria-disabled`, on the
                reading that the attribute marks a control someone cannot press
                and should be told why. Here it marks a control that has already
                DONE its job — "Saved" — and the one state that must look most
                alive is exactly the one it would grey out. The fade below is
                keyed on `loading()` instead, which is the state that earns it. */}
            <button
              type="submit"
              class="border-gold font-body text-gold-ink hover:bg-gold hover:text-bg disabled:hover:text-gold-ink text-ui-sm tracking-ui-wider flex-1 rounded-sm border bg-transparent px-4 py-3 uppercase transition-colors duration-200 disabled:cursor-not-allowed disabled:hover:bg-transparent"
              classList={{
                "opacity-40": loading() || blockedByMember(),
                "cursor-pointer": !saved(),
                "cursor-default": saved(),
              }}
              disabled={loading()}
              // Not `disabled` while nobody has said who is answering: a
              // disabled button takes no focus, so a keyboard or screen-reader
              // user would never reach the reason. `handleSubmit` enforces it.
              aria-describedby={blockedByMember() ? "rsvp-member-required" : undefined}
              // Not `disabled`: this button holds keyboard focus at the moment
              // the reply lands, and disabling a focused control drops focus to
              // `<body>` — outside an `aria-modal` dialog, with no keyboard way
              // back in (the same failure C-L2 documents below). `aria-disabled`
              // states the same thing without moving focus; `handleSubmit`
              // enforces it.
              aria-disabled={saved() || blockedByMember() || undefined}
            >
              {saved() ? "Saved" : loading() ? "Saving…" : "Save"}
            </button>
          </Show>
        </div>
      </form>
    </>
  );
}
