import Button from "@cire/ui/button";
import { Modal } from "@shared/ui/ui/modal";
import { type Accessor, createSignal, createUniqueId, onCleanup, onMount, Show } from "solid-js";

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
import { publishBannerHeight } from "./banner-height";
import { ConsentPreferences } from "./ConsentPreferences";

/**
 * The width from which the first-layer prompt is the bottom banner: Tailwind's
 * `md` breakpoint, 48rem. Below it the app treats the screen as a phone — the
 * hero swaps in its phone image, and every sheet is bottom-anchored — and the
 * prompt is a modal dialog instead. `@cire/ui`'s dietary picker forks on the
 * same query. `rem` in a media query is the initial 16px, so the root's step
 * to 17px at 1024px does not move it.
 */
const WIDE_QUERY = "(min-width: 48rem)";

/**
 * Whether the window is at least {@link WIDE_QUERY} wide, kept current as it is
 * resized or rotated. Wide where `matchMedia` does not exist (jsdom, the
 * server), which is the banner — and the server renders no prompt at all,
 * since none is owed until the cookie has been read.
 */
function createIsWide(): Accessor<boolean> {
  const [wide, setWide] = createSignal(true);
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return wide;
  const query = window.matchMedia(WIDE_QUERY);
  setWide(query.matches);
  const onChange = (event: MediaQueryListEvent) => setWide(event.matches);
  query.addEventListener("change", onChange);
  onCleanup(() => query.removeEventListener("change", onChange));
  return wide;
}

interface ConsentBannerProps {
  /**
   * How the prompt asks below the `md` breakpoint. `"modal"` (the default) is
   * a dialog, so nothing is left over the page once the guest has answered.
   * `"banner"` keeps the bottom banner at every width: the legal pages pass
   * it, because the prompt links to `/privacy` and a modal there would stand
   * between the guest and the notice it links to.
   */
  phone?: "modal" | "banner";
}

/**
 * The site-wide consent surface: the first-layer prompt plus the preferences
 * dialog it opens. Mounted once per document shell (each design's
 * `Document.astro`, the gift registry, the legal layout, and the 404 page) as
 * a `client:idle` island, so it costs the invite's first paint nothing.
 *
 * ## Two forms of one prompt
 *
 * From the `md` breakpoint up the prompt is the banner fixed to the bottom of
 * the screen. Below it, it is a modal dialog: a banner on a phone covers the
 * bottom of the invite's hero, which is where the gala pack sets the couple's
 * name. Both say the same words through the same components, so they cannot
 * drift apart.
 *
 * A dismissal of the dialog — Escape, Android's back gesture, a tap on the
 * backdrop — is not an answer. It records nothing, and the prompt carries on
 * as the banner for the rest of the page view, at every width: the optional
 * categories are on by default, so this notice is the guest's only sight of
 * that, and it stays until they decide.
 *
 * ## Why the prompt is not shown until the cookie has been read
 *
 * `needsConsentDecision()` is false until {@link hydrateConsent} has run, so a
 * returning guest who already decided never sees the prompt flash on the way
 * to their invite. The trade is that a first-time guest sees it appear a tick
 * after paint rather than in the server-rendered HTML — acceptable, because
 * nothing third-party loads in that tick either: gates sit at the
 * required-only floor until the same hydration completes, whatever the
 * opt-out defaults say.
 *
 * ## The prompt has to be honest that things are already on
 *
 * The optional categories are opt-out (see `lib/consent/categories.ts`), so by
 * the time a guest reads this prompt the venue map and the moodboard are
 * already loading. The copy therefore states that plainly and names the two
 * companies, rather than asking a question whose answer has been assumed. A
 * prompt that said "may we?" while the request had already gone would be the
 * worst of both postures: no prior consent AND a misleading account of it.
 *
 * ## The three actions
 *
 * "Accept all" and "Reject all" are rendered as visual peers, and a refusal is
 * a single click from exactly the same place as an acceptance. Making refusal
 * slower, quieter or more buried than acceptance is the standard way a consent
 * prompt stops collecting consent and starts manufacturing it, and it is worth
 * being explicit that this one does not: same size, same row, same styling, in
 * both forms. That matters more under opt-out, not less — the off switch is
 * the only thing a guest who disagrees with the default actually has.
 */
export function ConsentBanner(props: ConsentBannerProps) {
  onMount(hydrateConsent);
  const host = claimConsentDialogHost();
  onCleanup(host.release);

  const wide = createIsWide();
  const [dismissed, setDismissed] = createSignal(false);
  const asDialog = () => props.phone !== "banner" && !wide() && !dismissed();
  // The prompt hides while the preferences dialog is open — that dialog
  // supersedes it and carries its own Accept/Reject actions, so showing both
  // would leave two competing sets of controls on screen.
  const prompting = () => needsConsentDecision() && !consentPreferencesOpen();

  return (
    <>
      <Show when={prompting() && !asDialog()}>
        <BannerPanel />
      </Show>

      <Show when={prompting() && asDialog()}>
        <PromptDialog onDismiss={() => setDismissed(true)} />
      </Show>

      <Show when={consentPreferencesOpen() && host.owns()}>
        <ConsentPreferences />
      </Show>
    </>
  );
}

/**
 * The first-layer banner itself. Its own component so that its height is
 * published (`banner-height.ts`) exactly while it is mounted: the `Show` above
 * disposes it on a decision and while the preferences dialog is open, and the
 * published height goes with it. The prompt's dialog form publishes nothing,
 * so on a phone the hero's scroll cue stays where it rests.
 */
function BannerPanel() {
  let panel!: HTMLElement;
  onMount(() => publishBannerHeight(panel));

  return (
    <section
      ref={panel}
      aria-label="Privacy choices"
      class={`fixed inset-x-0 bottom-0 ${Z_CLASS.CONSENT} border-border bg-bg/95 border-t px-5 py-4 backdrop-blur-sm`}
    >
      <div class="mx-auto flex max-w-3xl flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <PromptCopy />
        <PromptActions />
      </div>
    </section>
  );
}

/**
 * The prompt as a modal dialog, for a phone.
 *
 * Mounted and unmounted by the `Show` in {@link ConsentBanner}, with `open`
 * always true — the form `Modal`'s own notes warn loses the exit animation.
 * Chosen anyway, as `ConsentPreferences` is: "Choose" swaps this dialog for
 * the preferences one in a single update, and unmounting closes this one
 * before the other calls `showModal()`, so there is never a second modal
 * dialog in the top layer — one fading out while the guest uses the other.
 * An answer therefore closes it without the exit; the entry still plays.
 *
 * `onClose` reaches here only for a dismissal (Escape, the back gesture, a
 * backdrop tap): an unmount does not fire it.
 *
 * The heading takes the initial focus. Never "Accept all" or "Reject all" —
 * focus resting on one of them is a nudge — and never the privacy link, where
 * a stray Enter would leave the page. A screen reader hears the dialog's name
 * and the notice first.
 */
function PromptDialog(props: { onDismiss: () => void }) {
  const titleId = createUniqueId();
  const copyId = createUniqueId();

  return (
    <Modal
      open
      onClose={props.onDismiss}
      labelledBy={titleId}
      aria-describedby={copyId}
      presentation="sheet"
      // The same width as the preferences sheet it hands over to on "Choose".
      class="max-w-lg"
    >
      <h2
        id={titleId}
        // Focusable only so the dialog can open on it; it is not a control,
        // and it is never in the Tab order.
        tabindex="-1"
        autofocus
        class="font-display text-text text-ui-lg leading-tight font-light focus:outline-none"
      >
        Privacy choices
      </h2>
      <div class="mt-2">
        <PromptCopy id={copyId} />
      </div>
      <div class="mt-5">
        <PromptActions />
      </div>
    </Modal>
  );
}

/** What the prompt says, in either form. */
function PromptCopy(props: { id?: string }) {
  return (
    <p id={props.id} class="font-body text-text-muted text-ui-sm leading-relaxed">
      We use a little storage to keep you signed in to your invite. Some parts — the venue map and
      the Pinterest moodboard — are loaded from Google and Pinterest, who can see your IP address
      and browser. That's switched on; you can turn it off here, or any time from the footer.{" "}
      <a href="/privacy" class="text-gold-ink underline underline-offset-2">
        Privacy notice
      </a>
    </p>
  );
}

/** The three answers, in either form: refusal first, beside acceptance. */
function PromptActions() {
  return (
    <div class="flex shrink-0 flex-wrap gap-2">
      <BannerButton onClick={rejectAllConsent}>Reject all</BannerButton>
      <BannerButton onClick={acceptAllConsent}>Accept all</BannerButton>
      <BannerButton onClick={openConsentPreferences}>Choose</BannerButton>
    </div>
  );
}

/**
 * All three prompt actions share one component and therefore one set of styles.
 * That is the point: it makes it structurally awkward to give "Accept all" a
 * visual advantage over "Reject all" in a later tweak, because doing so means
 * deliberately breaking them apart rather than quietly passing a `primary` prop.
 */
function BannerButton(props: { onClick: () => void; children: string }) {
  return (
    <Button variant="cta" size="sm" onClick={props.onClick}>
      {props.children}
    </Button>
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
