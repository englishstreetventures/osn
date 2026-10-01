import Button from "@cire/ui/button";
import { createAuthFetch, isAuthExpired, startSignIn } from "@shared/rp-auth";
import { createSignal, Match, Show, Switch } from "solid-js";

import type { AccountLinkState, FamilyMember, SignedInAccount } from "./types";

/**
 * Guest-facing "Link your musubi account" box, shown in the claim and welcome
 * panel (`LoginSection`) once the household has said who is at the keyboard
 * ("Who are you?"). Purely ADDITIVE: the core invite never depends on this —
 * every failure path degrades to a quiet control rather than breaking the
 * claimed invite.
 *
 * It makes no request to draw itself. The claim or restore response (or the
 * member choice) already says whether the member is linked, whether this
 * browser is signed in to musubi, and — when it is safe to show — which
 * account that is (`state.account`).
 *
 * What it shows, for the chosen member:
 *
 * | Member linked? | Signed in? | Account matches? | Shows |
 * |---|---|---|---|
 * | no | no | — | "Sign in with musubi" |
 * | no | yes | — | picture, name and `@handle`: "Link {name} to @handle?" |
 * | yes | yes | yes | picture, name and `@handle` |
 * | yes | yes | no | "{name} is linked to a different musubi account" — no account shown |
 * | yes | no | — | "{name} · linked to musubi", and "Sign in to manage" |
 *
 * Every sign-in sends `prompt=select_account`, so musubi always shows which
 * account is signed in, with "Use another account", and never re-grants
 * silently as whoever last used this browser. "Not you?" is the household
 * panel's one control (`onNotYou`): it clears the member and ends this
 * browser's cire musubi sign-in.
 *
 * The picture loads only from musubi's own host: cire-api drops any other
 * avatar URL (the guest site's CSP is report-only and lists no avatar host).
 * When there is none, or it fails to load, the box shows the account's
 * initial.
 */
interface PulseAccountLinkProps {
  /** cire-api origin (same value the rest of the invite islands fetch from). */
  apiUrl: string;
  /** The household member this session chose. */
  member: FamilyMember;
  /** The household's link state, as the page holds it. */
  state: AccountLinkState;
  /** The member is now linked (201, or 409 — linked either way). */
  onLinked: (guestId: string) => void;
  /** The member's link is gone. */
  onUnlinked: (guestId: string) => void;
  /** "Not you?" — clear the member and end the musubi sign-in. */
  onNotYou: () => void;
  /**
   * Placement on the panel that hosts it — width, centring and spacing. The
   * component owns only its own surface.
   */
  class?: string;
}

/** The account's picture, or its initial when there is none or it will not load. */
function AccountPicture(props: { account: SignedInAccount }) {
  const [failed, setFailed] = createSignal(false);
  const initial = () =>
    (props.account.displayName ?? props.account.handle ?? "?").trim().charAt(0).toUpperCase() ||
    "?";
  return (
    <Show
      when={props.account.avatarUrl !== null && !failed()}
      fallback={
        <span
          class="bg-gold/15 text-gold-ink font-display text-ui-md flex size-10 shrink-0 items-center justify-center rounded-full"
          aria-hidden="true"
        >
          {initial()}
        </span>
      }
    >
      <img
        src={props.account.avatarUrl ?? undefined}
        alt=""
        width="40"
        height="40"
        referrerpolicy="no-referrer"
        class="size-10 shrink-0 rounded-full object-cover"
        onError={() => setFailed(true)}
      />
    </Show>
  );
}

/** Picture, display name and `@handle`, side by side. */
function AccountCard(props: { account: SignedInAccount }) {
  return (
    // `min-w-0 max-w-full`: a long name or handle truncates inside the box
    // rather than pushing it past the panel on a phone.
    <div class="flex max-w-full min-w-0 items-center gap-3">
      <AccountPicture account={props.account} />
      <span class="flex min-w-0 flex-col">
        <Show when={props.account.displayName}>
          {(name) => <span class="text-text text-ui-base truncate font-light">{name()}</span>}
        </Show>
        <Show when={props.account.handle}>
          {(handle) => (
            <span class="text-text-muted text-ui-sm truncate font-light">@{handle()}</span>
          )}
        </Show>
      </span>
    </div>
  );
}

export function PulseAccountLink(props: PulseAccountLinkProps) {
  // Sends the cire OSN session cookie and throws `AuthExpiredError` on a 401.
  const authFetch = createAuthFetch({ apiBase: props.apiUrl });

  const [linking, setLinking] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  // A sign-in that lapsed since the invite loaded: offer sign-in again.
  const [expired, setExpired] = createSignal(false);

  const linked = () => props.state.linkedGuestIds.includes(props.member.guestId);
  const signedIn = () => props.state.signedIn && !expired();
  const account = () => (signedIn() ? props.state.account : undefined);
  const handleLabel = () => {
    const handle = account()?.handle;
    return handle ? `@${handle}` : "this account";
  };

  function signIn() {
    startSignIn({ apiBase: props.apiUrl }, window.location.href, { prompt: "select_account" });
  }

  async function link() {
    setError(null);
    setLinking(true);
    try {
      // No body: the server links the member this session chose. The guest
      // and OSN cookies ride the same credentialed request.
      const res = await authFetch(`${props.apiUrl}/api/account/link`, {
        method: "POST",
        credentials: "include",
      });
      if (res.status === 201 || res.status === 409) {
        // 409 already-linked is success-shaped here — unless the server
        // says no member is chosen, which the page fixes by asking again.
        const code = res.status === 409 ? await failureCode(res) : undefined;
        if (code === "member_required") {
          props.onNotYou();
          return;
        }
        props.onLinked(props.member.guestId);
        return;
      }
      if (res.status === 503) {
        setError("Account linking isn't available right now.");
        return;
      }
      setError("Couldn't link your account. Please try again.");
    } catch (err) {
      if (isAuthExpired(err)) {
        setExpired(true);
        setError("Your sign-in expired. Please sign in again.");
        return;
      }
      setError("Couldn't link your account. Please try again.");
    } finally {
      setLinking(false);
    }
  }

  async function unlink() {
    setError(null);
    const guestId = props.member.guestId;
    try {
      const res = await fetch(`${props.apiUrl}/api/account/link/${encodeURIComponent(guestId)}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (res.ok || res.status === 404) {
        props.onUnlinked(guestId);
        return;
      }
      setError(
        res.status === 403
          ? "Only the musubi account this seat is linked to can unlink it."
          : "Couldn't unlink. Please try again.",
      );
    } catch {
      setError("Couldn't unlink. Please try again.");
    }
  }

  const notYouButton = () => (
    <Button variant="subtle" size="sm" type="button" onClick={() => props.onNotYou()}>
      Not you?
    </Button>
  );

  return (
    <section
      class={`border-gold/30 bg-gold/5 rounded-sm border px-5 py-6 text-left ${props.class ?? ""}`}
      aria-labelledby="pulse-link-heading"
    >
      <h3
        id="pulse-link-heading"
        class="font-display text-gold-ink text-ui-lg mb-1 leading-tight font-light italic"
      >
        Link your musubi account
      </h3>
      <p class="text-text-muted text-ui-sm leading-ui-normal mb-4 font-light">
        Connect your musubi account so this invitation appears in Pulse. Optional — your invite
        works either way.
      </p>

      <Switch>
        {/* Linked, and this browser is signed in as that account. */}
        <Match when={linked() && account()}>
          {(acct) => (
            <div class="flex flex-wrap items-center justify-between gap-3">
              <AccountCard account={acct()} />
              <span class="flex items-center gap-2">
                <output class="text-gold-ink font-body text-ui-xs tracking-ui-wider uppercase">
                  ✓ Linked
                </output>
                <Button variant="subtle" size="sm" type="button" onClick={() => void unlink()}>
                  Unlink
                </Button>
                {notYouButton()}
              </span>
            </div>
          )}
        </Match>
        {/* Linked, signed in as someone else: show neither account. */}
        <Match when={linked() && signedIn()}>
          <p class="text-text text-ui-sm mb-3 font-light">
            {props.member.firstName} is linked to a different musubi account.
          </p>
          {notYouButton()}
        </Match>
        {/* Linked, not signed in on this browser. Only the linked account can
            release the seat, so managing it starts with signing in. */}
        <Match when={linked()}>
          <div class="flex flex-wrap items-center gap-3">
            <p class="text-text text-ui-sm font-light">
              {props.member.firstName} · linked to musubi
            </p>
            <Button variant="subtle" size="sm" type="button" onClick={signIn}>
              Sign in to manage
            </Button>
            {notYouButton()}
          </div>
        </Match>
        {/* Not linked, signed in: name the account before anything is bound. */}
        <Match when={account()}>
          {(acct) => (
            <div class="flex flex-col gap-3">
              <AccountCard account={acct()} />
              <p class="text-text text-ui-sm font-light">
                Link {props.member.firstName} to {handleLabel()}?
              </p>
              <span class="flex flex-wrap items-center gap-2">
                <Button
                  variant="cta"
                  type="button"
                  onClick={() => void link()}
                  disabled={linking()}
                >
                  {linking() ? "Linking…" : "Link"}
                </Button>
                {notYouButton()}
              </span>
            </div>
          )}
        </Match>
        {/* Not linked, not signed in (or signed in with no account to show). */}
        <Match when={true}>
          <Button variant="cta" type="button" onClick={signIn} class="self-start">
            Sign in with musubi
          </Button>
        </Match>
      </Switch>

      <Show when={error()}>
        <p class="text-error text-ui-sm mt-3" role="alert">
          {error()}
        </p>
      </Show>
    </section>
  );
}

/** The machine-readable `error` code of a refusal, if its body has one. */
async function failureCode(res: Response): Promise<string | undefined> {
  const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
  return typeof body?.error === "string" ? body.error : undefined;
}
