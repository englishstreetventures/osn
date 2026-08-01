import {
  createEffect,
  createMemo,
  createSignal,
  createUniqueId,
  onCleanup,
  Show,
  For,
} from "solid-js";

import { AnimatedModal } from "./AnimatedModal";
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

  function initialResponses(): Record<string, MemberState> {
    const map: Record<string, MemberState> = {};
    const prior = props.existingRsvps ?? [];
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
  const titleId = createUniqueId();

  // Abort the in-flight submit if the modal unmounts mid-request — keeps the
  // setError / setLoading writes from landing on a disposed instance.
  let inFlight: AbortController | null = null;
  onCleanup(() => inFlight?.abort());

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

  // Disable every control both while a submit is in flight and once the RSVP
  // deadline has passed — the two reasons a guest can't change their answer.
  const locked = () => loading() || (props.closed ?? false);

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

    // Past the deadline there is no submit button to press; a form-level Enter
    // could still fire this, and the server would refuse it anyway.
    if (props.closed) return;

    const current = responses();
    const visible = eventMembers();
    const allAnswered = visible.every((m) => current[m.guestId]?.attending !== null);
    if (!allAnswered) {
      setError("Please respond for everyone in your party.");
      return;
    }

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
    // no network call, nothing persisted. Just close as if it had been sent.
    if (props.preview) {
      props.onClose();
      return;
    }

    setLoading(true);

    const body = {
      rsvps: visible.map((m) => {
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
        // Solid signal writes are synchronous, so the order here is safe even
        // if the parent unmounts the modal on `onClose`.
        props.onSubmitted?.(data.rsvps);
        props.onClose();
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
            disabled={loading()}
          >
            {/* Past the deadline there is nothing to cancel — the sheet is a
                view, so its one button says so. */}
            {props.closed ? "Close" : "Cancel"}
          </button>
          {/* No submit button once RSVPs are closed: a disabled Save invites a
              guest to keep clicking at a door that won't open. */}
          <Show when={!props.closed}>
            <button
              type="submit"
              class="border-gold font-body text-gold-ink hover:bg-gold hover:text-bg disabled:hover:text-gold-ink flex-1 cursor-pointer rounded-sm border bg-transparent px-4 py-3 text-[0.82rem] tracking-[0.1em] uppercase transition-colors duration-200 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
              disabled={loading()}
            >
              {loading() ? "Saving…" : "Save"}
            </button>
          </Show>
        </div>
      </form>
    </AnimatedModal>
  );
}
