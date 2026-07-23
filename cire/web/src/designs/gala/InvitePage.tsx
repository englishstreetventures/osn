import { AuthProvider } from "@osn/client/solid";
import { createEffect, createMemo, createResource, createSignal, Show, For } from "solid-js";
import { Toaster } from "solid-toast";

import { createClaimCode } from "../../components/claim-code";
import { DetailsModal } from "../../components/DetailsModal";
import { EventCard } from "../../components/EventCard";
import {
  applyPaletteToRoot,
  filterThemeVars,
  type InviteTheme,
  sectionVars,
} from "../../components/invite-theme";
import { PulseAccountLink } from "../../components/PulseAccountLink";
import { RsvpModal } from "../../components/RsvpModal";
import { TurnstileWidget, turnstileEnabled } from "../../components/TurnstileWidget";
import type { ClaimResult, EventSummary, RsvpSummary } from "../../components/types";
import { OSN_ISSUER_URL } from "../../lib/osn";

// Public Turnstile sitekey, baked in at build time. Undefined ⇒ key-optional
// (no widget rendered; osn-api also skips siteverify). Shared with the claim
// flow's TurnstileWidget; reused here for the OSN sign-in ceremony.
const TURNSTILE_SITEKEY = import.meta.env.PUBLIC_TURNSTILE_SITEKEY;

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

  let loginFormRef: HTMLDivElement;
  let welcomeRef: HTMLDivElement;
  let eventsSectionRef: HTMLElement;

  async function handleClaimed(result: ClaimResult) {
    setClaimResult(result);

    // Wait a tick so SolidJS renders the events section into the DOM
    await new Promise((r) => setTimeout(r, 0));

    if (loginFormRef && welcomeRef && eventsSectionRef) {
      try {
        const { unlockRevealSequence } = await import("./UnlockReveal.motion");
        await unlockRevealSequence(loginFormRef, welcomeRef, eventsSectionRef);
      } catch {
        // The motion chunk failed to load (offline mid-session, stale deploy) —
        // reveal without the animation; the invite must never stay hidden.
        eventsSectionRef.style.opacity = "1";
      }
    } else if (eventsSectionRef) {
      eventsSectionRef.style.opacity = "1";
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
            <div ref={(el) => (loginFormRef = el)} style={{ display: claimResult() ? "none" : "" }}>
              <p class="font-body text-gold mb-3 text-[0.72rem] tracking-[0.2em] uppercase">
                Your Invitation
              </p>
              <h2 class="font-display text-text mb-5 text-[clamp(1.5rem,4vw,2rem)] leading-[1.15] font-light">
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
                  class="border-border font-body text-text placeholder:text-text-muted focus:border-gold w-full cursor-text rounded-sm border bg-transparent px-4 py-3.5 text-center text-base tracking-[0.1em] uppercase transition-colors duration-200 placeholder:tracking-[0.04em] placeholder:normal-case focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--invite-focus)] disabled:cursor-not-allowed disabled:opacity-50"
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
                <TurnstileWidget onToken={claim.setTurnstileToken} class="flex justify-center" />
                <button
                  type="submit"
                  class="border-gold font-body text-gold hover:bg-gold hover:text-bg disabled:hover:text-gold w-full rounded-sm border bg-transparent px-6 py-3.5 text-[0.88rem] tracking-[0.12em] uppercase transition-colors duration-200 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
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
            <div ref={(el) => (welcomeRef = el)} style={{ display: claimResult() ? "" : "none" }}>
              <Show when={claimResult()?.preview}>
                <p
                  class="border-gold/40 bg-gold/5 text-gold mb-6 rounded-sm border px-4 py-3 text-[0.78rem] tracking-[0.08em] uppercase"
                  role="status"
                >
                  Preview mode. Every event is shown; try the RSVP, nothing you send is saved.
                </p>
              </Show>
              <Show
                when={isIndividual()}
                fallback={
                  <>
                    <h2 class="font-display text-gold mb-3 text-[clamp(1.5rem,4vw,2rem)] leading-[1.15] font-light">
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
                <h2 class="font-display text-gold mb-3 text-[clamp(1.5rem,4vw,2rem)] leading-[1.15] font-light">
                  Dear {individualName()}
                </h2>
                <p class="text-text-muted mb-8 text-[0.92rem] leading-[1.6] font-light">
                  {welcomeMessage()}
                </p>
              </Show>
            </div>
          </div>
        </div>
      </section>

      <Show when={claimResult()}>
        {(data) => (
          <section
            ref={eventsSectionRef}
            class="border-border border-y px-6 py-16 opacity-0 md:px-10 md:py-20"
            // The section paints whichever derived surface its tone names; the
            // `text-gold` / `font-display` / `border-border` utilities on the
            // header and on every EventCard descendant already resolve the
            // organiser's scheme from the root palette.
            style={{
              ...filterThemeVars(detailsVars()),
              "background-color": "var(--invite-section-bg)",
            }}
          >
            <div class="mx-auto max-w-[1200px]">
              <div data-testid="events-column" class="max-w-[960px] text-left">
                <p class="font-body text-gold mb-3 text-[0.72rem] tracking-[0.2em] uppercase">
                  {detailsEyebrow()}
                </p>
                <h2 class="font-display text-text mb-5 text-[clamp(1.75rem,4vw,2.5rem)] leading-[1.15] font-light">
                  {detailsHeading()}
                </h2>
                <hr class="border-border mb-10 h-0 w-full border-t" aria-hidden="true" />
                <div class="flex flex-col gap-5">
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
                          onRespond={setRsvpEvent}
                          onDetails={setDetailsEvent}
                        />
                      </div>
                    )}
                  </For>
                </div>
              </div>
            </div>

            {/* Optional, additive "Link my Pulse account" affordance. Shown only
                post-claim (it lives inside this claimed-state Show), and never in
                preview mode (a host previewing isn't a guest seat to link). Wrapped
                in its own AuthProvider so it can obtain an OSN access token via
                @osn/client without the rest of the guest site depending on OSN
                auth. The component self-hides when linking is disabled (503) or
                unavailable, so it can never break the core invite. */}
            <Show when={!data().preview}>
              <AuthProvider config={{ issuerUrl: OSN_ISSUER_URL }}>
                <PulseAccountLink
                  apiUrl={props.apiUrl}
                  members={data().members}
                  issuerUrl={OSN_ISSUER_URL}
                  turnstileSiteKey={TURNSTILE_SITEKEY}
                />
                <Toaster position="bottom-right" />
              </AuthProvider>
            </Show>
          </section>
        )}
      </Show>

      <Show when={rsvpEvent()}>
        {(event) => (
          <RsvpModal
            event={event()}
            members={claimResult()!.members}
            existingRsvps={claimResult()!.rsvps}
            apiUrl={props.apiUrl}
            // Host preview keeps the RSVP interactive but makes submit a no-op.
            preview={claimResult()!.preview}
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
          />
        )}
      </Show>

      <Show when={detailsEvent()}>
        {(event) => (
          <DetailsModal
            event={event()}
            siteUrl={siteUrl()}
            // Same reasoning as RsvpModal — the event-details sheet follows the
            // "details" section theme.
            themeVars={detailsVars()}
            onClose={() => setDetailsEvent(null)}
          />
        )}
      </Show>
    </>
  );
}
