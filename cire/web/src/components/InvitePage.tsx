import { AuthProvider } from "@osn/client/solid";
import { createEffect, createMemo, createResource, createSignal, Show, For } from "solid-js";
import { Toaster } from "solid-toast";

import { OSN_ISSUER_URL } from "../lib/osn";
import { DetailsModal } from "./DetailsModal";
import { EventCard } from "./EventCard";
import { applyPaletteToRoot, filterThemeVars, type InviteTheme, sectionVars } from "./invite-theme";
import { LoginSection } from "./LoginSection";
import { PulseAccountLink } from "./PulseAccountLink";
import { RsvpModal } from "./RsvpModal";
import type { ClaimResult, EventSummary, RsvpSummary } from "./types";

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
  // Memoised: each map has several consumers (section wrapper + both modals),
  // so compute once per theme change and share a stable object identity.
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

  return (
    <>
      <LoginSection
        apiUrl={props.apiUrl}
        result={claimResult()}
        onClaimed={handleClaimed}
        formRef={(el) => (loginFormRef = el)}
        welcomeRef={(el) => (welcomeRef = el)}
        themeVars={welcomeVars()}
        welcomeMessage={liveInvite().welcomeMessage}
      />

      <Show when={claimResult()}>
        {(data) => (
          <section
            ref={eventsSectionRef}
            class="border-border border-y px-6 py-16 opacity-0 md:px-8 md:py-20"
            // The section paints whichever derived surface its tone names; the
            // `text-gold` / `font-display` / `border-border` utilities on the
            // header and on every EventCard descendant already resolve the
            // organiser's scheme from the root palette.
            style={{
              ...filterThemeVars(detailsVars()),
              "background-color": "var(--invite-section-bg)",
            }}
          >
            <div class="mx-auto max-w-[540px] text-center md:max-w-[640px]">
              <p class="font-body text-gold mb-3 text-[0.72rem] tracking-[0.2em] uppercase">
                {detailsEyebrow()}
              </p>
              <h2 class="font-display text-text mb-5 text-[clamp(2rem,5vw,3rem)] leading-[1.15] font-light">
                {detailsHeading()}
              </h2>
              <div class="flex flex-col gap-5 text-left">
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
                        onRespond={setRsvpEvent}
                        onDetails={setDetailsEvent}
                      />
                    </div>
                  )}
                </For>
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
