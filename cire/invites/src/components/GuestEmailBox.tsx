import { GUEST_EMAIL_CONSENT, parseGuestEmail } from "@cire/guest-email";
import Button from "@cire/ui/button";
import { Notice } from "@shared/ui/ui/notice";
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
 * Removing deletes the address; removing one the hosts added also stops
 * wedding email to it until this seat gives it again, and the note after the
 * removal says which happened. It stays open after the RSVP deadline: an
 * address is not a reply.
 *
 * Purely additive, like the account-link box: a failure says so in the box and
 * never touches the invite around it. Its buttons are named for the address
 * and never contain "Save", so they never collide with the RSVP sheet's.
 *
 * While the address is not one or the consent box is unticked, the save button
 * stays focusable with `aria-disabled` and a reason naming what blocks it, so
 * a keyboard or screen-reader user can reach and read why. One status region
 * is mounted for the box's whole life, so the note a removal sets in it is
 * announced.
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
  /**
   * Placement and corner from the panel that hosts it. The box owns only its
   * own surface; its corner depends on whether that panel is itself a card.
   */
  class?: string;
}

const INPUT =
  "border-text/55 bg-text/4.5 font-body text-text focus:border-gold sm:text-ui-base rounded-ui-field mt-1.5 block w-full cursor-text border px-3 py-2.5 text-base transition-ui-colors duration-(--dur-fast) ease-(--ease-out) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ui-focus disabled:cursor-not-allowed disabled:opacity-50";

const INVALID_ADDRESS = "That doesn’t look like one email address. Please check it.";
/** After removing an address the hosts added: the API records the opt-out. */
const REMOVED_HOSTS_NOTE =
  "Removed. Your hosts won’t email that address about the wedding unless you add it again.";
/** After removing the guest's own address, which leaves no opt-out to promise on. */
const REMOVED_OWN_NOTE = "Removed. We’ve deleted that address from your invitation.";

/** Why the save button is unavailable, naming what blocks it; null when nothing does. */
function blockedReason(address: "empty" | "invalid" | "valid", consented: boolean): string | null {
  const fix =
    address === "empty"
      ? "enter your email address"
      : address === "invalid"
        ? "check your email address"
        : null;
  if (fix === null) return consented ? null : "To save, tick the box above.";
  return consented ? `To save, ${fix}.` : `To save, ${fix} and tick the box above.`;
}

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
  const invalidId = createUniqueId();
  const reasonId = createUniqueId();
  const errorId = createUniqueId();
  const [editing, setEditing] = createSignal(props.email === null);
  const [draft, setDraft] = createSignal("");
  const [consent, setConsent] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  // The status region's text: the note after a removal, until the next save.
  // Only a save leads back to a stored address, so it is the one that clears it.
  const [note, setNote] = createSignal("");

  // Set when the guest leaves the field or presses the blocked save button;
  // cleared once the address is valid or empty. The field's own error waits
  // for it, so a half-typed address is not called wrong mid-word.
  const [touched, setTouched] = createSignal(false);

  const address = (): "empty" | "invalid" | "valid" =>
    draft().trim() === "" ? "empty" : parseGuestEmail(draft()) === null ? "invalid" : "valid";
  const blocked = () => blockedReason(address(), consent());
  const showInvalid = () => touched() && address() === "invalid";
  // The server refused an address the browser had passed: the line under the
  // box says so, and it is the field's to fix.
  const refused = () => error() === INVALID_ADDRESS;
  const describedBy = () =>
    [showInvalid() ? invalidId : undefined, refused() ? errorId : undefined]
      .filter(Boolean)
      .join(" ") || undefined;
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
    setTouched(false);
    setError(null);
    setEditing(true);
    focusAfterRender(() => input);
  }

  async function save(e: SubmitEvent) {
    e.preventDefault();
    if (blocked() !== null) setTouched(true);
    if (blocked() !== null || busy()) return;
    setBusy(true);
    setError(null);
    setNote("");
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
            ? INVALID_ADDRESS
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
    const hostsAdded = props.email?.source === "organiser_attested";
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
      setNote(hostsAdded ? REMOVED_HOSTS_NOTE : REMOVED_OWN_NOTE);
      setDraft("");
      setConsent(false);
      setTouched(false);
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
      class={`border-gold/30 bg-gold/5 border px-5 py-6 text-left ${props.class ?? ""}`}
      aria-labelledby={headingId}
    >
      <h3
        id={headingId}
        ref={heading}
        tabIndex={-1}
        class="font-display text-gold-ink text-ui-lg leading-ui-tight mb-1 font-light italic focus:outline-none"
      >
        Wedding emails
      </h3>
      {/* Mounted for the box's whole life, empty until a removal lands: a live
          region inserted already holding its text is not reliably announced. */}
      <output
        class="text-text-muted text-ui-sm leading-ui-normal block font-light"
        classList={{ "mb-3": note() !== "" }}
      >
        {note()}
      </output>
      <Show
        when={!editing() && props.email}
        fallback={
          <form class="flex flex-col gap-3" onSubmit={(e) => void save(e)}>
            <Show when={note() === ""}>
              <p class="text-text-muted text-ui-sm leading-ui-normal font-light">
                Optional. Add your email so your hosts can send you news about the wedding through
                Cire.
              </p>
            </Show>
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
                onInput={(e) => {
                  setDraft(e.currentTarget.value);
                  if (address() !== "invalid") setTouched(false);
                }}
                onBlur={() => setTouched(true)}
                name="email"
                autocomplete="email"
                spellcheck={false}
                disabled={busy()}
                aria-invalid={showInvalid() || refused() ? "true" : undefined}
                aria-describedby={describedBy()}
              />
              <Show when={showInvalid()}>
                <p id={invalidId} class="text-error text-ui-sm mt-1.5">
                  {INVALID_ADDRESS}
                </p>
              </Show>
            </div>
            <label class="font-body text-text-muted text-ui-sm leading-ui-normal flex items-start gap-2.5 normal-case">
              <input
                type="checkbox"
                class="mt-0.5 h-4 w-4 shrink-0 cursor-pointer"
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
            <span
              class="flex flex-wrap items-center gap-2"
              onClick={(e) => {
                // `Button` swallows the press without calling `onClick`, so the
                // press is read here, as it bubbles from the blocked button.
                if (blocked() !== null && e.target.closest("button[type=submit]")) {
                  setTouched(true);
                }
              }}
            >
              {/* `aria-disabled`, not `disabled`, while the address or the
                  consent blocks it: the button keeps its tab stop and its
                  reason, and `Button` swallows the press. Natively disabled
                  only while the request is in flight. */}
              <Button
                type="submit"
                variant="cta"
                disabled={busy()}
                aria-disabled={blocked() !== null ? "true" : undefined}
                aria-describedby={blocked() !== null ? reasonId : undefined}
              >
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
            <Show when={blocked()}>
              {(reason) => (
                <p id={reasonId} class="text-text-muted text-ui-sm leading-ui-normal font-light">
                  {reason()}
                </p>
              )}
            </Show>
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
        <Notice id={errorId} size="inline" tone="danger" alert class="mt-3">
          {error()}
        </Notice>
      </Show>
    </section>
  );
}
