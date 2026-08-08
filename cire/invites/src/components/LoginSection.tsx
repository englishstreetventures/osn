import { Show, For } from "solid-js";

import { createClaimCode } from "./claim-code";
import { filterThemeVars } from "./invite-theme";
import { TurnstileWidget, turnstileEnabled, type TurnstileControls } from "./TurnstileWidget";
import type { ClaimResult } from "./types";

interface LoginSectionProps {
  apiUrl: string;
  result: ClaimResult | null;
  onClaimed: (result: ClaimResult) => void;
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
   * the palette at the document root. Empty/absent ⇒ the page ground.
   */
  themeVars?: Record<string, string>;
  /**
   * Organiser override for the post-claim greeting line shown under the family
   * or guest name. Absent/null ⇒ the built-in default greeting.
   */
  welcomeMessage?: string | null;
  /**
   * Ends the household session — a shared device, or a code that opened the
   * wrong family's invite. The PARENT owns the actual sign-out: revoking
   * `cire_session` server-side and resetting `result`/`revealed`. This
   * component only resets its own form state (code, error, loading, Turnstile
   * token) and moves focus, so the returned form is immediately usable.
   *
   * Absent ⇒ no control is rendered, since without a handler it would have
   * nothing to swap the view back with.
   */
  onSignOut?: () => void;
}

// The built-in post-claim greeting, used when the organiser hasn't overridden it.
const DEFAULT_WELCOME_MESSAGE = "We are delighted to invite you to celebrate with us.";

export function LoginSection(props: LoginSectionProps) {
  const claim = createClaimCode({
    apiUrl: props.apiUrl,
    result: () => props.result,
    onClaimed: (result) => props.onClaimed(result),
  });

  // Falls back to `result` so the section still swaps for a caller that passes
  // no `revealed` — and it is only ever READ here, never written, so this
  // component cannot latch itself into either half.
  const showWelcome = () => props.revealed ?? props.result !== null;

  // A claim code can cover one guest or a whole household. A single-guest code
  // greets the person individually ("Dear {name}"); a multi-guest code greets
  // the household ("The {familyName} Family"). For an individual, an optional
  // nickname overrides their first name.
  const members = () => props.result?.members ?? [];
  const isIndividual = () => members().length === 1;
  const individualName = () => {
    const m = members()[0];
    if (!m) return "";
    return m.nickname?.trim() ? m.nickname.trim() : m.firstName;
  };

  // "Not the Okafor family? Sign out" when we know who they are, so the control
  // names the household it ends rather than describing a mechanism. Falls back
  // to the plain label when the payload has no usable name.
  const signOutLabel = () => {
    const name = isIndividual() ? individualName() : props.result?.familyName;
    return name?.trim() ? `Not ${name.trim()}? Sign out` : "Sign out";
  };

  let codeInputRef: HTMLInputElement | undefined;
  let turnstile: TurnstileControls | undefined;

  function handleSignOut() {
    // Return the form to a submittable state: blank field (it would otherwise
    // reappear pre-filled with the code that just succeeded), no stale error,
    // no stuck `loading`, no spent Turnstile token.
    claim.reset();
    // Re-challenge so a fresh single-use token can replace the one the
    // previous claim redeemed. No-op when Turnstile is unconfigured.
    turnstile?.reset();
    // Let the parent revoke the session and swap the view back BEFORE
    // focusing — the form is `display: none` until it does, and `focus()` on a
    // hidden element is silently dropped.
    props.onSignOut?.();
    // C-L1: the click removes the focused button from the accessibility tree,
    // which would drop focus to `<body>` and leave a keyboard or screen-reader
    // user at the top of the document with no signal that the form is back.
    // The code input is both the announcement (it has an accessible name) and
    // the obvious next action.
    codeInputRef?.focus();
  }

  return (
    <section
      class="border-border border-b px-6 py-16 md:px-8 md:py-20"
      style={{
        // themeVars carries this section's tone — which derived surface it sits
        // on. Every gold/font utility inside (eyebrow labels, headings, the
        // input's focus border, the submit button and its hover fill, the
        // preview-mode chip) already resolves the organiser's scheme from the
        // root palette, hover and focus states included.
        ...filterThemeVars(props.themeVars),
        "background-color": "var(--invite-section-bg)",
      }}
    >
      <div class="mx-auto max-w-[540px] text-center md:max-w-[640px]">
        {/* Login form — visible before claim */}
        <div ref={props.formRef} style={{ display: showWelcome() ? "none" : "" }}>
          <p class="font-body text-gold-ink mb-3 text-[0.72rem] tracking-[0.2em] uppercase">
            Your Invitation
          </p>
          <h2 class="font-display text-text mb-5 text-[clamp(2rem,5vw,3rem)] leading-[1.15] font-light">
            Enter Your Code
          </h2>
          <p class="text-text-muted mb-8 text-[0.92rem] leading-[1.6] font-light">
            Enter the code from your invitation to see your events.
          </p>
          <form class="mx-auto flex max-w-[360px] flex-col gap-3" onSubmit={claim.handleSubmit}>
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
              class="border-text/55 bg-text/[0.045] font-body text-text placeholder:text-text-muted focus:border-gold w-full cursor-text rounded-sm border px-4 py-3.5 text-center text-base tracking-[0.1em] uppercase transition-colors duration-200 placeholder:tracking-[0.04em] placeholder:normal-case focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--invite-focus)] disabled:cursor-not-allowed disabled:opacity-50"
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
              class="border-gold font-body text-gold-ink hover:bg-gold hover:text-bg disabled:hover:text-gold-ink rounded-sm border bg-transparent px-6 py-3.5 text-[0.88rem] tracking-[0.12em] uppercase transition-colors duration-200 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
              disabled={
                claim.loading() ||
                !claim.code().trim() ||
                (turnstileEnabled() && !claim.turnstileToken())
              }
            >
              {claim.loading() ? "Checking\u2026" : "Open Invitation"}
            </button>
          </form>
        </div>

        {/* Welcome message — visible after claim */}
        <div ref={props.welcomeRef} style={{ display: showWelcome() ? "" : "none" }}>
          <Show when={props.result?.preview}>
            <p
              class="border-gold/40 bg-gold/5 text-gold-ink mx-auto mb-6 max-w-[420px] rounded-sm border px-4 py-3 text-[0.78rem] tracking-[0.08em] uppercase"
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
                <h2 class="font-display text-gold mb-3 text-[clamp(2rem,5vw,3rem)] leading-[1.15] font-light">
                  Welcome, the {props.result?.familyName} Family
                </h2>
                <p class="text-text-muted mb-2 text-[0.92rem] leading-[1.6] font-light">
                  {props.welcomeMessage ?? DEFAULT_WELCOME_MESSAGE}
                </p>
                <p class="text-text mb-8 text-[0.88rem] leading-[1.6] font-light">
                  <For each={props.result?.members}>
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
            <h2 class="font-display text-gold mb-3 text-[clamp(2rem,5vw,3rem)] leading-[1.15] font-light">
              Dear {individualName()}
            </h2>
            <p class="text-text-muted mb-8 text-[0.92rem] leading-[1.6] font-light">
              {props.welcomeMessage ?? DEFAULT_WELCOME_MESSAGE}
            </p>
          </Show>
          <Show when={props.onSignOut}>
            <button
              type="button"
              onClick={handleSignOut}
              class="font-body text-text-muted hover:text-gold-ink focus-visible:ring-gold/60 rounded-sm text-[0.78rem] underline underline-offset-2 transition-colors duration-200 focus:outline-none focus-visible:ring-2"
            >
              {signOutLabel()}
            </button>
          </Show>
        </div>
      </div>
    </section>
  );
}
