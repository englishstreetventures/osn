import { onCleanup, onMount, Show } from "solid-js";

import {
  acceptAllConsent,
  claimConsentDialogHost,
  consentPreferencesOpen,
  hydrateConsent,
  needsConsentDecision,
  openConsentPreferences,
  rejectAllConsent,
} from "../../lib/consent/store";
import { Z_CLASS } from "../../lib/z-index";
import { ConsentPreferences } from "./ConsentPreferences";

/**
 * The site-wide consent surface: the first-layer banner plus the preferences
 * dialog it opens. Mounted once per document shell (each design's
 * `Document.astro`, the legal layout, and the 404 page) as a `client:idle`
 * island, so it costs the invite's first paint nothing.
 *
 * ## Why the banner is not shown until the cookie has been read
 *
 * `needsConsentDecision()` is false until {@link hydrateConsent} has run, so a
 * returning guest who already decided never sees the banner flash on the way to
 * their invite. The trade is that a first-time guest sees it appear a tick after
 * paint rather than in the server-rendered HTML — acceptable, because nothing
 * third-party loads in that tick either: gates sit at the required-only floor
 * until the same hydration completes, whatever the opt-out defaults say.
 *
 * ## The banner has to be honest that things are already on
 *
 * The optional categories are opt-out (see `lib/consent/categories.ts`), so by
 * the time a guest reads this banner the venue map and the moodboard are
 * already loading. The copy therefore states that plainly and names the two
 * companies, rather than asking a question whose answer has been assumed. A
 * banner that said "may we?" while the request had already gone would be the
 * worst of both postures: no prior consent AND a misleading account of it.
 *
 * ## The three actions
 *
 * "Accept all" and "Reject all" are rendered as visual peers, and a refusal is
 * a single click from exactly the same place as an acceptance. Making refusal
 * slower, quieter or more buried than acceptance is the standard way a consent
 * banner stops collecting consent and starts manufacturing it, and it is worth
 * being explicit that this one does not: same size, same row, same styling.
 * That matters more under opt-out, not less — the off switch is the only thing
 * a guest who disagrees with the default actually has.
 */
export function ConsentBanner() {
  onMount(hydrateConsent);
  const host = claimConsentDialogHost();
  onCleanup(host.release);

  return (
    <>
      {/* The banner hides while the dialog is open — the dialog supersedes it
          and carries its own Accept/Reject actions, so showing both would leave
          two competing sets of controls on screen. */}
      <Show when={needsConsentDecision() && !consentPreferencesOpen()}>
        <section
          aria-label="Privacy choices"
          class={`fixed inset-x-0 bottom-0 ${Z_CLASS.CONSENT} border-border bg-bg/95 border-t px-5 py-4 backdrop-blur-sm`}
        >
          <div class="mx-auto flex max-w-3xl flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <p class="font-body text-text-muted text-[0.78rem] leading-relaxed">
              We use a little storage to keep you signed in to your invite. Some parts — the venue
              map and the Pinterest moodboard — are loaded from Google and Pinterest, who can see
              your IP address and browser. That's switched on; you can turn it off here, or any time
              from the footer.{" "}
              <a href="/privacy" class="text-gold-ink underline underline-offset-2">
                Privacy notice
              </a>
            </p>

            <div class="flex shrink-0 flex-wrap gap-2">
              <BannerButton onClick={rejectAllConsent}>Reject all</BannerButton>
              <BannerButton onClick={acceptAllConsent}>Accept all</BannerButton>
              <BannerButton onClick={openConsentPreferences}>Choose</BannerButton>
            </div>
          </div>
        </section>
      </Show>

      <Show when={consentPreferencesOpen() && host.owns()}>
        <ConsentPreferences />
      </Show>
    </>
  );
}

/**
 * All three banner actions share one component and therefore one set of styles.
 * That is the point: it makes it structurally awkward to give "Accept all" a
 * visual advantage over "Reject all" in a later tweak, because doing so means
 * deliberately breaking them apart rather than quietly passing a `primary` prop.
 */
function BannerButton(props: { onClick: () => void; children: string }) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      class="border-gold text-gold-ink hover:bg-gold hover:text-bg focus-visible:ring-gold/60 rounded-sm border px-4 py-1.5 text-[0.7rem] tracking-[0.12em] uppercase transition-colors duration-200 focus:outline-none focus-visible:ring-2"
    >
      {props.children}
    </button>
  );
}

/**
 * The standing "change your mind" entry point, for the site footer and the
 * privacy page. Withdrawing consent has to be as easy as giving it, which means
 * a permanent, findable control — not a banner that only ever appears once,
 * before the guest has any idea what they are agreeing to.
 */
export function ConsentPreferencesLink(props: { label?: string; class?: string }) {
  onMount(hydrateConsent);
  // Claims the dialog only if no banner already owns it, so a page carrying
  // both never renders two dialogs with two competing drafts.
  const host = claimConsentDialogHost();
  onCleanup(host.release);

  return (
    <>
      <button
        type="button"
        onClick={openConsentPreferences}
        class={props.class ?? "font-body text-inherit underline-offset-2 hover:underline"}
      >
        {props.label ?? "Privacy choices"}
      </button>
      {/* The dialog is rendered here too, so this link works on a page where the
          banner island is absent or has already been dismissed by a decision —
          but only when this component is the claimed host (see above). */}
      <Show when={consentPreferencesOpen() && host.owns()}>
        <ConsentPreferences />
      </Show>
    </>
  );
}
