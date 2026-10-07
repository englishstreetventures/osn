import Button from "@cire/ui/button";
import { Modal } from "@shared/ui/ui/modal";
import { createSignal, createUniqueId, onCleanup, onMount, Show } from "solid-js";

import {
  acceptAllConsent,
  claimConsentDialogHost,
  consentPreferencesOpen,
  hydrateConsent,
  needsConsentDecision,
  openConsentPreferences,
  refreshConsentFromDocument,
  rejectAllConsent,
} from "../../lib/consent/store";
import { Z_CLASS } from "../../lib/z-index";
import { ConsentPreferences } from "./ConsentPreferences";

interface ConsentBannerProps {
  /**
   * The form the first-layer prompt takes. `"dialog"` (the default) is a
   * modal the guest must answer, so nothing is left over the page once they
   * have. `"banner"` is a bar along the bottom of the screen that leaves the
   * page readable: the legal pages pass it, because the prompt links to them
   * and a modal there would stand between the guest and the notice they came
   * to read before deciding.
   */
  prompt?: "dialog" | "banner";
}

/**
 * The site-wide consent surface: the first-layer prompt plus the preferences
 * dialog it opens. Mounted once per document shell (each design's
 * `Document.astro`, the gift registry, the 404 page, and the legal layout) as
 * a `client:idle` island, so it costs the invite's first paint nothing.
 *
 * ## Two forms of one prompt
 *
 * On the invite's pages the prompt is a modal dialog at every width, and the
 * guest answers it before the page is theirs: Escape, the back gesture and a
 * tap outside it do nothing to it. Once answered it is gone, and nothing sits
 * over the invite's hero. On the legal pages it is a banner along the bottom
 * of the screen. Both say the same words through the same components, so
 * they cannot drift apart.
 *
 * ## Why the prompt is not shown until the cookie has been read
 *
 * `needsConsentDecision()` is false until {@link hydrateConsent} has run, so a
 * returning guest who already decided never sees the prompt flash on the way
 * to their invite. The trade is that a first-time guest sees it appear a tick
 * after paint rather than in the server-rendered HTML — acceptable, because
 * nothing third-party loads in that tick either: gates sit at the
 * required-only floor until the same hydration completes.
 *
 * A page the browser brings back from its back/forward cache reads the cookie
 * again, because the guest may have answered on the page they are coming back
 * from — the privacy notice, most likely, which the prompt links to.
 *
 * ## The prompt says what is off, and what turns it on
 *
 * Third-party content waits for the guest's yes (see
 * `lib/consent/categories.ts`): nothing of Google's or Pinterest's loads before
 * an answer. The copy names the two companies and what they would see, says
 * the content stays off until allowed, and names the answer that allows it.
 *
 * ## The three actions
 *
 * "Accept necessary" — required storage only, everything optional off — is
 * the highlighted answer and comes first; "Accept all" and "Choose" sit beside
 * it, plainer. Refusing is never harder or quieter than accepting here: it is
 * the easiest thing on the prompt.
 */
export function ConsentBanner(props: ConsentBannerProps) {
  onMount(hydrateConsent);
  onMount(() => {
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) refreshConsentFromDocument();
    };
    window.addEventListener("pageshow", onPageShow);
    onCleanup(() => window.removeEventListener("pageshow", onPageShow));
  });
  const host = claimConsentDialogHost();
  onCleanup(host.release);

  /**
   * Bumped when the platform closes the prompt's dialog without an answer, to
   * mount a fresh one; see {@link PromptDialog}. Starts at 1 because the
   * keyed `Show` below reads it as its condition.
   */
  const [attempt, setAttempt] = createSignal(1);
  // The prompt hides while the preferences dialog is open — that dialog
  // supersedes it and carries its own answers, so showing both would leave
  // two competing sets of controls on screen.
  const prompting = () => needsConsentDecision() && !consentPreferencesOpen();
  const asBanner = () => props.prompt === "banner";

  return (
    <>
      <Show when={prompting() && asBanner()}>
        <BannerPanel />
      </Show>

      <Show when={prompting() && !asBanner() && attempt()} keyed>
        {(_attempt) => <PromptDialog onClosedUnanswered={() => setAttempt((n) => n + 1)} />}
      </Show>

      <Show when={consentPreferencesOpen() && host.owns()}>
        <ConsentPreferences />
      </Show>
    </>
  );
}

/**
 * The prompt as a bar along the bottom of the screen, for the legal pages —
 * which a guest reads to decide, so the bar must not hide any of them.
 *
 * `sticky`, not `fixed`: it is the last box on the page, so it rides the
 * bottom of the screen while the page scrolls under it and comes to rest
 * below the footer at the end, where a fixed bar would cover the last of the
 * notice and the footer's own "Privacy choices" control. And while it is up
 * the page keeps a bottom scroll padding of its height, so whatever Tab moves
 * to is scrolled clear of it rather than under it (WCAG 2.4.11).
 */
function BannerPanel() {
  let panel!: HTMLElement;
  onMount(() => keepScrollPaddingFor(panel));

  return (
    <section
      ref={panel}
      aria-label="Privacy choices"
      class={`sticky bottom-0 ${Z_CLASS.CONSENT} border-border bg-bg/95 border-t px-5 py-4 backdrop-blur-sm`}
    >
      <div class="mx-auto flex max-w-3xl flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <PromptCopy />
        <PromptActions />
      </div>
    </section>
  );
}

/**
 * Keep `<html>`'s bottom scroll padding equal to `el`'s height for as long as
 * the calling owner lives, then remove it. A `ResizeObserver`, because the
 * banner's copy wraps differently at every width and again once the web fonts
 * land. Does nothing where there is no `ResizeObserver` (jsdom).
 */
function keepScrollPaddingFor(el: HTMLElement): void {
  if (typeof ResizeObserver === "undefined") return;
  const root = document.documentElement;
  const observer = new ResizeObserver(() => {
    root.style.scrollPaddingBottom = `${el.getBoundingClientRect().height}px`;
  });
  observer.observe(el);
  onCleanup(() => {
    observer.disconnect();
    root.style.removeProperty("scroll-padding-bottom");
  });
}

/**
 * The prompt as a modal dialog the guest has to answer.
 *
 * Nothing but an answer closes it. `closedby="none"` tells the browser that
 * Escape and the back gesture do not close it, and in a browser that supports
 * the attribute the back gesture then goes back a page, as it does anywhere
 * else. Where `closedby` is not supported, Escape and the back gesture fire a
 * `cancel`, which is refused; where the browser will not let it be refused
 * (it allows that only after the guest has interacted with the page), the
 * dialog closes and `onClose` mounts a fresh one at once. In such a browser
 * the back gesture therefore does nothing until the guest answers.
 * `dismissable={false}` makes a tap on the backdrop do nothing.
 *
 * Mounted and unmounted by a `Show`, with `open` always true — the form
 * `Modal`'s own notes warn loses the exit animation. Chosen anyway, as
 * `ConsentPreferences` is: "Choose" swaps this dialog for the preferences one
 * in a single update, and unmounting closes this one before the other calls
 * `showModal()`, so there is never a second modal dialog in the top layer.
 * An unmount does not fire `onClose`, so an answer never reopens it.
 *
 * The heading takes the initial focus. Never an answer — focus resting on one
 * is a nudge — and never a link, where a stray Enter would leave the page. A
 * screen reader hears the dialog's name and the notice first.
 */
function PromptDialog(props: { onClosedUnanswered: () => void }) {
  const titleId = createUniqueId();
  const copyId = createUniqueId();

  return (
    <Modal
      open
      onClose={props.onClosedUnanswered}
      dismissable={false}
      closedby="none"
      onCancel={(event) => event.preventDefault()}
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

/**
 * What the prompt says, in either form. It links to both legal pages because
 * the dialog form blocks the footer that otherwise carries them; both pages
 * show the banner, never the dialog.
 */
function PromptCopy(props: { id?: string }) {
  return (
    <p id={props.id} class="font-body text-text-muted text-ui-sm leading-relaxed">
      We use a little storage to keep you signed in to your invite. Some parts — the venue map and
      the Pinterest moodboard — load from Google and Pinterest, who can see your IP address and
      browser, so they stay off until you allow them. “Accept all” turns them on; you can change
      this any time from the footer.{" "}
      <a href="/privacy" class="text-gold-ink underline underline-offset-2">
        Privacy notice
      </a>
      {" · "}
      <a href="/terms" class="text-gold-ink underline underline-offset-2">
        Terms
      </a>
    </p>
  );
}

/**
 * The three answers, in either form. "Accept necessary" is the highlighted
 * one, in the guest site's call-to-action style (`cta`: a gold outline whose
 * ink the palette derivation holds at 4.5:1, filling on hover). The other two
 * share the plainer `quiet` style. A button filled at rest is deliberately
 * not used: the derivation only holds the gold fill at 3:1 against the page
 * ground, too little for small text in the ground's colour.
 */
function PromptActions() {
  return (
    <div class="flex shrink-0 flex-wrap gap-2">
      <Button variant="cta" size="sm" onClick={rejectAllConsent}>
        Accept necessary
      </Button>
      <Button variant="quiet" size="sm" onClick={acceptAllConsent}>
        Accept all
      </Button>
      <Button variant="quiet" size="sm" onClick={openConsentPreferences}>
        Choose
      </Button>
    </div>
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
