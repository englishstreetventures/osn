import Button from "@cire/ui/button";
import { createMemo, createSignal, createUniqueId, For, onCleanup, Show } from "solid-js";

import {
  hasUnansweredEvents,
  invitedMembers,
  plusOneOf,
  plusOneRefusalMessage,
  withPlusOneRemoved,
  withPlusOneSaved,
} from "./plus-one";
import type { ClaimResult, FamilyMember, RsvpSummary } from "./types";
import { formatNames, isValidPlusOneSaveResponse } from "./utils";

/**
 * The household's plus-ones, in the claim and welcome panel: a member the
 * couple lets bring a guest names them here, and can rename or remove them
 * until the RSVP deadline. Past it, a named guest is shown and nothing can be
 * changed, as with the rest of the invite.
 *
 * The page owns the household. This component only asks the API, and hands
 * the page an update to apply to its claim result, so the Respond dialog, the
 * greeting and every card read the change from the one copy.
 *
 * The person named never sees the invite, so the prompt asks the household to
 * pass the privacy notice on to them (GDPR Art. 14 — the data about them is
 * not collected from them).
 */

interface PlusOnePromptProps {
  /** cire-api origin. */
  apiUrl: string;
  /** The claim result's members, plus-ones included. */
  members: readonly FamilyMember[];
  /** The claim result's replies, for the reminder to answer for a guest. */
  rsvps: readonly RsvpSummary[];
  /** The RSVP deadline has passed: show named guests, change nothing. */
  closed: boolean;
  /** Apply a change to the page's claim result. */
  onChange: (update: (result: ClaimResult) => ClaimResult) => void;
  /** Placement from the panel that hosts it. */
  class?: string;
}

/** Longest name half the API takes (`PLUS_ONE_NAME_MAX` in
 *  `cire/api/src/schemas/plus-one.ts`). */
const NAME_MAX = 100;

/**
 * A name field on the welcome surface. The border is the page's ink at 0.55,
 * as on the code field above it, because the organiser chooses the surface
 * this sits on and a fixed token would vanish into the one that matches it;
 * 0.55 is what clears the 3:1 a control's edge needs on every palette
 * (WCAG 2.1 SC 1.4.11). 16px on phones, so iOS does not zoom on focus.
 */
const INPUT =
  "border-text/55 bg-text/[0.045] font-body text-text focus:border-gold sm:text-ui-base mt-1.5 block w-full cursor-text rounded-sm border px-3 py-2.5 text-base transition-colors duration-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--invite-focus)] disabled:cursor-not-allowed disabled:opacity-50";

const LABEL = "font-body text-text-muted text-ui-sm block";

export function PlusOnePrompt(props: PlusOnePromptProps) {
  const headingId = createUniqueId();

  const invited = createMemo(() => invitedMembers(props.members));
  const permitted = createMemo(() => invited().filter((m) => m.plusOneAllowed === true));

  /**
   * One row per member who may bring a guest or already has one named. Past
   * the deadline only the named remain: there is nothing left to offer.
   */
  const rows = createMemo(() =>
    invited().filter((m) => {
      const named = plusOneOf(props.members, m.guestId) !== undefined;
      return props.closed ? named : named || m.plusOneAllowed === true;
    }),
  );

  /** A household of one is spoken to; a larger one is named. */
  const alone = () => invited().length === 1;

  const lead = () => {
    if (alone())
      return "You're welcome to bring a guest. Add their name so the couple can plan for them.";
    const who = permitted().map((m) => m.firstName);
    if (who.length === 0) return null;
    return who.length === 1
      ? `${who[0]} is welcome to bring a guest. Add their name so the couple can plan for them.`
      : `${formatNames(who)} are each welcome to bring a guest. Add their names so the couple can plan for them.`;
  };

  return (
    <Show when={rows().length > 0}>
      {/* `wrap-anywhere` is inherited: names are typed by guests and can be one
          long word, and every line here that carries one must still wrap
          inside the narrow panel card on a phone. */}
      <section
        class={`border-gold/30 bg-gold/5 rounded-sm border px-5 py-6 text-left wrap-anywhere ${props.class ?? ""}`}
        aria-labelledby={headingId}
      >
        <h3
          id={headingId}
          class="font-display text-gold-ink text-ui-lg mb-1 leading-tight font-light italic"
        >
          {props.closed ? (rows().length === 1 ? "Your guest" : "Your guests") : "Bringing a guest"}
        </h3>
        <Show when={!props.closed && lead()}>
          {(text) => (
            <p class="text-text-muted text-ui-sm leading-ui-normal mb-4 font-light">{text()}</p>
          )}
        </Show>

        <div class="mt-4 flex flex-col gap-5">
          <For each={rows()}>
            {(inviter) => (
              <PlusOneRow
                apiUrl={props.apiUrl}
                inviter={inviter}
                plusOne={plusOneOf(props.members, inviter.guestId)}
                allowed={inviter.plusOneAllowed === true}
                closed={props.closed}
                labelled={!alone()}
                rsvps={props.rsvps}
                onChange={props.onChange}
              />
            )}
          </For>
        </div>

        <p class="text-text-muted text-ui-xs leading-ui-normal mt-5 font-light">
          Your guest won&apos;t see this invitation, so please share our{" "}
          <a
            href="/privacy"
            target="_blank"
            rel="noopener noreferrer"
            class="text-gold-ink underline underline-offset-2"
          >
            privacy notice
          </a>{" "}
          with them. It explains what we keep about them and why.
        </p>
      </section>
    </Show>
  );
}

interface PlusOneRowProps {
  apiUrl: string;
  inviter: FamilyMember;
  plusOne: FamilyMember | undefined;
  /** The inviter may (still) bring a guest: naming and renaming are open. */
  allowed: boolean;
  closed: boolean;
  /** Label the row with whose guest it is — in a household, not for one guest. */
  labelled: boolean;
  rsvps: readonly RsvpSummary[];
  onChange: (update: (result: ClaimResult) => ClaimResult) => void;
}

type Mode = "view" | "edit" | "confirm";

function fullName(member: Pick<FamilyMember, "firstName" | "lastName">): string {
  return `${member.firstName} ${member.lastName}`.trim();
}

/**
 * One member's guest: the form that names them, or the name with its
 * controls. Focus follows every swap, since each one removes the control the
 * guest just pressed.
 */
function PlusOneRow(props: PlusOneRowProps) {
  const labelId = createUniqueId();
  const firstId = createUniqueId();
  const lastId = createUniqueId();

  const [mode, setMode] = createSignal<Mode>("view");
  const [first, setFirst] = createSignal("");
  const [last, setLast] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [notice, setNotice] = createSignal<string | null>(null);

  let firstInput: HTMLInputElement | undefined;
  let changeButton: HTMLButtonElement | undefined;
  let removeButton: HTMLButtonElement | undefined;
  let keepButton: HTMLButtonElement | undefined;

  let inFlight: AbortController | null = null;
  onCleanup(() => inFlight?.abort());

  const url = () => `${props.apiUrl}/api/plus-one/${encodeURIComponent(props.inviter.guestId)}`;

  const open = () => !props.closed;
  const showForm = () => open() && (props.plusOne ? mode() === "edit" : props.allowed);

  /** The named guest has a dietary answer on file, which a new name clears. */
  const hasDietaryOnFile = () => {
    const guest = props.plusOne;
    if (!guest) return false;
    return props.rsvps.some(
      (r) =>
        r.guestId === guest.guestId &&
        (r.dietary.trim().length > 0 || (r.dietaryPresets?.length ?? 0) > 0),
    );
  };

  /** Focus the named guest's first control, once the view has swapped in. */
  function focusNamed() {
    (changeButton ?? removeButton)?.focus();
  }

  /** Run a request, mapping every refusal to words. Resolves to the response
   *  on a 200, or null once the failure is on screen. */
  async function request(init: RequestInit): Promise<Response | null> {
    setBusy(true);
    setError(null);
    setNotice(null);
    inFlight = new AbortController();
    try {
      const res = await fetch(url(), { ...init, credentials: "include", signal: inFlight.signal });
      if (res.ok) return res;
      const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
      setError(
        plusOneRefusalMessage(res.status, typeof body?.error === "string" ? body.error : undefined),
      );
      return null;
    } catch (err) {
      // Abort on unmount is silent; anything else is the network.
      if ((err as { name?: string } | undefined)?.name !== "AbortError") {
        setError("Could not connect. Please check your connection.");
      }
      return null;
    } finally {
      inFlight = null;
      setBusy(false);
    }
  }

  async function save(e: SubmitEvent) {
    e.preventDefault();
    if (busy()) return;
    const firstName = first().trim();
    const lastName = last().trim();
    if (!firstName) {
      setError("Please enter your guest's first name.");
      firstInput?.focus();
      return;
    }
    const adding = props.plusOne === undefined;
    const res = await request({
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ firstName, lastName }),
    });
    if (!res) return;

    const saved: unknown = await res.json().catch(() => null);
    if (!isValidPlusOneSaveResponse(saved)) {
      setError("Your guest was saved, but this page couldn't show it. Please reload the page.");
      return;
    }
    props.onChange((result) => withPlusOneSaved(result, saved));
    setMode("view");
    if (adding && !saved.created) {
      // Another device named someone first; theirs stands, now with this name.
      setNotice(`A guest was already added: ${fullName(saved.plusOne)}.`);
    } else if (saved.dietaryCleared === true) {
      setNotice(
        "The dietary requirements you gave for your guest were cleared. Add them again under Respond.",
      );
    }
    focusNamed();
  }

  function startEdit() {
    const guest = props.plusOne;
    if (!guest) return;
    setFirst(guest.firstName);
    setLast(guest.lastName);
    setError(null);
    setNotice(null);
    setMode("edit");
    firstInput?.focus();
  }

  function cancelEdit() {
    setError(null);
    setMode("view");
    focusNamed();
  }

  function askRemove() {
    setError(null);
    setNotice(null);
    setMode("confirm");
    keepButton?.focus();
  }

  function keep() {
    setMode("view");
    removeButton?.focus();
  }

  async function remove() {
    if (busy()) return;
    const guest = props.plusOne;
    const res = await request({ method: "DELETE" });
    if (!res) return;
    props.onChange((result) => withPlusOneRemoved(result, props.inviter.guestId));
    setFirst("");
    setLast("");
    setMode("view");
    if (guest) setNotice(`${fullName(guest)} removed.`);
    firstInput?.focus();
  }

  return (
    <div role="group" aria-labelledby={props.labelled ? labelId : undefined}>
      <Show when={props.labelled}>
        <p id={labelId} class="font-body text-text-muted text-ui-xs mb-1.5">
          {props.inviter.firstName}&apos;s guest
        </p>
      </Show>

      <Show
        when={showForm()}
        fallback={
          <Show when={props.plusOne}>
            {(guest) => (
              <Show
                when={mode() === "confirm" && open()}
                fallback={
                  <>
                    {/* A name, so a page translator leaves it alone. */}
                    <p class="text-text text-ui-base font-light" translate="no">
                      {fullName(guest())}
                    </p>
                    <Show when={open()}>
                      <div class="mt-1 flex flex-wrap gap-x-4 gap-y-1">
                        <Show when={props.allowed}>
                          <Button
                            variant="touchLink"
                            ref={changeButton}
                            onClick={startEdit}
                            disabled={busy()}
                          >
                            Change name
                          </Button>
                        </Show>
                        <Button
                          variant="touchLink"
                          ref={removeButton}
                          onClick={askRemove}
                          disabled={busy()}
                        >
                          Remove
                        </Button>
                      </div>
                      <Show when={hasUnansweredEvents(guest(), props.rsvps)}>
                        <p class="text-text-muted text-ui-sm mt-2 font-light">
                          Answer for {guest().firstName} under Respond on each event.
                        </p>
                      </Show>
                    </Show>
                  </>
                }
              >
                <p class="text-text text-ui-sm font-light">
                  Remove {fullName(guest())}? Any replies you&apos;ve given for them are removed
                  too.
                </p>
                <div class="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
                  <Button variant="danger" onClick={() => void remove()} disabled={busy()}>
                    {busy() ? "Removing…" : "Yes, remove"}
                  </Button>
                  <Button variant="touchLink" ref={keepButton} onClick={keep} disabled={busy()}>
                    Keep
                  </Button>
                </div>
              </Show>
            )}
          </Show>
        }
      >
        <form class="flex flex-col gap-3" onSubmit={(e) => void save(e)}>
          <div>
            <label for={firstId} class={LABEL}>
              First name
            </label>
            <input
              id={firstId}
              ref={firstInput}
              type="text"
              class={INPUT}
              value={first()}
              onInput={(e) => setFirst(e.currentTarget.value)}
              name="firstName"
              maxLength={NAME_MAX}
              // Someone else's name: the browser's autofill would offer the
              // guest's own, and a spellchecker marks most names as wrong.
              autocomplete="off"
              spellcheck={false}
              disabled={busy()}
            />
          </div>
          <div>
            <label for={lastId} class={LABEL}>
              Last name
            </label>
            <input
              id={lastId}
              type="text"
              class={INPUT}
              value={last()}
              onInput={(e) => setLast(e.currentTarget.value)}
              name="lastName"
              maxLength={NAME_MAX}
              autocomplete="off"
              spellcheck={false}
              disabled={busy()}
            />
          </div>
          <Show when={props.plusOne && hasDietaryOnFile()}>
            <p class="text-text-muted text-ui-sm font-light">
              Changing the name clears the dietary requirements you gave for{" "}
              {props.plusOne?.firstName}.
            </p>
          </Show>
          <div class="flex flex-wrap items-center gap-x-4 gap-y-2">
            <Button type="submit" variant="cta" disabled={busy()}>
              {props.plusOne
                ? busy()
                  ? "Saving…"
                  : "Save name"
                : busy()
                  ? "Adding…"
                  : "Add guest"}
            </Button>
            <Show when={props.plusOne}>
              <Button variant="touchLink" onClick={cancelEdit} disabled={busy()}>
                Cancel
              </Button>
            </Show>
          </div>
        </form>
      </Show>

      <Show when={error()}>
        <p class="text-error text-ui-sm mt-2" role="alert">
          {error()}
        </p>
      </Show>
      <output class="text-text-muted text-ui-sm mt-2 block font-light empty:hidden">
        {notice() ?? ""}
      </output>
    </div>
  );
}
