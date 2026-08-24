import { Toaster } from "@shared/toast";
import {
  batch,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  lazy,
  onCleanup,
  onMount,
  Show,
  Suspense,
  For,
} from "solid-js";

import { awaitEventCards } from "../../components/await-event-cards";
import { createClaimCode } from "../../components/claim-code";
import { createSessionRestore, noteClaimed, signOut } from "../../components/claim-session";
import { createRsvpClosed } from "../../components/createRsvpClosed";
import type { ImageCrop } from "../../components/image-crop";
import {
  applyPaletteToRoot,
  filterThemeVars,
  type InviteTheme,
  sectionVars,
} from "../../components/invite-theme";
import { InviteClosing } from "../../components/InviteClosing";
import { prefetchOnIdle } from "../../components/prefetch-idle";
import { deadlineNotice, formatDeadlineDay, RSVP_NOTICE_ID } from "../../components/rsvp-deadline";
import { hasHouseholdResponded } from "../../components/rsvp-responded";
import {
  TurnstileWidget,
  turnstileEnabled,
  type TurnstileControls,
} from "../../components/TurnstileWidget";
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
const PulseAccountLink = lazy(() =>
  import("../../components/PulseAccountLink").then((m) => ({ default: m.PulseAccountLink })),
);
const AuthProvider = lazy(() =>
  import("@shared/rp-auth/solid").then((m) => ({ default: m.AuthProvider })),
);

/** Events ("details") section header copy. `null` ⇒ the built-in defaults. */
export interface DetailsCopy {
  eyebrow: string | null;
  heading: string | null;
}

/**
 * Shape of the public invite endpoint we consume — the theme plus the copy this
 * island renders (the details-section header and the post-claim welcome
 * greeting). `details`/`welcome` are optional on the wire so a mid-deploy
 * payload from an older API simply keeps the built-in copy.
 */
interface InviteCustomisationResponse {
  theme?: InviteTheme | null;
  details?: DetailsCopy | null;
  welcome?: { message: string | null } | null;
  // The closing section (the couple's sign-off). Optional on the wire so a
  // mid-deploy payload from an older API simply renders no closing section.
  footer?: {
    message: string | null;
    imageUrl?: string | null;
    imageCrop?: ImageCrop | null;
  } | null;
}

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
const DEFAULT_WELCOME_MESSAGE = "We are delighted to invite you to celebrate with us.";

interface InvitePageProps {
  apiUrl: string;
  /**
   * The wedding slug, used to revalidate the invite customisation at runtime so
   * the events ("details") section reflects the organiser's latest saved theme
   * without a site rebuild. Absent ⇒ no revalidation (the build-time `theme`
   * prop is used as-is) — keeps no-slug callers (e.g. unit tests) deterministic.
   */
  slug?: string;
  siteUrl?: string;
  /**
   * The per-section theme, resolved at build time in `index.astro` (same source
   * as the hero). Used as the initial render value so the events section paints
   * with the real theme in the SSR'd HTML; the on-mount revalidation below then
   * overrides it with the latest saved theme.
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
  // Whether the post-claim view has taken over from the claim form. Deliberately
  // NOT derived from `claimResult`: the swap is choreographed, so the form has
  // to stay in the layout for the length of its fade-out. This signal is the
  // SINGLE owner of both elements' `display`; the motion sequence reports the
  // moment via `onFormHidden` and never writes `display` itself, because an
  // imperative write desynchronises Solid's style binding permanently. See
  // `RevealHooks` in ./UnlockReveal.motion.
  const [revealed, setRevealed] = createSignal(false);

  // Warm the chunks that are otherwise fetched mid-interaction: the unlock
  // sequence (imported inside `handleClaimed`, i.e. after the claim resolves),
  // the modal transitions (imported inside `AnimatedModal` on first open), and
  // the post-claim components split out above — those are needed the instant
  // the claim resolves, so without this the split would trade a slower first
  // paint for a slower reveal. `lazy` exposes each one's loader as `.preload()`,
  // which both fetches the chunk and primes the same cache the render reads, so
  // a warmed component renders without a suspense gap.
  // Hints only — every call site keeps its own import and its own fallback.
  onMount(() => {
    const cancels = [
      prefetchOnIdle(() => import("./UnlockReveal.motion")),
      prefetchOnIdle(() => import("../../components/Modal.motion")),
      prefetchOnIdle(() => RsvpModal.preload()),
      prefetchOnIdle(() => DetailsModal.preload()),
      prefetchOnIdle(() => EventCard.preload()),
      prefetchOnIdle(() => PulseAccountLink.preload()),
      prefetchOnIdle(() => AuthProvider.preload()),
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
      // runs no choreography, so nothing would ever flip it, and the claim form
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

  // Revalidate the invite customisation on mount so the events section reflects
  // the organiser's latest saved theme + copy. The static guest site bakes the
  // build-time values into the props; without this re-fetch a change made after
  // the last build would never reach guests until a rebuild (the bug this fixes).
  // The build-time props seed the resource so first paint is immediate and the
  // no-JS fallback still renders the SSR'd values. Only fetches when a slug is
  // present; a non-OK / failed revalidation keeps the already-painted values.
  const propInvite = (): LiveInvite => ({
    theme: props.theme ?? null,
    details: props.details ?? null,
    welcomeMessage: props.welcomeMessage ?? null,
  });
  const [liveInvite] = createResource<LiveInvite>(
    async () => {
      if (!props.slug) return propInvite();
      try {
        const res = await fetch(`${props.apiUrl}/api/invite/${props.slug}`, {
          cache: "no-store",
        });
        if (!res.ok) return propInvite();
        const body = (await res.json()) as InviteCustomisationResponse;
        return {
          theme: body.theme ?? null,
          details: body.details ?? null,
          welcomeMessage: body.welcome?.message ?? null,
        };
      } catch {
        return propInvite();
      }
    },
    { initialValue: propInvite() },
  );

  // Which derived surface each section sits on. The COLOURS themselves come
  // from the palette applied at the document root, so every descendant — event
  // cards, buttons, hover/focus states, modal contents — already resolves the
  // organiser's scheme; a section only chooses its background.
  // Memoised: each map has several consumers (panel + both modals), so compute
  // once per theme change and share a stable object identity.
  const detailsVars = createMemo(() => sectionVars(liveInvite().theme, "details"));
  const welcomeVars = createMemo(() => sectionVars(liveInvite().theme, "welcome"));

  // Repaint the root palette when the revalidated theme changes. Harmless
  // duplicate of InviteHeader's effect on a full invite page (both islands see
  // the same payload); load-bearing on a page where the hero is hidden, since
  // then this island is the only one that revalidates.
  createEffect(() => applyPaletteToRoot(liveInvite().theme));

  // Organiser copy overrides with the built-in defaults as fallback.
  const detailsEyebrow = () => liveInvite().details?.eyebrow ?? DEFAULT_DETAILS_EYEBROW;
  const detailsHeading = () => liveInvite().details?.heading ?? DEFAULT_DETAILS_HEADING;
  // Live value first (seeded from the build-time prop), then the built-in
  // default — same chain as classic, so an organiser edit made after the last
  // build reaches guests via the on-mount revalidation.
  const welcomeMessage = () => liveInvite().welcomeMessage ?? DEFAULT_WELCOME_MESSAGE;

  // The RSVP deadline arrives with the claim (it is household-facing, like the
  // events beside it). One verdict drives all three surfaces below — the notice
  // under the heading, every card's Respond button, and the RSVP sheet — and it
  // re-derives itself if the deadline passes while the invite is open.
  // Memoised, not a plain accessor (P-I2) — see the note in classic's
  // InvitePage: the post-save `setClaimResult` spread keeps `rsvpDeadline` at
  // the same object reference, so `===` equality stops the propagation dead.
  const rsvpDeadline = createMemo(() => claimResult()?.rsvpDeadline ?? null);
  const rsvpClosed = createRsvpClosed(rsvpDeadline);
  const rsvpNotice = createMemo(() => deadlineNotice(rsvpDeadline(), rsvpClosed()));

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

  let codeInputRef: HTMLInputElement | undefined;
  let turnstile: TurnstileControls | undefined;
  let loginFormRef: HTMLDivElement;
  let welcomeRef: HTMLDivElement;
  let eventsSectionRef!: HTMLElement;

  async function handleClaimed(result: ClaimResult) {
    setClaimResult(result);
    // Mark this browser as having a household session, so the next visit
    // restores instead of asking for the code again — and so a first-time
    // visitor never spends a request on a guaranteed 401.
    noteClaimed();

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
      // The swap completes even when the choreography did not — a failed chunk,
      // a missing ref or a throw mid-sequence must never leave the claim form
      // sitting on top of an invite this guest has already claimed. Idempotent.
      //
      // Conditional on the claim still being current (P-W2). `onFormHidden`
      // fires at the end of step 1 and the sequence runs on for ~150ms more,
      // so "Use a different claim code" is already on screen and clickable
      // while this await is pending. An unconditional write would land AFTER
      // that reset and re-hide the form with `claimResult` back at null — the
      // welcome banner rendering from nothing, with no in-page way back.
      if (claimResult()) setRevealed(true);
    }
  }

  // Claim panel behaviour — the code entry field, the Turnstile-gated POST, and
  // the `?code=` deep-link auto-claim — is the same headless primitive classic
  // uses via LoginSection; gala renders its own narrow-panel markup on top.
  const claim = createClaimCode({
    apiUrl: props.apiUrl,
    result: claimResult,
    onClaimed: handleClaimed,
  });

  // A claim code can cover one guest or a whole household. A single-guest code
  // greets the person individually ("Dear {name}"); a multi-guest code greets
  // the household ("The {familyName} Family"). For an individual, an optional
  // nickname overrides their first name.
  const members = () => claimResult()?.members ?? [];
  const isIndividual = () => members().length === 1;
  const individualName = () => {
    const m = members()[0];
    if (!m) return "";
    return m.nickname?.trim() ? m.nickname.trim() : m.firstName;
  };

  // "Not the Okafor family? Sign out" — names the household the control ends.
  const signOutLabel = () => {
    const name = isIndividual() ? individualName() : claimResult()?.familyName;
    return name?.trim() ? `Not ${name.trim()}? Sign out` : "Sign out";
  };

  // Ends the household session — see the note in classic's InvitePage. A REAL
  // sign-out: revokes `cire_session` server-side and drops the local restore
  // hint. Fire-and-forget so the local reset never waits on the network.
  function handleSignOut() {
    // Revoke `cire_session` server-side and drop the local restore hint.
    // Fire-and-forget on purpose: the local reset must not wait on the
    // network, or a guest on a borrowed phone tapping this watches the
    // household's invite sit there through a timeout. The request carries its
    // own cookie, so nothing below depends on its result.
    void signOut(props.apiUrl);
    // T-U1: the unlock sequence fades the form out with Motion, which leaves
    // its END STATE as inline styles on this wrapper (`opacity: 0; transform:
    // translateY(-8px)`). Solid's binding on the element owns only `display`, so
    // nothing ever clears them — the restored form would return to the layout
    // fully transparent, i.e. a blank panel with no way back but a reload.
    // jsdom cannot see this (no CSS, no layout) and the unit tier mocks the
    // animation away, so it is pinned in the browser tier instead.
    //
    // Writing these two is safe for the same reason `display` would not be:
    // Solid does not manage them, so there is no binding to desynchronise.
    if (loginFormRef) {
      loginFormRef.style.opacity = "";
      loginFormRef.style.transform = "";
    }
    // Return the form to a submittable state: blank field, no stale error, no
    // stuck `loading`, no spent single-use Turnstile token. See the notes in
    // `createClaimCode.reset` for what each one would otherwise strand.
    claim.reset();
    // Re-challenge so a fresh token can replace the redeemed one. No-op when
    // Turnstile is unconfigured.
    turnstile?.reset();
    batch(() => {
      setRevealed(false);
      setRestoredSession(false);
      setClaimResult(null);
    });
    // C-L1: the click removes the focused button from the accessibility tree,
    // so without this focus falls to `<body>` and a keyboard or screen-reader
    // user is stranded at the top of the document. The code input is both the
    // announcement (it carries an accessible name) and the next action.
    codeInputRef?.focus();
  }

  return (
    <>
      {/* Claim panel — a narrow bordered object sitting on the page, not a
          full-bleed section. Centered on mobile; at md+ it sits flush with the
          events column's left edge (both share this container's gutters). */}
      <section class="px-6 py-16 md:px-10 md:py-20">
        <div class="mx-auto max-w-[1200px]">
          <div
            class="border-border mx-auto max-w-[400px] rounded-sm border px-7 py-10 md:mx-0"
            style={{
              ...filterThemeVars(welcomeVars()),
              "background-color": "var(--invite-section-bg)",
            }}
          >
            {/* Login form — visible before claim */}
            <div ref={(el) => (loginFormRef = el)} style={{ display: revealed() ? "none" : "" }}>
              <p class="font-body text-gold-ink mb-3 text-[0.72rem] tracking-[0.2em] uppercase">
                Your Invitation
              </p>
              <h2 class="font-display text-text mb-5 text-[calc(clamp(1.5rem,4vw,2rem)*var(--invite-heading-scale,1))] leading-[1.15] [font-weight:var(--invite-heading-weight,300)] [font-style:var(--invite-heading-style,normal)]">
                Enter Your Code
              </h2>
              <p class="text-text-muted mb-8 text-[0.92rem] leading-[1.6] font-light">
                Enter the code from your invitation to see your events.
              </p>
              <form class="flex flex-col gap-3" onSubmit={claim.handleSubmit}>
                {/* maxLength 48 comfortably fits the worst-case code: SURNAME(16) +
                    "-" + longest word(10) + "-" + secure hash "XXXXX-XXXXX"(11) = 39
                    chars, so a long code like THENGUYENFAMILY-BANISTER-DM65HQ (31) is
                    never truncated. The server still validates the code. */}
                <input
                  type="text"
                  ref={codeInputRef}
                  // Ink-at-alpha fill + border rather than a surface token, so
                  // the field stays one legible step from its background on
                  // every palette and every section tone the organiser can pick,
                  // with the border clearing WCAG SC 1.4.11's 3:1 on the worst
                  // of them. Same values as classic's LoginSection — see the
                  // note there; the two packs must not drift.
                  class="border-text/55 bg-text/[0.045] font-body text-text placeholder:text-text-muted focus:border-gold w-full cursor-text rounded-sm border px-4 py-3.5 text-center text-base tracking-[0.1em] uppercase transition-colors duration-200 placeholder:tracking-[0.04em] placeholder:normal-case focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--invite-focus)] disabled:cursor-not-allowed disabled:opacity-50"
                  // A placeholder is not an accessible name, and it vanishes on
                  // input — see the note in classic's LoginSection.
                  aria-label="Invitation code"
                  placeholder="e.g. PATEL-JOY-RK97"
                  value={claim.code()}
                  onInput={(e) => claim.setCode(e.currentTarget.value)}
                  autocapitalize="characters"
                  autocorrect="off"
                  spellcheck={false}
                  disabled={claim.loading()}
                  maxLength={48}
                  // NB: the hyphen must be escaped — Chrome compiles `pattern` with
                  // the `v` flag, where a trailing unescaped `-` is a syntax error
                  // that voids the whole pattern.
                  pattern="[A-Za-z0-9\-]+"
                />
                <Show when={claim.error()}>
                  <p class="font-body text-error py-2 text-[0.82rem]" role="alert">
                    {claim.error()}
                  </p>
                </Show>
                {/* Turnstile challenge — renders only when a sitekey is configured;
                    otherwise this is nothing and the form is unchanged. */}
                <TurnstileWidget
                  onToken={claim.setTurnstileToken}
                  controls={(handle) => (turnstile = handle)}
                  class="flex justify-center"
                />
                <button
                  type="submit"
                  class="border-gold font-body text-gold-ink hover:bg-gold hover:text-bg disabled:hover:text-gold-ink w-full rounded-sm border bg-transparent px-6 py-3.5 text-[0.88rem] tracking-[0.12em] uppercase transition-colors duration-200 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
                  disabled={
                    claim.loading() ||
                    !claim.code().trim() ||
                    (turnstileEnabled() && !claim.turnstileToken())
                  }
                >
                  {claim.loading() ? "Checking…" : "Open Invitation"}
                </button>
              </form>
            </div>

            {/* Welcome message — visible after claim, inside the same bordered
                object (a ref-toggled swap, not a second panel). */}
            <div ref={(el) => (welcomeRef = el)} style={{ display: revealed() ? "" : "none" }}>
              <Show when={claimResult()?.preview}>
                <p
                  class="border-gold/40 bg-gold/5 text-gold-ink mb-6 rounded-sm border px-4 py-3 text-[0.78rem] tracking-[0.08em] uppercase"
                  role="status"
                >
                  Preview mode. Every event is shown; try the RSVP, nothing you send is saved.
                </p>
              </Show>
              <Show
                when={isIndividual()}
                fallback={
                  <>
                    <h2 class="font-display text-gold-ink mb-3 text-[calc(clamp(1.5rem,4vw,2rem)*var(--invite-heading-scale,1))] leading-[1.15] [font-weight:var(--invite-heading-weight,300)] [font-style:var(--invite-heading-style,normal)]">
                      Welcome, the {claimResult()?.familyName} Family
                    </h2>
                    <p class="text-text-muted mb-2 text-[0.92rem] leading-[1.6] font-light">
                      {welcomeMessage()}
                    </p>
                    <p class="text-text mb-8 text-[0.88rem] leading-[1.6] font-light">
                      <For each={claimResult()?.members}>
                        {(member, i) => (
                          <>
                            {i() > 0 && ", "}
                            {member.firstName}
                          </>
                        )}
                      </For>
                    </p>
                  </>
                }
              >
                <h2 class="font-display text-gold-ink mb-3 text-[calc(clamp(1.5rem,4vw,2rem)*var(--invite-heading-scale,1))] leading-[1.15] [font-weight:var(--invite-heading-weight,300)] [font-style:var(--invite-heading-style,normal)]">
                  Dear {individualName()}
                </h2>
                <p class="text-text-muted mb-8 text-[0.92rem] leading-[1.6] font-light">
                  {welcomeMessage()}
                </p>
              </Show>
              <button
                type="button"
                onClick={handleSignOut}
                class="font-body text-text-muted hover:text-gold-ink focus-visible:ring-gold/60 rounded-sm text-[0.78rem] underline underline-offset-2 transition-colors duration-200 focus:outline-none focus-visible:ring-2"
              >
                {signOutLabel()}
              </button>
            </div>
          </div>
        </div>
      </section>

      <Show when={claimResult()}>
        {(data) => (
          <section
            ref={eventsSectionRef}
            class="border-border border-y px-6 py-16 md:px-10 md:py-20"
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
            <div class="mx-auto max-w-[1200px]">
              <div data-testid="events-column" class="max-w-[960px] text-left">
                <p class="font-body text-gold-ink mb-3 text-[0.72rem] tracking-[0.2em] uppercase">
                  {detailsEyebrow()}
                </p>
                <h2 class="font-display text-text mb-5 text-[calc(clamp(1.75rem,4vw,2.5rem)*var(--invite-heading-scale,1))] leading-[1.15] [font-weight:var(--invite-heading-weight,300)] [font-style:var(--invite-heading-style,normal)]">
                  {detailsHeading()}
                </h2>
                <hr class="border-border mb-10 h-0 w-full border-t" aria-hidden="true" />
                {/* The RSVP-by line. One line governs every card — a per-card
                    repeat would be four copies of one fact — so it sits BELOW
                    the rule, directly on top of the list: the rule closes the
                    section header, and this belongs to the cards under it, not
                    to the heading above. Held tight to them (`mb-3`) so it reads
                    as their label. Centred on the column — it speaks for the
                    whole list, so it takes the column's axis rather than the
                    left edge the cards' own copy runs along.

                    `text-gold-ink`, not `text-gold` — see the same line in the
                    `classic` pack: the metal token is held to the 3:1 UI floor,
                    which is the wrong bar for a 0.85rem sentence. */}
                <Show when={rsvpNotice()}>
                  {(notice) => (
                    <p
                      id={RSVP_NOTICE_ID}
                      class="font-body mb-3 text-center text-[0.85rem]"
                      classList={{
                        "text-text-muted": rsvpClosed(),
                        "text-gold-ink": !rsvpClosed(),
                      }}
                      role="status"
                    >
                      {notice()}
                    </p>
                  )}
                </Show>
                <div class="flex flex-col gap-5">
                  <Suspense fallback={null}>
                    <For each={data().events}>
                      {(event) => (
                        <div data-event-card>
                          <EventCard
                            event={event}
                            apiUrl={props.apiUrl}
                            // Gala's wide single column keeps a consistent
                            // text-left/image-right rhythm on every row, unlike
                            // classic's alternating orientation.
                            orientation="norm"
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
            </div>

            {/* Optional, additive "Link my Pulse account" affordance. Shown only
                post-claim (it lives inside this claimed-state Show), and never in
                preview mode (a host previewing isn't a guest seat to link). Wrapped
                in its own AuthProvider, which reads the cire session cookie from
                cire-api — the rest of the guest site stays free of any OSN
                dependency. The component self-hides when linking is disabled (503) or
                unavailable, so it can never break the core invite. */}
            <Show when={!data().preview}>
              <Suspense fallback={null}>
                <AuthProvider config={{ apiBase: props.apiUrl }}>
                  <PulseAccountLink apiUrl={props.apiUrl} members={data().members} />
                </AuthProvider>
              </Suspense>
            </Show>
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
      {/* Confirmation toasts — mounted at the PAGE ROOT, deliberately.
          It used to sit next to `PulseAccountLink` inside the events section,
          which is `<Show when={!preview}>` — so host preview had no toaster at
          all and every `toast.success` there was silently dropped. Out here it
          renders in both modes.

          It also used to be trapped by that section: Motion One's reveal leaves
          an inline `transform` on it, which makes it the containing block AND a
          stacking context for a `position: fixed` toaster inside it, so the
          toast painted BELOW the `z-100` RSVP sheet it fires underneath.
          `@shared/toast` portals its container to <body>, so that half can no
          longer happen wherever this is mounted — but the preview half still
          can, which is why this stays at the root.

          `top-center`, not bottom: the toast is raised while the RSVP sheet is
          still open, and that sheet's sticky action bar owns the bottom edge. */}
      <Toaster
        position="top-center"
        // The layer goes on as a CLASS. `@shared/toast` sets no `z-index` of
        // its own — precisely so this works. (`solid-toast` spread a hardcoded
        // `z-index: 9999` onto the same div's inline style, which beat any
        // class and parked the toast ABOVE the consent layers; the only
        // override that won was `containerStyle`. Two-sided bound asserted in
        // `InvitePage.browser.test.tsx`.)
        class={Z_CLASS.TOAST}
      />
    </>
  );
}
