import { createResource, createSignal, Show, For } from "solid-js";

import { DetailsModal } from "./DetailsModal";
import { EventCard } from "./EventCard";
import { type InviteTheme, sectionThemeVars } from "./invite-theme";
import { LoginSection } from "./LoginSection";
import { RsvpModal } from "./RsvpModal";
import type { ClaimResult, EventSummary, RsvpSummary } from "./types";

/** Shape of the public invite endpoint we consume — only the theme matters here. */
interface InviteCustomisationResponse {
  theme?: InviteTheme | null;
}

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
}

export default function InvitePage(props: InvitePageProps) {
  const [claimResult, setClaimResult] = createSignal<ClaimResult | null>(null);
  const [rsvpEvent, setRsvpEvent] = createSignal<EventSummary | null>(null);
  const [detailsEvent, setDetailsEvent] = createSignal<EventSummary | null>(null);

  const siteUrl = () =>
    props.siteUrl ?? (typeof window !== "undefined" ? window.location.origin : "");

  // Revalidate the invite customisation on mount so the events section reflects
  // the organiser's latest saved theme. The static guest site bakes the build-
  // time theme into the prop; without this re-fetch a theme change made after the
  // last build would never reach guests until a rebuild (the bug this fixes). The
  // build-time `theme` seeds the resource so first paint is immediate and the
  // no-JS fallback still renders the SSR'd theme. Only fetches when a slug is
  // present; a non-OK / failed revalidation keeps the already-painted theme.
  const [liveTheme] = createResource<InviteTheme | null>(
    async () => {
      if (!props.slug) return props.theme ?? null;
      try {
        const res = await fetch(`${props.apiUrl}/api/invite/${props.slug}`, {
          cache: "no-store",
        });
        if (!res.ok) return props.theme ?? null;
        const body = (await res.json()) as InviteCustomisationResponse;
        return body.theme ?? null;
      } catch {
        return props.theme ?? null;
      }
    },
    { initialValue: props.theme ?? null },
  );

  // Validated CSS-variable map for the "details" section; an unset field falls
  // through to the built-in token via the var() fallbacks below.
  const detailsVars = () => sectionThemeVars(liveTheme() ?? null, "details");

  let loginFormRef: HTMLDivElement;
  let welcomeRef: HTMLDivElement;
  let eventsSectionRef: HTMLElement;

  async function handleClaimed(result: ClaimResult) {
    setClaimResult(result);

    // Wait a tick so SolidJS renders the events section into the DOM
    await new Promise((r) => setTimeout(r, 0));

    if (loginFormRef && welcomeRef && eventsSectionRef) {
      const { unlockRevealSequence } = await import("./UnlockReveal.motion");
      unlockRevealSequence(loginFormRef, welcomeRef, eventsSectionRef);
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
      />

      <Show when={claimResult()}>
        {(data) => (
          <section
            ref={eventsSectionRef}
            class="border-border bg-surface border-y px-6 py-16 opacity-0 md:px-8 md:py-20"
            style={{
              ...detailsVars(),
              "background-color": "var(--invite-surface, var(--color-surface))",
            }}
          >
            <div class="mx-auto max-w-[540px] text-center md:max-w-[640px]">
              <p
                class="font-body text-gold mb-3 text-[0.72rem] tracking-[0.2em] uppercase"
                style={{ color: "var(--invite-accent, var(--color-gold))" }}
              >
                Celebrate With Us
              </p>
              <h2
                class="font-display text-text mb-5 text-[clamp(2rem,5vw,3rem)] leading-[1.15] font-light italic"
                style={{ "font-family": "var(--invite-heading, var(--font-display))" }}
              >
                Your Events
              </h2>
              <div class="flex flex-col gap-5 text-left">
                <For each={data().events}>
                  {(event) => (
                    <div data-event-card>
                      <EventCard
                        event={event}
                        preview={data().preview}
                        onRespond={setRsvpEvent}
                        onDetails={setDetailsEvent}
                      />
                    </div>
                  )}
                </For>
              </div>
            </div>
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
          <DetailsModal event={event()} siteUrl={siteUrl()} onClose={() => setDetailsEvent(null)} />
        )}
      </Show>
    </>
  );
}
