import { Show, For } from "solid-js";

import { createClaimCode } from "./claim-code";
import { filterThemeVars } from "./invite-theme";
import { TurnstileWidget, turnstileEnabled } from "./TurnstileWidget";
import type { ClaimResult } from "./types";

interface LoginSectionProps {
  apiUrl: string;
  result: ClaimResult | null;
  onClaimed: (result: ClaimResult) => void;
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
}

// The built-in post-claim greeting, used when the organiser hasn't overridden it.
const DEFAULT_WELCOME_MESSAGE = "We are delighted to invite you to celebrate with us.";

export function LoginSection(props: LoginSectionProps) {
  const claim = createClaimCode({
    apiUrl: props.apiUrl,
    result: () => props.result,
    onClaimed: (result) => props.onClaimed(result),
  });

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
        <div ref={props.formRef} style={{ display: props.result ? "none" : "" }}>
          <p class="font-body text-gold mb-3 text-[0.72rem] tracking-[0.2em] uppercase">
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
              // A border tint alone is too quiet to mark focus on the page's
              // one input; the ring keeps keyboard users oriented. Text cursor
              // on a text field — the pointer belongs on buttons only.
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
              class="border-gold font-body text-gold hover:bg-gold hover:text-bg disabled:hover:text-gold rounded-sm border bg-transparent px-6 py-3.5 text-[0.88rem] tracking-[0.12em] uppercase transition-colors duration-200 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
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
        <div ref={props.welcomeRef} style={{ display: props.result ? "" : "none" }}>
          <Show when={props.result?.preview}>
            <p
              class="border-gold/40 bg-gold/5 text-gold mx-auto mb-6 max-w-[420px] rounded-sm border px-4 py-3 text-[0.78rem] tracking-[0.08em] uppercase"
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
        </div>
      </div>
    </section>
  );
}
