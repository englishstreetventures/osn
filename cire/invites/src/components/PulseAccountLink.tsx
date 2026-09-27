import Button from "@cire/ui/button";
import { createAuthFetch, isAuthExpired, startSignIn } from "@shared/rp-auth";
import { createSignal, For, Show } from "solid-js";

import type { AccountLinkState, FamilyMember } from "./types";

/**
 * Guest-facing "Link my Pulse account" affordance, shown in the claim and
 * welcome panel (`LoginSection`) after a guest claims their invite, when the
 * claim payload says linking is offered. Purely ADDITIVE: the core invite never
 * depends on this — every failure path (OSN unreachable, sign-in expired)
 * degrades to a quiet control rather than breaking the claimed invite.
 *
 * It makes no request to draw itself. The claim or restore response that
 * opened the invite already says which seats are linked and whether this
 * browser is signed in to OSN (`state`), so the box appears in the same pass as
 * the welcome panel and never pushes events that are already on screen.
 *
 * Flow:
 *   1. Signed out, the guest signs in with their musubi account. That is a
 *      redirect to the identity app and back — the invite origin cannot run the
 *      passkey ceremony itself, because the credential is bound to the
 *      `musubi.social` RP ID. cire-api takes the code and sets its own session
 *      cookie, and the restore that reopens the invite reports it.
 *   2. Signed in, the guest picks WHICH household member they are, then we
 *      `POST /api/account/link` with `{ guestId }` — the cire OSN session cookie
 *      names the account, the `cire_session` guest cookie binds the household,
 *      and both ride along on `credentials: "include"`.
 *   3. Per-member linked/unlinked indicators start from `state`; an unlink
 *      control issues `DELETE /api/account/link/:guestId`.
 */

interface PulseAccountLinkProps {
  /** cire-api origin (same value the rest of the invite islands fetch from). */
  apiUrl: string;
  /** The household members from the claim response — the seats to pick from. */
  members: FamilyMember[];
  /**
   * The household's link state from the claim response. Read once, when the
   * box is created: after that, link and unlink update it here, and a later
   * copy of the same payload (an RSVP save spreads the result) must not undo
   * them.
   */
  state: AccountLinkState;
  /**
   * Placement on the panel that hosts it — width, centring and spacing. The
   * component owns only its own surface, since the claim and welcome panel's
   * layout decides where it sits.
   */
  class?: string;
}

export function PulseAccountLink(props: PulseAccountLinkProps) {
  // Sends the cire OSN session cookie and throws `AuthExpiredError` on a 401.
  const authFetch = createAuthFetch({ apiBase: props.apiUrl });

  // Seeded once from the claim payload (see `state`), then kept here.
  const [signedIn, setSignedIn] = createSignal(props.state.signedIn);
  const [linked, setLinked] = createSignal<Set<string>>(new Set(props.state.linkedGuestIds));

  // The member the guest selected to link (their seat). Null until chosen.
  const [selected, setSelected] = createSignal<string | null>(null);
  const [linking, setLinking] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  const isLinked = (guestId: string) => linked().has(guestId);

  /** Add/remove a guest id from the linked set immutably (so signals react). */
  function setLinkedFor(guestId: string, value: boolean) {
    setLinked((prev) => {
      const next = new Set(prev);
      if (value) next.add(guestId);
      else next.delete(guestId);
      return next;
    });
  }

  async function linkMember(guestId: string) {
    setError(null);
    setLinking(true);
    try {
      // authFetch sends the cire OSN session cookie and throws on 401; the
      // cire_session guest cookie rides along on the same credentialed request.
      const res = await authFetch(`${props.apiUrl}/api/account/link`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ guestId }),
      });
      if (res.status === 201 || res.status === 409) {
        // 409 already-linked is success-shaped here: the seat IS linked, so
        // reflect it rather than surfacing an error.
        setLinkedFor(guestId, true);
        setSelected(null);
        return;
      }
      if (res.status === 503) {
        setError("Account linking isn't available right now.");
        return;
      }
      if (res.status === 403) {
        setError("That isn't one of your household's guests.");
        return;
      }
      setError("Couldn't link your account. Please try again.");
    } catch (err) {
      if (isAuthExpired(err)) {
        // The cire OSN session lapsed since the invite loaded: offer sign-in
        // again, and say why.
        setSignedIn(false);
        setError("Your sign-in expired. Please sign in again.");
        return;
      }
      // Offline or unreachable: the sign-in may be fine, so keep the picker.
      setError("Couldn't link your account. Please try again.");
    } finally {
      setLinking(false);
    }
  }

  async function unlinkMember(guestId: string) {
    setError(null);
    // Optimistic: flip the indicator immediately; the DELETE is idempotent.
    setLinkedFor(guestId, false);
    try {
      const res = await fetch(`${props.apiUrl}/api/account/link/${encodeURIComponent(guestId)}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok && res.status !== 404) {
        // Revert on a real failure (404 is fine — already gone).
        setLinkedFor(guestId, true);
        setError("Couldn't unlink. Please try again.");
      }
    } catch {
      setLinkedFor(guestId, true);
      setError("Couldn't unlink. Please try again.");
    }
  }

  return (
    <section
      class={`border-gold/30 bg-gold/5 rounded-sm border px-5 py-6 text-left ${props.class ?? ""}`}
      aria-labelledby="pulse-link-heading"
    >
      <h3
        id="pulse-link-heading"
        class="font-display text-gold-ink text-ui-lg mb-1 leading-tight font-light italic"
      >
        Link your Pulse account
      </h3>
      <p class="text-text-muted text-ui-sm leading-ui-normal mb-4 font-light">
        Connect your OSN account so this invitation appears in Pulse. Optional — your invite works
        either way.
      </p>

      <Show
        when={signedIn()}
        fallback={
          // Sign-in is a full-page trip to the identity app and back: the
          // guest cookie survives it, so they return to the claimed invite
          // with this panel signed in.
          <div class="flex flex-col gap-3">
            <Show when={error()}>
              <p class="text-error text-ui-sm" role="alert">
                {error()}
              </p>
            </Show>
            <Button
              variant="cta"
              type="button"
              onClick={() => startSignIn({ apiBase: props.apiUrl }, window.location.href)}
              class="self-start"
            >
              Sign in with musubi
            </Button>
          </div>
        }
      >
        {/* Signed in to OSN — pick which household member you are, then link. */}
        <p class="text-text text-ui-sm mb-3 font-light">Which guest are you?</p>
        <ul class="flex flex-col gap-2" aria-label="Household members">
          <For each={props.members}>
            {(member) => (
              // Wraps rather than overflows: inside the narrow panel layout
              // on a phone the row has about 200px, less than a name plus
              // the linked state and its Unlink button need on one line.
              <li class="border-border/60 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-sm border px-3 py-2">
                <span class="flex items-center gap-2">
                  <input
                    type="radio"
                    name="pulse-link-member"
                    class="accent-gold"
                    checked={selected() === member.guestId}
                    disabled={isLinked(member.guestId) || linking()}
                    onChange={() => setSelected(member.guestId)}
                    id={`pulse-link-${member.guestId}`}
                  />
                  <label
                    for={`pulse-link-${member.guestId}`}
                    // The radio is a sibling, not a child, so the base
                    // label rule can't reach it — say "clickable" here.
                    class="text-text text-ui-base cursor-pointer font-light"
                  >
                    {member.firstName} {member.lastName}
                  </label>
                </span>
                <Show
                  when={isLinked(member.guestId)}
                  fallback={
                    <span class="text-text-muted font-body text-ui-xs tracking-ui-wider uppercase">
                      Not linked
                    </span>
                  }
                >
                  <span class="flex items-center gap-2">
                    <output class="text-gold-ink font-body text-ui-xs tracking-ui-wider uppercase">
                      ✓ Linked
                    </output>
                    <Button
                      variant="subtle"
                      size="sm"
                      type="button"
                      onClick={() => void unlinkMember(member.guestId)}
                    >
                      Unlink
                    </Button>
                  </span>
                </Show>
              </li>
            )}
          </For>
        </ul>

        <Show when={error()}>
          <p class="text-error text-ui-sm mt-3" role="alert">
            {error()}
          </p>
        </Show>

        <Button
          variant="cta"
          type="button"
          onClick={() => {
            const id = selected();
            if (id) void linkMember(id);
          }}
          disabled={!selected() || linking()}
          class="mt-4"
        >
          {linking() ? "Linking…" : "Link my account"}
        </Button>
      </Show>
    </section>
  );
}
