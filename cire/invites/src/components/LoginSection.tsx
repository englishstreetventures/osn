import Button from "@cire/ui/button";
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  lazy,
  onMount,
  Show,
  Suspense,
} from "solid-js";

import { createClaimCode } from "./claim-code";
import { hasClaimedHint, hasPlusOneHint, noteClaimed, signOut } from "./claim-session";
import {
  chooseMember,
  chosenMember,
  hasMemberStep,
  notYou,
  withChosenMember,
  withoutMember,
} from "./household-member";
import { filterThemeVars } from "./invite-theme";
import { invitedMembers, isPlusOne } from "./plus-one";
import type { RsvpDeadlineState } from "./rsvp-deadline";
import { RsvpDeadlineNotice } from "./RsvpDeadlineNotice";
import { TurnstileWidget, turnstileEnabled, type TurnstileControls } from "./TurnstileWidget";
import type { AccountLinkState, ClaimResult } from "./types";
import { readAccountLink } from "./utils";

// Account linking, split out of the invite's first download. Most households
// never link an account, and nothing here renders before a claim, so a visitor
// who never submits a code never downloads it — nor the OSN auth client it
// imports. Module scope, so every render shares one promise and therefore one
// chunk. A `.then` adapter because `lazy` wants a default export and this one
// is named.
const PulseAccountLink = lazy(() =>
  import("./PulseAccountLink").then((m) => ({ default: m.PulseAccountLink })),
);

// The plus-one prompt, split out for the same reason: most households are
// never allowed a guest, and nothing here renders it before a claim.
const PlusOnePrompt = lazy(() =>
  import("./PlusOnePrompt").then((m) => ({ default: m.PlusOnePrompt })),
);

/**
 * Start downloading the household's controls — the account link and, when
 * asked, the plus-one prompt — without rendering either. Called as a claim or
 * a session restore begins, so the chunks arrive while that request is in
 * flight: the controls sit above the events, and the claim payload carries
 * everything else they need, so the chunks are the only thing they could wait
 * for. Idempotent — `lazy` keeps one promise per chunk. A failed download is
 * left for the render to meet, inside its own Suspense boundary.
 */
function warmHouseholdControls(plusOne: boolean): void {
  void PulseAccountLink.preload().catch(() => {});
  if (plusOne) void PlusOnePrompt.preload().catch(() => {});
}

/** Whether a household with these members is offered the plus-one prompt:
 *  someone may bring a guest, or one is named. */
function hasPlusOneToOffer(result: ClaimResult): boolean {
  return result.members.some((m) => m.plusOneAllowed === true || isPlusOne(m));
}

/**
 * How the claim and welcome panel sits on the page. The two values are the
 * words the organiser's design preview uses for the same section
 * (`cire/host/src/components/invite/design-layout.ts`).
 *
 * - `band` — a full-bleed section on a centred column (classic).
 * - `panel` — an inset bordered card, centred on phones and flush with the
 *   page's left gutter from `md` up (gala).
 */
export type LoginSectionLayout = "band" | "panel";

/**
 * Everything that differs between the layouts. The markup is shared; a layout
 * only chooses these class strings. Whole literals, because Tailwind builds its
 * stylesheet by scanning source text and would emit nothing for a class name
 * assembled at runtime.
 */
interface LayoutClasses {
  section: string;
  column: string;
  /** The inset card, or `null` when the section itself is the surface. */
  card: string | null;
  /**
   * The heading size curve. Weight, style and the size multiplier come from
   * the organiser's heading typography in every layout.
   */
  headingSize: string;
  /**
   * The greeting's gold. The metal (`--color-gold`) is held only to the 3:1
   * UI floor, so it may paint a heading only where WCAG counts the text as
   * large: the band's greeting starts at 2rem, and at the organiser's smallest
   * heading scale (0.85) that is 27.2px, over the 24px bar. The panel's starts
   * at 1.5rem, which is not large text, so it takes the ink gold.
   */
  greeting: string;
  form: string;
  /** Width and centring for the preview chip, the RSVP-by line and the account link. */
  measure: string;
}

const LAYOUTS = {
  band: {
    section: "border-border border-b px-6 py-16 md:px-8 md:py-20",
    column: "max-w-column-lg md:max-w-column-xl mx-auto text-center",
    card: null,
    headingSize: "text-[calc(clamp(2rem,5vw,3rem)*var(--invite-heading-scale,1))]",
    greeting: "text-gold",
    form: "max-w-column-2xs mx-auto",
    measure: "max-w-column-sm mx-auto",
  },
  panel: {
    section: "px-6 py-16 md:px-10 md:py-20",
    // The page's widest container, so the card's `md:mx-0` lands on the same
    // left edge as the events column below it.
    column: "max-w-column-4xl mx-auto",
    card: "border-border max-w-column-xs mx-auto rounded-sm border px-7 py-10 md:mx-0",
    headingSize: "text-[calc(clamp(1.5rem,4vw,2rem)*var(--invite-heading-scale,1))]",
    greeting: "text-gold-ink",
    form: "",
    measure: "",
  },
} satisfies Record<LoginSectionLayout, LayoutClasses>;

/** What every heading here shares, whatever the layout. */
const HEADING =
  "font-display leading-ui-none [font-weight:var(--invite-heading-weight,300)] [font-style:var(--invite-heading-style,normal)]";

interface LoginSectionProps {
  apiUrl: string;
  result: ClaimResult | null;
  /**
   * Called once a code has been claimed, after this panel has recorded the
   * household session hint (`noteClaimed`). The page owns what follows: the
   * result, and the unlock choreography.
   */
  onClaimed: (result: ClaimResult) => void;
  /** Absent ⇒ `band`. */
  layout?: LoginSectionLayout;
  /**
   * Which half of this section is on screen: `false` ⇒ the code form, `true` ⇒
   * the welcome banner. Absent ⇒ derived from `result`, i.e. the plain instant
   * swap, which is what a caller that doesn't choreograph the unlock wants.
   *
   * It is a separate signal from `result` because the swap is CHOREOGRAPHED: the
   * form fades out before it leaves the layout, so it has to stay displayed for
   * the length of that fade — a beat after the claim has already resolved. This
   * prop is the single owner of both elements' `display`; the motion sequence
   * reports when to flip it and never writes `display` itself — see the
   * `RevealHooks` note in each design pack's `UnlockReveal.motion.ts` for why
   * an imperative write there would desynchronise this binding permanently.
   */
  revealed?: boolean;
  formRef?: (el: HTMLDivElement) => void;
  welcomeRef?: (el: HTMLDivElement) => void;
  /**
   * Validated CSS-variable map for the "welcome" theme section
   * (`sectionVars(theme, "welcome")`) — which derived surface the code-entry
   * form and post-claim welcome banner sit on. The colours themselves come from
   * the palette at the document root. Empty/absent ⇒ the page ground. The
   * layout decides which element paints it: the whole band, or only the card.
   */
  themeVars?: Record<string, string>;
  /**
   * Organiser override for the post-claim greeting line shown under the family
   * or guest name. Absent/null ⇒ the built-in default greeting.
   */
  welcomeMessage?: string | null;
  /**
   * Where the wedding's RSVP deadline stands, derived once by the page so this
   * panel, every Respond button and the RSVP sheet read one verdict.
   *
   * The state alone, not the sentence: the deadline itself is already on
   * `result`, so passing both would let the words and the treatment disagree.
   * Absent/null ⇒ no deadline copy, which is what a wedding without one gets.
   */
  rsvpDeadlineState?: RsvpDeadlineState | null;
  /**
   * Called when the household signs out — a shared device, or a code that
   * opened the wrong family's invite. By then this panel has already revoked
   * `cire_session` server-side, dropped the restore hint, reset its form and
   * cleared what the unlock animation left on it. The page resets its own
   * state here (`result`, `revealed`), so the form is displayed again by the
   * time this panel moves focus to it.
   *
   * Absent ⇒ no control is rendered, since without a handler nothing would
   * swap the view back.
   */
  onSignOut?: () => void;
  /**
   * Apply a plus-one change to the page's claim result. The panel's plus-one
   * prompt names, renames and removes the household's guests through the API
   * and hands each change here as an update, so the Respond dialog and the
   * cards read it from the page's one copy.
   *
   * Absent ⇒ no prompt, since nothing would carry its changes to the page.
   */
  onPlusOneChange?: (update: (result: ClaimResult) => ClaimResult) => void;
  /**
   * Apply a household-member change to the page's claim result: a member
   * chosen ("Who are you?"), cleared ("Not you?"), or linked to a musubi
   * account. The RSVP sheet reads the member from the page's one copy.
   *
   * Absent ⇒ no member step and no account link, since nothing would carry
   * their changes to the page.
   */
  onMemberChange?: (update: (result: ClaimResult) => ClaimResult) => void;
}

// The built-in post-claim greeting, used when the organiser hasn't overridden it.
const DEFAULT_WELCOME_MESSAGE = "We are delighted to invite you to celebrate with us.";

/**
 * The claim and welcome panel, shared by every design pack: the code entry
 * before a claim, and after it the greeting and the household's controls —
 * account linking and sign-out. A pack chooses a `layout` and passes its data;
 * it draws none of this markup itself.
 */
export function LoginSection(props: LoginSectionProps) {
  const layout = () => LAYOUTS[props.layout ?? "band"];

  const claim = createClaimCode({
    apiUrl: props.apiUrl,
    result: () => props.result,
    onClaimed: (result) => {
      props.onClaimed(result);
      // Mark this browser as holding a household session, so the next visit
      // restores instead of asking for the code again, and so a first-time
      // visitor never spends a request on a guaranteed 401. After the page's
      // handler, so its result is set before other islands hear of the claim.
      // The hint also records whether this claim shows the plus-one prompt, so
      // a restore warms that chunk only for a household that uses it.
      noteClaimed(
        props.onPlusOneChange !== undefined && result.preview !== true && hasPlusOneToOffer(result),
      );
    },
  });

  // Warm the controls the moment a claim is under way — a typed code or the
  // `?code=` deep link — so they are ready when the result lands. Nothing is
  // known about the household yet, so the plus-one prompt is warmed too. A
  // host preview arrives this way and shows neither; that costs the organiser
  // one small download, which is cheaper than waiting to know.
  createEffect(() => {
    if (claim.loading()) warmHouseholdControls(true);
  });
  // A returning household: the restore hint says the page's session restore
  // is about to open the invite without a code, so warm the controls beside
  // that request — the plus-one prompt only when the claim behind the hint
  // showed it.
  onMount(() => {
    if (hasClaimedHint()) warmHouseholdControls(hasPlusOneHint());
  });

  // Falls back to `result` so the section still swaps for a caller that passes
  // no `revealed` — and it is only ever READ here, never written, so this
  // component cannot latch itself into either half.
  const showWelcome = () => props.revealed ?? props.result !== null;

  // A claim code can cover one guest or a whole household. A single-guest code
  // greets the person individually ("Dear {name}"); a multi-guest code greets
  // the household ("The {familyName} Family"). For an individual, an optional
  // nickname overrides their first name. The greeting counts the people the
  // couple invited: a guest who names a plus-one is still one guest.
  const members = () => props.result?.members ?? [];
  // The account-link state the payload carries, or null when there is no box
  // to draw: linking off, a host preview, or an API that did not send it.
  const accountLink = () =>
    props.result && !props.result.preview ? readAccountLink(props.result.accountLink) : null;
  // The member step ("Who are you?"): on when the payload carries `member`
  // and the page can take its changes.
  const memberStep = () => props.onMemberChange !== undefined && hasMemberStep(props.result);
  const chosen = () => chosenMember(props.result);
  const [choosing, setChoosing] = createSignal(false);
  const [memberError, setMemberError] = createSignal<string | null>(null);

  function updateResult(update: (result: ClaimResult) => ClaimResult) {
    props.onMemberChange?.(update);
  }

  async function pickMember(guestId: string) {
    setMemberError(null);
    setChoosing(true);
    const answer = await chooseMember(props.apiUrl, guestId);
    setChoosing(false);
    if (answer === null) {
      setMemberError("Couldn't save that. Please try again.");
      return;
    }
    updateResult((result) => withChosenMember(result, guestId, answer.accountLink));
  }

  const [clearing, setClearing] = createSignal(false);
  const [notYouError, setNotYouError] = createSignal<string | null>(null);

  async function handleNotYou() {
    if (clearing()) return;
    setNotYouError(null);
    setClearing(true);
    // Back to "Who are you?" only once the server has dropped the member and
    // the musubi sign-in; otherwise a reload would bring the last person back.
    const done = await notYou(props.apiUrl);
    setClearing(false);
    if (!done) {
      setNotYouError("Couldn't sign you out. Please try again.");
      return;
    }
    updateResult(withoutMember);
  }

  // A link or unlink changes which seats are linked and whether the account
  // the box shows is the member's own.
  function setLinked(guestId: string, linked: boolean) {
    updateResult((result) => {
      const link = readAccountLink(result.accountLink);
      if (!link) return result;
      const others = link.linkedGuestIds.filter((id) => id !== guestId);
      const next: AccountLinkState & { enabled: true } = {
        enabled: true,
        signedIn: link.signedIn,
        linkedGuestIds: linked ? [...others, guestId] : others,
      };
      if (link.account) next.account = { ...link.account, matchesMember: linked };
      return { ...result, accountLink: next };
    });
  }
  const invited = () => invitedMembers(members());
  const isIndividual = () => invited().length === 1;
  const individualName = () => {
    const m = invited()[0];
    if (!m) return "";
    return m.nickname?.trim() ? m.nickname.trim() : m.firstName;
  };

  // Whether this household has a plus-one prompt: someone may bring a guest,
  // or one is named. A household with neither never renders it (its chunk is
  // still warmed as a claim starts, before anyone knows, but not on a restore
  // whose hint says it was not shown). Never in host preview. Once shown it stays for
  // that household (by code), even when a removal leaves nothing to offer —
  // the prompt still holds that removal's confirmation and the focus.
  let plusOneShownFor: string | null = null;
  const offersPlusOne = createMemo(() => {
    const result = props.result;
    if (result === null || result.preview === true) return false;
    if (hasPlusOneToOffer(result)) {
      plusOneShownFor = result.publicId;
      return true;
    }
    return plusOneShownFor === result.publicId;
  });

  // "Not the Okafor family? Sign out" when we know who they are, so the control
  // names the household it ends rather than describing a mechanism. Falls back
  // to the plain label when the payload has no usable name.
  const signOutLabel = () => {
    const name = isIndividual() ? individualName() : props.result?.familyName;
    return name?.trim() ? `Not ${name.trim()}? Sign out` : "Sign out";
  };

  // The welcome tone: the band paints it across the section, the panel only on
  // its card. Every gold/font utility inside (eyebrow labels, headings, the
  // input's focus border, the submit button and its hover fill, the preview
  // chip) already resolves the organiser's scheme from the root palette, hover
  // and focus states included, so this chooses only the surface.
  const surface = () => ({
    ...filterThemeVars(props.themeVars),
    "background-color": "var(--invite-section-bg)",
  });

  let formEl: HTMLDivElement | undefined;
  let codeInputRef: HTMLInputElement | undefined;
  let turnstile: TurnstileControls | undefined;

  function handleSignOut() {
    const household = props.result;
    // Revoke `cire_session` server-side and drop the local restore hint. The
    // cookie is HttpOnly and host-scoped to the API origin, so only this
    // request can end it. Fire-and-forget: a guest on a borrowed phone tapping
    // this must see the invite go now, not after a network timeout, and the
    // request carries its own cookie, so nothing below depends on its result.
    void signOut(props.apiUrl);
    // End the OSN sign-in the account link uses as well: `cire_session` does
    // not cover it, and a shared device would otherwise hand it to the next
    // household, which could then bind one of its seats to this guest's
    // account. Not in host preview, where there is no account link and the
    // same session is the organiser's sign-in to the host portal. Imported on
    // demand, like the account link, so the invite's first download stays
    // free of the auth client; fire-and-forget for the reason above.
    if (household && !household.preview) {
      void import("@shared/rp-auth")
        .then((auth) => auth.signOut({ apiBase: props.apiUrl }))
        .catch(() => {});
    }
    // Return the form to a submittable state: blank field (it would otherwise
    // reappear pre-filled with the code that just succeeded), no stale error,
    // no stuck `loading`, no spent Turnstile token.
    claim.reset();
    // Re-challenge so a fresh single-use token can replace the one the
    // previous claim redeemed. No-op when Turnstile is unconfigured.
    turnstile?.reset();
    // The packs' unlock sequence fades the form out with Motion, which leaves
    // its end state inline on this wrapper (`opacity: 0` and a `translateY`).
    // The binding here owns only `display`, so nothing else clears them, and
    // the form would come back fully transparent. Writing these two is safe
    // where writing `display` would not be: no binding owns them, so there is
    // nothing to desynchronise.
    if (formEl) {
      formEl.style.opacity = "";
      formEl.style.transform = "";
    }
    // Let the page swap the view back BEFORE focusing — the form is
    // `display: none` until it does, and `focus()` on a hidden element is
    // silently dropped.
    props.onSignOut?.();
    // The click removes the focused button from the accessibility tree,
    // which would drop focus to `<body>` and leave a keyboard or screen-reader
    // user at the top of the document with no signal that the form is back.
    // The code input is both the announcement (it has an accessible name) and
    // the obvious next action.
    codeInputRef?.focus();
  }

  const body = () => (
    <>
      {/* Login form — visible before claim */}
      <div
        ref={(el) => {
          formEl = el;
          props.formRef?.(el);
        }}
        style={{ display: showWelcome() ? "none" : "" }}
      >
        <p class="font-body text-gold-ink text-ui-xs tracking-ui-widest mb-3 uppercase">
          Your Invitation
        </p>
        <h2 class={`${HEADING} text-text mb-5 ${layout().headingSize}`}>Enter Your Code</h2>
        <p class="text-text-muted text-ui-base leading-ui-normal mb-8 font-light">
          Enter the code from your invitation to see your events.
        </p>
        <form class={`flex flex-col gap-3 ${layout().form}`} onSubmit={claim.handleSubmit}>
          {/* maxLength 48 comfortably fits the worst-case code: SURNAME(16) +
              "-" + longest word(10) + "-" + secure hash "XXXXX-XXXXX"(11) = 39
              chars, so a long code like THENGUYENFAMILY-BANISTER-DM65HQ (31) is
              never truncated. The server still validates the code. */}
          <input
            type="text"
            ref={codeInputRef}
            // A border tint alone is too quiet to mark focus on the page's
            // one input; the ring keeps keyboard users oriented. Text cursor
            // on a text field — the pointer belongs on buttons only.
            //
            // The fill and the border are both drawn from `--color-text` (the
            // scheme's ink) at alpha rather than from a surface token, because
            // the organiser picks which surface this section sits on
            // (`welcome_tone`: ground / card / raised). A fixed token would be
            // invisible on the tone that happens to match it; ink-at-alpha is
            // one step away from WHATEVER is behind it on every palette, and
            // in the right direction — it darkens a light scheme and lightens
            // a dark one.
            //
            // `border-border` — the same ink at 0.12 — measured 1.27:1 against
            // this section on the live invite, so the field read as flat page
            // (and as a twin of the outlined submit button below it). WCAG 2.1
            // SC 1.4.11 asks **3:1** of the visual boundary that identifies a
            // control, and this is the guest site's only input, so under the
            // bar is not an option. 0.55 is the lowest alpha that clears it on
            // the WORST preset/tone pair — garden/ground at 3.23:1, measured
            // by compositing over every `PALETTE_PRESETS` entry × all three
            // tones in a real browser. The fill stays deliberately faint
            // (~1.09:1): it only has to read as a well, the border is what the
            // standard governs.
            class="border-text/55 bg-text/[0.045] font-body text-text placeholder:text-text-muted focus:border-gold tracking-ui-wider placeholder:tracking-ui-wide w-full cursor-text rounded-sm border px-4 py-3.5 text-center text-base uppercase transition-colors duration-200 placeholder:normal-case focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--invite-focus)] disabled:cursor-not-allowed disabled:opacity-50"
            // A placeholder is not an accessible name — it is not exposed as
            // one, and it disappears the moment the guest types. Without this
            // the only control on the page is an unnamed edit field to a
            // screen reader or voice control (WCAG SC 3.3.2 / 4.1.2).
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
            <p class="font-body text-error text-ui-sm py-2" role="alert">
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
          <Button
            type="submit"
            variant="cta"
            size="lg"
            class="w-full"
            disabled={
              claim.loading() ||
              !claim.code().trim() ||
              (turnstileEnabled() && !claim.turnstileToken())
            }
          >
            {claim.loading() ? "Checking…" : "Open Invitation"}
          </Button>
        </form>
      </div>

      {/* Welcome message — visible after claim, in the same frame as the form
          (a display swap, not a second panel). */}
      <div ref={props.welcomeRef} style={{ display: showWelcome() ? "" : "none" }}>
        <Show when={props.result?.preview}>
          <p
            class={`border-gold/40 bg-gold/5 text-gold-ink text-ui-sm tracking-ui-wider mb-6 rounded-sm border px-4 py-3 uppercase ${layout().measure}`}
            role="status"
          >
            Preview mode. Every event is shown; try the RSVP, nothing you send is saved.
          </p>
        </Show>
        <Show
          when={isIndividual()}
          fallback={
            <>
              {/* No "Welcome" eyebrow above this heading: the greeting IS the
                  heading, and a label repeating it only adds a fourth gold
                  uppercase micro-label to a page that already has too many. */}
              <h2 class={`${HEADING} mb-3 ${layout().greeting} ${layout().headingSize}`}>
                Welcome, the {props.result?.familyName} Family
              </h2>
              <p class="text-text-muted text-ui-base leading-ui-normal mb-2 font-light">
                {props.welcomeMessage ?? DEFAULT_WELCOME_MESSAGE}
              </p>
              <p class="text-text text-ui-base leading-ui-normal mb-8 font-light">
                <For each={invited()}>
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
          {/* Single-guest code → greet the individual by name (nickname wins).
              "Dear" reads as part of the greeting, so it belongs in the
              heading, not stranded above it as an uppercase label. */}
          <h2 class={`${HEADING} mb-3 ${layout().greeting} ${layout().headingSize}`}>
            Dear {individualName()}
          </h2>
          <p class="text-text-muted text-ui-base leading-ui-normal mb-8 font-light">
            {props.welcomeMessage ?? DEFAULT_WELCOME_MESSAGE}
          </p>
        </Show>
        {/* The RSVP-by date, where the guest lands. The events section states
            it again on top of the cards, and THAT copy is the live region and
            the `aria-describedby` target — this one is an ordinary paragraph,
            so the pair is read once each in browse mode and announced once
            between them when the deadline moves. */}
        <RsvpDeadlineNotice
          deadline={props.result?.rsvpDeadline}
          state={props.rsvpDeadlineState ?? null}
          variant="panel"
          class={`mb-8 ${layout().measure}`}
        />

        {/* The household's controls. The plus-one prompt comes first, for a
            household the couple let bring a guest (or one that already named
            one); it locks with the rest of the invite at the RSVP deadline.
            Account linking is optional and additive: it draws only when the
            claim payload offers it, and from that payload alone, so it appears
            with this panel rather than a request later above events already on
            screen. Neither appears in host preview, since a host is not a
            guest seat. Each sits in its own Suspense, so one chunk never waits
            on the other. Sign-out comes last — it ends the session the others
            act on. */}
        <Show when={props.onPlusOneChange && offersPlusOne() ? props.onPlusOneChange : null}>
          {(onChange) => (
            <Suspense fallback={null}>
              <PlusOnePrompt
                apiUrl={props.apiUrl}
                members={members()}
                rsvps={props.result?.rsvps ?? []}
                closed={props.rsvpDeadlineState === "closed"}
                onChange={onChange()}
                class={`mb-8 ${layout().measure}`}
              />
            </Suspense>
          )}
        </Show>
        {/* "Who are you?" — the household says which member is at the
            keyboard. Replies record that member, and the account link binds
            to them. */}
        <Show when={memberStep()}>
          <Show
            when={chosen()}
            fallback={
              <fieldset class={`mb-8 border-0 p-0 ${layout().measure}`}>
                <legend class="font-display text-gold-ink text-ui-lg mx-auto mb-3 leading-tight font-light italic">
                  Who are you?
                </legend>
                <div class="flex flex-wrap justify-center gap-2">
                  <For each={invited()}>
                    {(m) => (
                      <Button
                        variant="subtle"
                        type="button"
                        disabled={choosing()}
                        onClick={() => void pickMember(m.guestId)}
                      >
                        {m.firstName}
                      </Button>
                    )}
                  </For>
                </div>
                <Show when={memberError()}>
                  <p class="text-error text-ui-sm mt-3" role="alert">
                    {memberError()}
                  </p>
                </Show>
              </fieldset>
            }
          >
            {(m) => (
              <p class={`text-text text-ui-sm mb-6 font-light ${layout().measure}`}>
                Answering as {m().firstName}
                <Show when={invited().length >= 2 || accountLink()?.signedIn}>
                  {" · "}
                  <Button
                    variant="touchLink"
                    type="button"
                    disabled={clearing()}
                    onClick={() => void handleNotYou()}
                  >
                    Not you?
                  </Button>
                </Show>
                <Show when={notYouError()}>
                  <span class="text-error mt-2 block" role="alert">
                    {notYouError()}
                  </span>
                </Show>
              </p>
            )}
          </Show>
        </Show>
        <Show when={memberStep() && accountLink() ? accountLink() : null}>
          {(state) => (
            <Show when={chosen()}>
              {(m) => (
                <Suspense fallback={null}>
                  <PulseAccountLink
                    apiUrl={props.apiUrl}
                    member={m()}
                    state={state()}
                    onLinked={(id) => setLinked(id, true)}
                    onUnlinked={(id) => setLinked(id, false)}
                    onNotYou={() => void handleNotYou()}
                    class={`mb-8 ${layout().measure}`}
                  />
                </Suspense>
              )}
            </Show>
          )}
        </Show>
        <Show when={props.onSignOut}>
          <Button variant="touchLink" type="button" onClick={handleSignOut}>
            {signOutLabel()}
          </Button>
        </Show>
      </div>
    </>
  );

  return (
    <section class={layout().section} style={layout().card === null ? surface() : undefined}>
      <div class={layout().column}>
        <Show when={layout().card} fallback={body()}>
          {(card) => (
            <div class={card()} style={surface()}>
              {body()}
            </div>
          )}
        </Show>
      </div>
    </section>
  );
}
