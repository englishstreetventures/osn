import { GUEST_EMAIL_CONSENT, parseGuestEmail } from "@cire/guest-email";
import Button from "@cire/ui/button";
import { createSignal, createUniqueId, Show } from "solid-js";

import type { FamilyMember, MemberEmail } from "./types";
import { readEmail } from "./utils";

/**
 * "Wedding emails": the chosen member gives, corrects or removes their own
 * address, in the household panel (`LoginSection`) under "Answering as".
 *
 * One seat only — the member the household says is at the keyboard — never
 * another member's, and never a plus-one's, who is never a chosen member.
 * Saving needs the consent box, whose words and version come from
 * `@cire/guest-email`; the API refuses a version that is not the one shown.
 * Removing stops wedding email to the address, whoever added it, until this
 * seat gives it again. It stays open after the RSVP deadline: an address is not
 * a reply.
 *
 * Purely additive, like the account-link box: a failure says so in the box and
 * never touches the invite around it. Its buttons are named for the address
 * and never contain "Save", so they never collide with the RSVP sheet's.
 */
interface GuestEmailBoxProps {
  /** cire-api origin (the same value the rest of the invite fetches from). */
  apiUrl: string;
  /** The household member this session chose. */
  member: FamilyMember;
  /** Their stored address, or null for none. */
  email: MemberEmail | null;
  /** The address changed on the server: store it on the page. */
  onChange: (email: MemberEmail | null) => void;
  /** The server holds no member, or another one: ask "Who are you?" again. */
  onMemberRequired: () => void;
  /** Placement on the panel that hosts it. The box owns only its own surface. */
  class?: string;
}

const INPUT =
  "border-text/55 bg-text/[0.045] font-body text-text focus:border-gold sm:text-ui-base mt-1.5 block w-full cursor-text rounded-sm border px-3 py-2.5 text-base transition-colors duration-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--invite-focus)] disabled:cursor-not-allowed disabled:opacity-50";

/** What the API's refusal means for the guest, by its `error` code. */
async function refusalOf(res: Response): Promise<"member" | "invalid" | "outdated" | "other"> {
  const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
  if (res.status === 409) return "member";
  if (body?.error === "invalid_email") return "invalid";
  if (body?.error === "email_consent_outdated") return "outdated";
  return "other";
}

export function GuestEmailBox(props: GuestEmailBoxProps) {
  const headingId = createUniqueId();
  const inputId = createUniqueId();
  const [editing, setEditing] = createSignal(props.email === null);
  const [draft, setDraft] = createSignal("");
  const [consent, setConsent] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [removedNote, setRemovedNote] = createSignal(false);

  const valid = () => parseGuestEmail(draft()) !== null;
  let heading: HTMLHeadingElement | undefined;
  let input: HTMLInputElement | undefined;
  // Each view replaces the button that was pressed, so focus moves on with
  // the view rather than falling to the page: to the field when editing
  // starts, to the heading once a save or a removal lands.
  const focusAfterRender = (target: () => HTMLElement | undefined) =>
    queueMicrotask(() => target()?.focus());

  function startEditing() {
    setDraft(props.email?.address ?? "");
    setConsent(false);
    setError(null);
    setEditing(true);
    focusAfterRender(() => input);
  }

  async function save(e: SubmitEvent) {
    e.preventDefault();
    if (!valid() || !consent() || busy()) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${props.apiUrl}/api/claim/member/email`, {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          memberGuestId: props.member.guestId,
          email: draft(),
          consentVersion: GUEST_EMAIL_CONSENT.version,
        }),
      });
      if (!res.ok) {
        const refusal = await refusalOf(res);
        if (refusal === "member") {
          props.onMemberRequired();
          return;
        }
        setError(
          refusal === "invalid"
            ? "That doesn’t look like one email address. Please check it."
            : refusal === "outdated"
              ? "This page is out of date. Please reload it and try again."
              : "Couldn’t save your email. Please try again.",
        );
        return;
      }
      const body: unknown = await res.json().catch(() => null);
      const saved =
        typeof body === "object" && body !== null && "email" in body ? readEmail(body.email) : null;
      props.onChange(saved);
      setRemovedNote(false);
      setEditing(false);
      focusAfterRender(() => heading);
    } catch {
      setError("Couldn’t save your email. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (busy()) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${props.apiUrl}/api/claim/member/email`, {
        method: "DELETE",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ memberGuestId: props.member.guestId }),
      });
      if (!res.ok) {
        if ((await refusalOf(res)) === "member") {
          props.onMemberRequired();
          return;
        }
        setError("Couldn’t remove your email. Please try again.");
        return;
      }
      props.onChange(null);
      setRemovedNote(true);
      setDraft("");
      setConsent(false);
      setEditing(true);
      focusAfterRender(() => heading);
    } catch {
      setError("Couldn’t remove your email. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      class={`border-gold/30 bg-gold/5 rounded-sm border px-5 py-6 text-left ${props.class ?? ""}`}
      aria-labelledby={headingId}
    >
      <h3
        id={headingId}
        ref={heading}
        tabIndex={-1}
        class="font-display text-gold-ink text-ui-lg mb-1 leading-tight font-light italic focus:outline-none"
      >
        Wedding emails
      </h3>
      <Show
        when={!editing() && props.email}
        fallback={
          <form class="flex flex-col gap-3" onSubmit={(e) => void save(e)}>
            <output class="text-text-muted text-ui-sm leading-ui-normal block font-light">
              <Show
                when={removedNote()}
                fallback={
                  <>
                    Optional. Add your email so your hosts can send you news about the wedding
                    through Cire.
                  </>
                }
              >
                Removed. Your hosts won’t email that address about the wedding unless you add it
                again.
              </Show>
            </output>
            <div>
              <label for={inputId} class="font-body text-text-muted text-ui-sm block">
                Your email, {props.member.firstName}
              </label>
              <input
                id={inputId}
                ref={input}
                type="email"
                class={INPUT}
                value={draft()}
                onInput={(e) => setDraft(e.currentTarget.value)}
                name="email"
                autocomplete="email"
                spellcheck={false}
                disabled={busy()}
              />
            </div>
            <label class="font-body text-text-muted text-ui-sm flex items-start gap-2.5 leading-relaxed normal-case">
              <input
                type="checkbox"
                class="accent-gold mt-0.5 h-4 w-4 shrink-0 cursor-pointer"
                checked={consent()}
                onChange={(e) => setConsent(e.currentTarget.checked)}
                disabled={busy()}
              />
              <span>
                {GUEST_EMAIL_CONSENT.text} See our{" "}
                <a
                  href="/privacy"
                  target="_blank"
                  rel="noopener noreferrer"
                  class="text-gold-ink underline underline-offset-2"
                >
                  privacy notice
                </a>
                .
              </span>
            </label>
            <span class="flex flex-wrap items-center gap-2">
              <Button type="submit" variant="cta" disabled={busy() || !valid() || !consent()}>
                {busy() ? "Saving…" : props.email ? "Use this email" : "Add email"}
              </Button>
              <Show when={props.email}>
                <Button
                  variant="subtle"
                  size="sm"
                  type="button"
                  onClick={() => {
                    setEditing(false);
                    focusAfterRender(() => heading);
                  }}
                  disabled={busy()}
                >
                  Keep it as it is
                </Button>
              </Show>
            </span>
          </form>
        }
      >
        {(stored) => (
          <div class="flex flex-col gap-3">
            <p class="text-text text-ui-base font-light break-all">{stored().address}</p>
            <p class="text-text-muted text-ui-sm leading-ui-normal font-light">
              {stored().source === "guest"
                ? "You added this. Your hosts can email you about the wedding here."
                : "Your hosts added this. Change it if it’s wrong, or remove it to stop wedding emails to it."}
            </p>
            <span class="flex flex-wrap items-center gap-2">
              <Button
                variant="subtle"
                size="sm"
                type="button"
                onClick={startEditing}
                disabled={busy()}
              >
                Change email
              </Button>
              <Button
                variant="subtle"
                size="sm"
                type="button"
                onClick={() => void remove()}
                disabled={busy()}
              >
                {busy() ? "Removing…" : "Remove email"}
              </Button>
            </span>
          </div>
        )}
      </Show>
      <Show when={error()}>
        <p class="text-error text-ui-sm mt-3" role="alert">
          {error()}
        </p>
      </Show>
    </section>
  );
}
