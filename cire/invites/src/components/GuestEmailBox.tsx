import { GUEST_EMAIL_CONSENT, parseGuestEmail } from "@cire/guest-email";
import Button, { proseLinkClass } from "@cire/ui/button";
import { Checkbox } from "@shared/ui/ui/checkbox";
import { Input } from "@shared/ui/ui/input";
import { Notice } from "@shared/ui/ui/notice";
import { createEffect, createSignal, createUniqueId, on, Show } from "solid-js";

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
 * removal says which happened. After the RSVP deadline the box takes no new or
 * changed address (the API refuses it too, 403 `rsvp_closed`): a stored address
 * shows with its Remove button alone, and the status region says why there is
 * no form.
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
   * The wedding's RSVP deadline has passed: the box takes no new or changed
   * address, and a stored one can only be removed. Read live, so a deadline
   * that passes under a guest who is typing closes the form.
   */
  closed?: boolean;
  /**
   * Placement and corner from the panel that hosts it. The box owns only its
   * own surface; its corner depends on whether that panel is itself a card.
   */
  class?: string;
}

const INVALID_ADDRESS = "That doesn’t look like one email address. Please check it.";
/** After removing an address the hosts added: the API records the opt-out. */
const REMOVED_HOSTS_NOTE =
  "Removed. Your hosts won’t email that address about the wedding unless you add it again.";
/** The same removal once RSVPs have closed, when no address can be added. */
const REMOVED_HOSTS_NOTE_CLOSED = "Removed. Your hosts won’t email that address about the wedding.";
/** Why there is no form: said in the status region, so the change is announced. */
const CLOSED_NOTE = "RSVPs have closed, so we can’t take a new email address.";
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
async function refusalOf(
  res: Response,
): Promise<"member" | "closed" | "invalid" | "outdated" | "other"> {
  const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
  if (res.status === 409) return "member";
  if (res.status === 403 && body?.error === "rsvp_closed") return "closed";
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
  // The server refused a save because RSVPs have closed, whatever this page's
  // clock says: its verdict is the one that counts.
  const [serverClosed, setServerClosed] = createSignal(false);
  const isClosed = () => props.closed === true || serverClosed();
  // What the status region says: the removal's note, else why there is no form.
  const status = () => (note() !== "" ? note() : isClosed() ? CLOSED_NOTE : "");

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
  let section: HTMLElement | undefined;
  let heading: HTMLHeadingElement | undefined;
  let input: HTMLInputElement | undefined;
  // Each view replaces the button that was pressed, so focus moves on with
  // the view rather than falling to the page: to the field when editing
  // starts, to the heading once a save or a removal lands.
  const focusAfterRender = (target: () => HTMLElement | undefined) =>
    queueMicrotask(() => target()?.focus());

  // The deadline passing takes the form from under a guest who may be typing:
  // focus would fall to the page, so it moves to the heading, which sits above
  // the status line that says why.
  createEffect(
    on(isClosed, (closed, was) => {
      if (!closed || was !== false) return;
      const active = document.activeElement;
      if (active === null || active === document.body || section?.contains(active)) {
        heading?.focus();
      }
    }),
  );

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
        if (refusal === "closed") {
          setServerClosed(true);
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
      setNote(
        hostsAdded
          ? isClosed()
            ? REMOVED_HOSTS_NOTE_CLOSED
            : REMOVED_HOSTS_NOTE
          : REMOVED_OWN_NOTE,
      );
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
      ref={section}
      class={`border-gold/30 border px-5 py-6 text-left ${props.class ?? ""}`}
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
        classList={{ "mb-3": status() !== "" }}
      >
        {status()}
      </output>
      <Show
        when={(isClosed() || !editing()) && props.email}
        fallback={
          <Show when={!isClosed()}>
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
                <Input
                  fill="ink"
                  size="touch"
                  class="mt-1.5"
                  id={inputId}
                  ref={input}
                  type="email"
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
              <Checkbox
                box="native"
                size="sm"
                align="start"
                checked={consent()}
                onChange={setConsent}
                disabled={busy()}
                label={
                  <>
                    {GUEST_EMAIL_CONSENT.text} See our{" "}
                    <a
                      href="/privacy/"
                      target="_blank"
                      rel="noopener noreferrer"
                      class={proseLinkClass()}
                    >
                      privacy notice
                      <span class="sr-only"> (opens in a new tab)</span>
                    </a>
                    .
                  </>
                }
              />
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
          </Show>
        }
      >
        {(stored) => (
          <div class="flex flex-col gap-3">
            <p class="text-text text-ui-base font-light break-all">{stored().address}</p>
            <p class="text-text-muted text-ui-sm leading-ui-normal font-light">
              {stored().source === "guest"
                ? "You added this. Your hosts can email you about the wedding here."
                : isClosed()
                  ? "Your hosts added this. Remove it to stop wedding emails to it."
                  : "Your hosts added this. Change it if it’s wrong, or remove it to stop wedding emails to it."}
            </p>
            <span class="flex flex-wrap items-center gap-2">
              <Show when={!isClosed()}>
                <Button
                  variant="subtle"
                  size="sm"
                  type="button"
                  onClick={startEditing}
                  disabled={busy()}
                >
                  Change email
                </Button>
              </Show>
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
