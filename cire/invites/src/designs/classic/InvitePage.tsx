import { Toaster } from "@shared/toast";
import {
  batch,
  createEffect,
  createMemo,
  createSignal,
  lazy,
  onCleanup,
  onMount,
  Show,
  Suspense,
  For,
} from "solid-js";

import { awaitEventCards } from "../../components/await-event-cards";
import { createSessionRestore } from "../../components/claim-session";
import { createRsvpDeadlineState } from "../../components/createRsvpDeadlineState";
import {
  createInviteRetry,
  type DetailsCopy,
  type InviteCustomisationResponse,
} from "../../components/invite-retry";
import {
  applyPaletteToRoot,
  filterThemeVars,
  type InviteTheme,
  sectionVars,
} from "../../components/invite-theme";
import { InviteClosing } from "../../components/InviteClosing";
import { LoginSection } from "../../components/LoginSection";
import { prefetchOnIdle } from "../../components/prefetch-idle";
import { formatDeadlineDay, RSVP_NOTICE_ID } from "../../components/rsvp-deadline";
import { hasHouseholdResponded } from "../../components/rsvp-responded";
import { RsvpDeadlineNotice } from "../../components/RsvpDeadlineNotice";
import type { ClaimResult, EventSummary, RsvpSummary } from "../../components/types";
import { Z_CLASS } from "../../lib/z-index";

// Post-claim UI, split out of the page's initial chunk (P-W1). Nothing here
// renders before the guest claims their code — every one of these sits inside a
// `Show` below — yet a static import collected them into the page's initial
// shared chunk, where they were ~44% of its gzipped bytes: downloaded and
// parsed while the guest is still looking at the hero, competing with the
// preloaded hero image (the LCP element) on exactly the phones that made this a
// bug. `lazy` moves them to their own chunk, and `onMount` warms that chunk at
// idle (see the prefetch below) so the split never costs the guest a wait at
// the moment a modal opens.
//
// `.then` adapters because `lazy` wants a default export and these are all
// named. Declared at module scope, not inside the component, so the promise —
// and therefore the chunk — is shared across every render.
const RsvpModal = lazy(() =>
  import("../../components/RsvpModal").then((m) => ({ default: m.RsvpModal })),
);
const DetailsModal = lazy(() =>
  import("../../components/DetailsModal").then((m) => ({ default: m.DetailsModal })),
);
const EventCard = lazy(() =>
  import("../../components/EventCard").then((m) => ({ default: m.EventCard })),
);

/** The slice of the invite customisation this island renders. */
interface LiveInvite {
  theme: InviteTheme | null;
  details: DetailsCopy | null;
  welcomeMessage: string | null;
}

// Built-in default copy, used when the organiser hasn't overridden it — the
// pre-customisation hardcoded strings, so an un-customised invite is unchanged.
const DEFAULT_DETAILS_EYEBROW = "Celebrate With Us";
const DEFAULT_DETAILS_HEADING = "Your Events";

interface InvitePageProps {
  apiUrl: string;
  /**
   * The wedding slug. Scopes the session restore and, with `inviteMissing`, the
   * browser-side retry of the invite. Absent ⇒ neither request runs, which keeps
   * no-slug callers (e.g. unit tests) deterministic.
   */
  slug?: string;
  /**
   * True when the `[slug]` route's own fetch of the invite failed, so `theme`,
   * `details` and `welcomeMessage` are built-in defaults rather than the
   * wedding's. Only then does the island fetch the invite, from the browser,
   * after it mounts. Absent ⇒ the props are the wedding's and nothing is fetched.
   */
  inviteMissing?: boolean;
  siteUrl?: string;
  /**
   * The per-section theme, from the same per-request fetch as the hero, so the
   * events section paints with the real theme in the server-rendered HTML.
   */
  theme?: InviteTheme | null;
  /**
   * Events-section header copy, resolved server-side like `theme`. Absent/null
   * fields fall back to the built-in defaults.
   */
  details?: DetailsCopy | null;
  /**
   * Post-claim welcome greeting override, resolved server-side like `theme`.
   * Absent/null ⇒ the built-in default greeting.
   */
  welcomeMessage?: string | null;
}

export default function InvitePage(props: InvitePageProps) {
  const [claimResult, setClaimResult] = createSignal<ClaimResult | null>(null);
  const [rsvpEvent, setRsvpEvent] = createSignal<EventSummary | null>(null);
  const [detailsEvent, setDetailsEvent] = createSignal<EventSummary | null>(null);
  // Which event's Respond button should play the recorded-reply confirmation
  // right now (see `EventCard`'s `justResponded`/`onCelebrated` and
  // `rsvp-responded.ts`). Reset to null once that card reports the
  // choreography finished, so the NEXT confirmation for the same event (an
  // edited, re-submitted reply) is a fresh false→true transition rather than
  // a no-op.
  const [justRespondedEventId, setJustRespondedEventId] = createSignal<string | null>(null);
  // True when the invite opened from an EXISTING session rather than from a code
  // the guest just typed. It suppresses the unlock choreography — there is no
  // unlock to perform on a return visit, and a curtain-raise firing by itself on
  // page load reads as a glitch. It is also what keeps the events section off
  // `opacity-0`: that class is only safe when something is going to animate it
  // back, and on this path nothing is.
  const [restoredSession, setRestoredSession] = createSignal(false);
  // Whether the post-claim view has taken over from the code form. Deliberately
  // NOT derived from `claimResult`: the swap is choreographed, so the form has
  // to stay in the layout for the length of its fade-out — a beat after the
  // claim resolves. This signal is the SINGLE owner of both elements' `display`
  // (`LoginSection`'s `revealed` prop); the motion sequence reports the moment
  // via `onFormHidden` and never writes `display` itself, because an imperative
  // write desynchronises Solid's style binding permanently — Solid diffs against
  // the last value it wrote, so it would skip every later attempt to restore the
  // form. See `RevealHooks` in ./UnlockReveal.motion.
  const [revealed, setRevealed] = createSignal(false);

  // Warm the chunks that are otherwise fetched mid-interaction: the unlock
  // sequence (imported inside `handleClaimed`, i.e. after the claim resolves)
  // and the post-claim components split out above — those are needed the
  // instant the claim resolves, so without this the split would trade a slower
  // first paint for a slower reveal. `lazy` exposes each one's loader as `.preload()`,
  // which both fetches the chunk and primes the same cache the render reads, so
  // a warmed component renders without a suspense gap.
  // Hints only — every call site keeps its own import and its own fallback.
  onMount(() => {
    const cancels = [
      prefetchOnIdle(() => import("./UnlockReveal.motion")),
      prefetchOnIdle(() => RsvpModal.preload()),
      prefetchOnIdle(() => DetailsModal.preload()),
      prefetchOnIdle(() => EventCard.preload()),
    ];
    onCleanup(() => cancels.forEach((cancel) => cancel()));
  });

  // Returning guests: re-open the invite from the 30-day household session
  // instead of asking for the code again.
  createSessionRestore({
    apiUrl: props.apiUrl,
    slug: props.slug,
    result: claimResult,
    onRestored: (result) =>
      // Order matters — `restoredSession` must be true before the events
      // section first renders, or it paints at `opacity-0` with nothing queued
      // to reveal it. `revealed` goes with it for the same reason: a restore
      // runs no choreography, so nothing would ever flip it, and the code form
      // would sit on top of the household's own invite.
      //
      // `batch` so the three commit as one (S-L1). Solid runs style bindings
      // synchronously on write, so unbatched there is a window — one statement
      // wide today — where `revealed` is true and `claimResult` is still null:
      // the form hidden, the welcome banner rendering from nothing. Nothing
      // paints in it now, but it is the state that hides the only door into the
      // invite committed ahead of the result that justifies hiding it, and any
      // later `await` or transition between these lines would open it for real.
      batch(() => {
        setRestoredSession(true);
        setRevealed(true);
        setClaimResult(result);
      }),
  });

  const siteUrl = () =>
    props.siteUrl ?? (typeof window !== "undefined" ? window.location.origin : "");

  // The route's payload, as props. Only when the route had none
  // (`inviteMissing`) does the island retry the fetch from the browser, and a
  // failed retry leaves the defaults painted.
  const propInvite = (): LiveInvite => ({
    theme: props.theme ?? null,
    details: props.details ?? null,
    welcomeMessage: props.welcomeMessage ?? null,
  });
  const liveInvite = createInviteRetry<InviteCustomisationResponse, LiveInvite>({
    apiUrl: () => props.apiUrl,
    slug: () => (props.inviteMissing ? props.slug : undefined),
    fallback: propInvite,
    select: (body) => ({
      theme: body.theme ?? null,
      details: body.details ?? null,
      welcomeMessage: body.welcome?.message ?? null,
    }),
  });

  // Which derived surface each section sits on. The COLOURS themselves come
  // from the palette applied at the document root, so every descendant — event
  // cards, buttons, hover/focus states, modal contents — already resolves the
  // organiser's scheme; a section only chooses its background.
  // Memoised: each map has several consumers (section wrapper + both modals),
  // so compute once per theme change and share a stable object identity.
  const detailsVars = createMemo(() => sectionVars(liveInvite().theme, "details"));
  const welcomeVars = createMemo(() => sectionVars(liveInvite().theme, "welcome"));

  // Repaint the root palette when the theme changes. Harmless duplicate of
  // InviteHeader's effect on a full invite page (both islands see the same
  // payload); load-bearing on a page where the hero is hidden, since then this
  // island is the only one whose retry can bring a theme in.
  createEffect(() => applyPaletteToRoot(liveInvite().theme));

  // Organiser copy overrides with the built-in defaults as fallback.
  const detailsEyebrow = () => liveInvite().details?.eyebrow ?? DEFAULT_DETAILS_EYEBROW;
  const detailsHeading = () => liveInvite().details?.heading ?? DEFAULT_DETAILS_HEADING;

  // The RSVP deadline arrives with the claim (it is household-facing, like the
  // events beside it). One verdict drives four surfaces — the claim panel's
  // date line, the notice on top of the cards, every card's Respond button and
  // the RSVP sheet — and it re-derives itself as the deadline draws near and
  // then passes while the invite is open.
  // Memoised, not a plain accessor (P-I2): `setClaimResult({ ...current, rsvps })`
  // after every RSVP save changes the signal while the spread keeps
  // `rsvpDeadline` at the SAME object reference, so a plain accessor would
  // re-run the whole chain each save — re-scheduling the deadline timer and
  // rebuilding date formatters for an unchanged value. The memo's default
  // `===` equality stops that at the memo, notifying once (null → the object).
  const rsvpDeadline = createMemo(() => claimResult()?.rsvpDeadline ?? null);
  const rsvpState = createRsvpDeadlineState(rsvpDeadline);
  const rsvpClosed = () => rsvpState() === "closed";

  // The permanent green tick on Respond: which events this household already
  // has an RSVP on file for. Recomputed whenever `onSubmitted` writes fresh
  // rows back into `claimResult`.
  const respondedEventIds = createMemo(() => {
    const data = claimResult();
    if (!data) return new Set<string>();
    return new Set(
      data.events
        .filter((e) => hasHouseholdResponded(e, data.members, data.rsvps))
        .map((e) => e.id),
    );
  });

  let loginFormRef: HTMLDivElement;
  let welcomeRef: HTMLDivElement;
  let eventsSectionRef!: HTMLElement;

  async function handleClaimed(result: ClaimResult) {
    setClaimResult(result);

    // Start the post-claim chunk NOW, not when the reveal reaches its events
    // step. `onMount` warms it at idle, but the whole reason this wait exists is
    // the guest whose phone never ran that idle callback — and for them the
    // sequence would not ask for the chunk until the form had finished fading
    // out, spending ~350ms of the cap before the request was even sent (P-W1).
    // `awaitEventCards` then joins a fetch already in flight.
    const cardsReady = EventCard.preload().then(() => undefined);
    // A failed chunk is handled where it matters, in `awaitEventCards` — but
    // that handler attaches a beat later, so mark the rejection handled here to
    // keep an offline guest from tripping an unhandled-rejection report.
    void cardsReady.catch(() => {});

    // Wait a tick so SolidJS renders the events section into the DOM
    await new Promise((r) => setTimeout(r, 0));

    try {
      if (loginFormRef && welcomeRef && eventsSectionRef) {
        const { unlockRevealSequence } = await import("./UnlockReveal.motion");
        await unlockRevealSequence(loginFormRef, welcomeRef, eventsSectionRef, {
          onFormHidden: () => setRevealed(true),
          // The cards come from a `lazy` component, so on a cold cache their
          // chunk can still be in flight here. The sequence awaits this
          // alongside its own layout beat, and the wait caps itself, so the
          // entrance animates real cards instead of an empty section — and
          // never stalls.
          waitForEvents: () =>
            awaitEventCards(
              () => cardsReady,
              () => eventsSectionRef,
            ),
        });
      } else if (eventsSectionRef) {
        eventsSectionRef.style.opacity = "1";
      }
    } catch {
      // The motion chunk failed to load (offline mid-session, stale deploy) —
      // reveal without the animation; the invite must never stay hidden.
      if (eventsSectionRef) eventsSectionRef.style.opacity = "1";
    } finally {
      // The swap completes even when the choreography did not. A failed chunk,
      // a missing ref or a throw mid-sequence must never leave the code form
      // sitting on top of an invite this guest has already claimed. Idempotent —
      // the happy path has normally set it already, from `onFormHidden`.
      //
      // Conditional on the claim still being current. `onFormHidden` fires at
      // the end of step 1 and the sequence then runs on for ~200ms more, so the
      // sign-out control is already on screen and clickable while this await
      // is still pending. An unconditional write
      // here would land AFTER that reset and re-hide the form with
      // `claimResult` back at null — the welcome banner rendering from
      // nothing, and no in-page way back, since nothing else writes
      // `revealed`. Guarding on the claim keeps the failed-choreography
      // guarantee while letting the later reset win.
      if (claimResult()) setRevealed(true);
    }
  }

  // The household signed out. `LoginSection` has already revoked the session,
  // dropped the restore hint and reset its form; this puts the page back to
  // its unclaimed state in one commit.
  function handleSignOut() {
    batch(() => {
      setRevealed(false);
      setRestoredSession(false);
      setClaimResult(null);
    });
  }

  return (
    <>
      <LoginSection
        layout="band"
        apiUrl={props.apiUrl}
        result={claimResult()}
        revealed={revealed()}
        onClaimed={handleClaimed}
        formRef={(el) => (loginFormRef = el)}
        welcomeRef={(el) => (welcomeRef = el)}
        themeVars={welcomeVars()}
        welcomeMessage={liveInvite().welcomeMessage}
        rsvpDeadlineState={rsvpState()}
        onSignOut={handleSignOut}
      />

      <Show when={claimResult()}>
        {(data) => (
          <section
            ref={eventsSectionRef}
            class="border-border border-y px-6 py-16 md:px-8 md:py-20"
            // Hidden until the unlock sequence reveals it — but ONLY on the
            // code-entry path. A restored session has no reveal to wait for, so
            // starting at zero opacity there would leave the invite blank.
            classList={{ "opacity-0": !restoredSession() }}
            // The section paints whichever derived surface its tone names; the
            // `text-gold-ink` / `font-display` / `border-border` utilities on the
            // header and on every EventCard descendant already resolve the
            // organiser's scheme from the root palette.
            style={{
              ...filterThemeVars(detailsVars()),
              "background-color": "var(--invite-section-bg)",
            }}
          >
            <div class="max-w-column-lg md:max-w-column-xl mx-auto text-center">
              <p class="font-body text-gold-ink text-ui-xs tracking-ui-widest mb-3 uppercase">
                {detailsEyebrow()}
              </p>
              <h2 class="font-display text-text leading-ui-none mb-5 text-[calc(clamp(2rem,5vw,3rem)*var(--invite-heading-scale,1))] [font-weight:var(--invite-heading-weight,300)] [font-style:var(--invite-heading-style,normal)]">
                {detailsHeading()}
              </h2>
              {/* The RSVP-by line. One line governs every card — a per-card
                  repeat would be four copies of one fact — so it sits directly
                  on top of the list rather than inside the header block, and is
                  held tight to the cards (`mb-3` against the heading's `mb-5`
                  above) so it reads as their label rather than as a third line
                  of section header. Centred: it speaks for the whole list, so it
                  sits on the section's own axis rather than picking out the
                  first card.

                  This is the copy that ANNOUNCES and the one each closed
                  Respond button describes itself by, so it keeps both
                  `role="status"` and the shared id. It renders in every
                  deadline state, closed included, which is what makes that
                  `aria-describedby` resolve. The claim panel states the date
                  too, as an ordinary paragraph. */}
              <RsvpDeadlineNotice
                deadline={rsvpDeadline()}
                state={rsvpState()}
                variant="notice"
                announce
                id={RSVP_NOTICE_ID}
                class="mb-3 text-center"
              />
              <div class="flex flex-col gap-5 text-left">
                <Suspense fallback={null}>
                  <For each={data().events}>
                    {(event, index) => (
                      <div data-event-card>
                        <EventCard
                          event={event}
                          apiUrl={props.apiUrl}
                          // Alternating rhythm: even rows render text-left/image-
                          // right (`norm`), odd rows flip to image-left/text-right
                          // (`alt`). Collapses to a single text column when the
                          // event has no image.
                          orientation={index() % 2 === 0 ? "norm" : "alt"}
                          rsvpClosed={rsvpClosed()}
                          rsvpClosedNoticeId={RSVP_NOTICE_ID}
                          responded={respondedEventIds().has(event.id)}
                          justResponded={justRespondedEventId() === event.id}
                          // While this event's sheet is up it covers this button, so the
                          // card holds its mark back until the sheet is gone — otherwise
                          // the fill would sweep in behind the sheet, where nobody can
                          // see it. See `EventCard`'s `covered`.
                          covered={rsvpEvent()?.id === event.id}
                          onCelebrated={() => setJustRespondedEventId(null)}
                          onRespond={setRsvpEvent}
                          onDetails={setDetailsEvent}
                        />
                      </div>
                    )}
                  </For>
                </Suspense>
              </div>
            </div>
          </section>
        )}
      </Show>

      {/* The couple's sign-off — their motif and closing note, the invite's last
          section. Its content arrives IN THE CLAIM RESPONSE, not the public
          invite payload: it is addressed to the invited household, so the API
          redacts it from `GET /api/invite/:slug` (S-H1). Reading it off
          `claimResult()` is therefore both the render gate and the only place
          the data exists — the two cannot drift apart. Deliberately NOT
          `opacity-0`: the unlock choreography animates the events section, and a
          section that depends on a motion chunk to become visible is one that
          can stay invisible when that chunk fails to load. It sits below every
          event card, so it is off-screen while that plays out. */}
      <Show when={claimResult()}>
        {(data) => (
          <InviteClosing
            apiUrl={props.apiUrl}
            // This pack's events column, so the closing band settles onto the
            // same measure as the cards above it once the screen is wider than
            // the invite needs.
            bandCap="column-xl"
            visible={data().closing?.visible}
            message={data().closing?.message}
            imageUrl={data().closing?.imageUrl}
            imageCrop={data().closing?.imageCrop}
            themeVars={filterThemeVars(welcomeVars())}
          />
        )}
      </Show>

      <Show when={rsvpEvent()}>
        {(event) => (
          <Suspense fallback={null}>
            <RsvpModal
              event={event()}
              members={claimResult()!.members}
              existingRsvps={claimResult()!.rsvps}
              apiUrl={props.apiUrl}
              // Host preview keeps the RSVP interactive but makes submit a no-op.
              preview={claimResult()!.preview}
              // Past the deadline the sheet is a read-only view of the reply
              // already on file — normally unreachable (Respond is disabled), but
              // the deadline can pass with the sheet open.
              closed={rsvpClosed()}
              closedOn={rsvpDeadline() ? formatDeadlineDay(rsvpDeadline()!) : undefined}
              // The RSVP dialog is the events section's expanded surface — it
              // follows the "details" theme (the modal renders outside the themed
              // section wrapper, so the vars must be re-applied on its panel).
              themeVars={detailsVars()}
              onClose={() => setRsvpEvent(null)}
              onSubmitted={(updated: RsvpSummary[]) => {
                const current = claimResult();
                if (!current) return;
                setClaimResult({ ...current, rsvps: updated });
              }}
              // Fires for the preview no-op too, which never touches
              // `claimResult` — see `respondedEventIds`'s comment.
              onConfirmed={() => setJustRespondedEventId(event().id)}
            />
          </Suspense>
        )}
      </Show>

      <Show when={detailsEvent()}>
        {(event) => (
          <Suspense fallback={null}>
            <DetailsModal
              event={event()}
              siteUrl={siteUrl()}
              // Same reasoning as RsvpModal — the event-details sheet follows the
              // "details" section theme.
              themeVars={detailsVars()}
              onClose={() => setDetailsEvent(null)}
            />
          </Suspense>
        )}
      </Show>
      {/* Confirmation toasts — mounted at the PAGE ROOT, deliberately, outside
          every section: a toaster inside a section renders only when that
          section does, and host preview must get its confirmations too.
          Motion One's reveal leaves an inline `transform` on the events
          section, which makes it the containing block AND a stacking context
          for anything `position: fixed` inside it; `@shared/toast` portals its
          container to <body>, so the toast paints above the `z-100` RSVP
          sheet it fires underneath wherever this is mounted.

          `top-center`, not bottom: the toast is raised while the RSVP sheet is
          still open, and that sheet's sticky action bar owns the bottom edge. */}
      <Toaster
        position="top-center"
        // The RSVP sheet is a `showModal()` dialog, which paints in the top
        // layer — above every stacking context in the document, so no `z-index`
        // here can reach over it. The save toast fires while that sheet is
        // still open, so without this it is raised behind the reply it
        // confirms. See `ToasterProps.topLayer`.
        topLayer
        // The layer still goes on as a CLASS, for everything that is NOT in the
        // top layer — the consent banner above it, the page below.
        // `@shared/toast` sets no `z-index` of its own, precisely so this
        // works. (`solid-toast` spread a hardcoded `z-index: 9999` onto the
        // same div's inline style, which beat any class and parked the toast
        // ABOVE the consent layers; the only override that won was
        // `containerStyle`. Two-sided bound asserted in
        // `InvitePage.browser.test.tsx`.)
        class={Z_CLASS.TOAST}
      />
    </>
  );
}
