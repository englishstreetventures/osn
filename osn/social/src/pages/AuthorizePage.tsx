import type { AuthorizeContext, PublicProfile } from "@osn/client";
import { AuthorizeError } from "@osn/client";
import { Avatar, AvatarFallback, AvatarImage } from "@osn/ui/ui/avatar";
import { Button } from "@osn/ui/ui/button";
import { useSearchParams } from "@solidjs/router";
import {
  createMemo,
  createResource,
  createSignal,
  For,
  lazy,
  Match,
  onCleanup,
  Show,
  Suspense,
  Switch,
} from "solid-js";

import { authorizeClient } from "../lib/authorize";
import { profileInitials, safeAvatarUrl } from "../lib/utils";

/**
 * The OIDC consent screen.
 *
 * The page is handed one opaque request id and nothing else — every OAuth
 * parameter (client, scopes, redirect URI, state) stays parked server-side, so
 * a tampered address bar cannot widen what the user approves. Everything
 * rendered here comes from `GET /authorize/context`.
 *
 * Rules this page must not break (see [[authorize-ui]]):
 *   - never render an OAuth parameter out of its own URL;
 *   - `redirectTo` is opaque — assign it verbatim, never parse or rewrite it;
 *   - a denial is a decision — Cancel posts `approved: false` rather than
 *     abandoning the request for the rest of its 10-minute life;
 *   - nothing from the context is persisted locally.
 */

const REQUEST_PATTERN = /^oar_[a-f0-9]{12}$/;

/**
 * Sign-in drags in the Effect runtime, the WebAuthn client and five auth
 * clients. The common case — an already-signed-in user — never reaches it, so
 * it loads only on the branch that needs it.
 */
const AuthorizeSignIn = lazy(() =>
  import("../components/AuthorizeSignIn").then((m) => ({ default: m.AuthorizeSignIn })),
);

/**
 * The only user-facing strings with security weight. One map, so a reviewer
 * can read every claim the user is agreeing to hand over in one place.
 */
const SCOPE_COPY: Record<string, { label: string; detail?: string }> = {
  openid: { label: "Confirm who you are" },
  profile: { label: "See your profile", detail: "Name, handle and picture." },
  email: {
    label: "See your email address",
    detail:
      "Your email belongs to your account, not this profile — every app you allow sees the same one.",
  },
};

const scopeLabel = (scope: string) => SCOPE_COPY[scope]?.label ?? scope;
const scopeDetail = (scope: string) => SCOPE_COPY[scope]?.detail ?? null;

/** The one place the page leaves for the relying party. */
export function navigateTo(url: string) {
  window.location.assign(url);
}

type Screen = "loading" | "signedOut" | "picker" | "consent" | "redirecting" | "dead" | "error";

/**
 * A-L1. `<Switch>` swaps the whole screen without moving focus, so a screen
 * reader is told nothing when the page flips to "Taking you back…" or to a
 * terminal state — the user is left on a page that silently changed under
 * them. One polite live region announces each transition.
 *
 * Short labels, not the screen's own copy: the region names what happened so
 * the user knows to go read, rather than reciting a card they are about to
 * hear anyway. "error" stays out of it — that screen already carries a
 * `role="alert"`, and announcing both talks over the message twice.
 */
const SCREEN_ANNOUNCEMENT: Record<Screen, string | null> = {
  loading: "Checking this request.",
  signedOut: "Sign in to continue.",
  picker: "Choose a profile.",
  consent: "Review what this app is asking for.",
  redirecting: "Taking you back to the app.",
  dead: "This sign-in request cannot continue.",
  error: null,
};

const sameProfileSet = (before: ReadonlySet<string>, after: readonly PublicProfile[]) =>
  after.length === before.size && after.every((p) => before.has(p.id));

export function AuthorizePage() {
  const [params] = useSearchParams();
  const requestId = createMemo(() => {
    const raw = params.request;
    const value = Array.isArray(raw) ? raw[0] : raw;
    return typeof value === "string" && REQUEST_PATTERN.test(value) ? value : null;
  });
  // Advisory only — the server re-derives every requirement at decision time.
  const reason = createMemo(() => {
    const raw = params.reason;
    return Array.isArray(raw) ? raw[0] : raw;
  });

  // The context READ hangs off this controller, aborted when the page goes
  // away — a read left in flight past unmount holds a connection open and
  // resolves into a component that no longer exists.
  //
  // S-M1: the decision POST deliberately does NOT. Aborting a fetch does not
  // un-send it, and that call is what records consent and mints the code — so
  // cancelling it client-side cannot undo the grant, it only hides that the
  // grant may have happened. Reads are safe to abandon; writes are not.
  const inflightRead = new AbortController();
  onCleanup(() => inflightRead.abort());

  const [context, { refetch }] = createResource(requestId, (id) =>
    authorizeClient.getContext(id, { signal: inflightRead.signal }),
  );

  const [chosenId, setChosenId] = createSignal<string | null>(null);
  const [pickerOpen, setPickerOpen] = createSignal(false);
  const [submitting, setSubmitting] = createSignal(false);
  const [redirecting, setRedirecting] = createSignal(false);
  // Set when the decision came back `login_required` / `unauthorized`: the
  // parked request is still alive, so we re-authenticate and post the SAME
  // request id again rather than restarting the flow.
  const [reauth, setReauth] = createSignal(false);
  // How many times the decision has bounced back `login_required` after a fresh
  // sign-in. A relying party with a tiny `max_age` can make every replay fail
  // the freshness check again; without a ceiling the user is trapped repeating
  // passkey ceremonies. After MAX_REAUTH_ATTEMPTS we stop and show a terminal
  // "go back to the app" screen instead of looping.
  const MAX_REAUTH_ATTEMPTS = 2;
  const [reauthCount, setReauthCount] = createSignal(0);
  // `reason=login` (and `reason=create`) mean the flow demands a session
  // created after the request was parked, so the ceremony leads even when a
  // session already exists. One sign-in on this page satisfies it — the flag
  // is what stops the sign-in screen looping, since the URL still says
  // `login` / `create` afterwards.
  const [signedInHere, setSignedInHere] = createSignal(false);
  const [pending, setPending] = createSignal<boolean | null>(null);
  const [fatal, setFatal] = createSignal<string | null>(null);
  const [notice, setNotice] = createSignal<string | null>(null);

  const ctx = (): AuthorizeContext | undefined => (context.error ? undefined : context());
  const profiles = () => ctx()?.profiles ?? [];

  const selectedId = createMemo(
    () => chosenId() ?? ctx()?.linkedProfileId ?? profiles()[0]?.id ?? null,
  );
  const selected = createMemo(() => profiles().find((p) => p.id === selectedId()) ?? null);

  /**
   * The picker leads when there is a real choice to make: several profiles and
   * either the app asked for one (`select_account`) or it has never seen any of
   * them. Single-profile accounts — the common case — never see this screen.
   */
  const autoPicker = createMemo(() => {
    const c = ctx();
    if (!c || c.profiles.length < 2) return false;
    return reason() === "select_account" || c.linkedProfileId === null;
  });
  const showPicker = createMemo(() => pickerOpen() || (autoPicker() && chosenId() === null));

  /** Terminal states name the app only if context was ever loaded. */
  const clientName = () => ctx()?.client.name ?? null;

  const deadMessage = createMemo(() => {
    if (fatal()) return fatal();
    if (requestId() === null) return "This sign-in link is not valid.";
    const err = context.error;
    if (err instanceof AuthorizeError && err.terminal) {
      return err.code === "invalid_client"
        ? "This app is no longer able to sign you in."
        : "This sign-in request has expired.";
    }
    return null;
  });

  /**
   * A context failure the request survives — rate limiting, or the network.
   * Retryable, so it gets a message and a button rather than the spinner it
   * would otherwise sit behind for ever.
   */
  const loadError = createMemo(() => {
    const err = context.error;
    if (!err || (err instanceof AuthorizeError && err.terminal)) return null;
    return err instanceof Error && err.message ? err.message : "Something went wrong.";
  });

  // `<Switch>` asks each `Match` in turn, so this is the one tracked value the
  // whole page hangs off — computed once per change, not once per branch.
  const screen = createMemo((): Screen => {
    if (redirecting()) return "redirecting";
    if (deadMessage()) return "dead";
    if (loadError()) return "error";
    if (context.loading || !ctx()) return "loading";
    const fresh = reason() === "login" || reason() === "create";
    if (!ctx()!.signedIn || reauth() || (fresh && !signedInHere())) {
      return "signedOut";
    }
    if (showPicker()) return "picker";
    return "consent";
  });

  /** A retryable failure — the request survives, the page does not restart. */
  function softFail(message: string) {
    setNotice(message);
    setSubmitting(false);
  }

  async function decide(approved: boolean) {
    const id = requestId();
    const profileId = selectedId();
    if (!id || !profileId || submitting()) return;
    setSubmitting(true);
    setNotice(null);
    try {
      const { redirectTo } = await authorizeClient.submitDecision({
        requestId: id,
        profileId,
        approved,
      });
      setRedirecting(true);
      navigateTo(redirectTo);
    } catch (err) {
      if (err instanceof AuthorizeError) {
        if (err.terminal) {
          setFatal(
            err.code === "invalid_client"
              ? "This app is no longer able to sign you in."
              : "This sign-in request has expired.",
          );
          setSubmitting(false);
          return;
        }
        if (err.needsSignIn) {
          // A fresh sign-in already didn't satisfy the freshness demand this
          // many times — stop looping and end the flow.
          if (reauthCount() >= MAX_REAUTH_ATTEMPTS) {
            setFatal(
              "This app keeps asking for a newer sign-in than we can provide. Go back to the app and try again.",
            );
            setSubmitting(false);
            return;
          }
          setReauthCount((n) => n + 1);
          // Hold the answer; replay it once the fresh session exists.
          setPending(approved);
          setReauth(true);
          setSubmitting(false);
          setNotice("Please sign in again to continue.");
          return;
        }
      }
      softFail(err instanceof Error ? err.message : "Something went wrong. Try again.");
    }
  }

  /**
   * The held answer belongs to whoever read the client card and clicked it.
   * Replaying it after a sign-in is only safe while that is still the account
   * on screen — on a shared device the person who re-authenticates may not be
   * the person who answered. Context carries no account id, so the profile set
   * is the proxy: if it changed, the answer is dropped and the consent screen
   * is shown again with the new account's profiles.
   */
  async function afterSignIn() {
    setReauth(false);
    setSignedInHere(true);
    setNotice(null);
    const before = new Set(profiles().map((p) => p.id));
    const answer = pending();
    setPending(null);
    await refetch();
    if (!sameProfileSet(before, profiles())) {
      setChosenId(null);
      if (answer !== null) {
        setNotice("You signed in as a different account — check this before continuing.");
      }
      return;
    }
    if (answer !== null) await decide(answer);
  }

  return (
    <main class="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center px-6 py-10">
      {/* A-L1: the region itself is always mounted — a live region added to
          the DOM at the same moment as its text is not reliably announced.
          `<output>` carries an implicit `role="status"` (and with it
          `aria-live="polite"`), which is the semantic element for a value the
          page computes rather than one the user typed. */}
      <output class="sr-only" aria-live="polite">
        {SCREEN_ANNOUNCEMENT[screen()]}
      </output>
      <Switch>
        <Match when={screen() === "loading"}>
          <p class="text-muted-foreground text-body text-center">Checking this request…</p>
        </Match>

        <Match when={screen() === "dead"}>
          <div class="border-border rounded-card border p-6 text-center">
            <h1 class="text-foreground text-title font-medium">{deadMessage()}</h1>
            <p class="text-muted-foreground text-body mt-2">
              <Show when={clientName()} fallback="Go back to the app you came from and try again.">
                {(name) => <>Go back to {name()} and start again.</>}
              </Show>
            </p>
          </div>
        </Match>

        <Match when={screen() === "error"}>
          <div class="border-border rounded-card border p-6 text-center">
            <h1 class="text-foreground text-title font-medium">Could not load this request</h1>
            <p class="text-muted-foreground text-body mt-2" role="alert">
              {loadError()}
            </p>
            <Button class="mt-4" onClick={() => void refetch()}>
              Try again
            </Button>
          </div>
        </Match>

        <Match when={screen() === "redirecting"}>
          <p class="text-muted-foreground text-body text-center">Taking you back…</p>
        </Match>

        <Match when={screen() === "signedOut"}>
          <ClientCard context={ctx()} />
          <Show when={notice()}>
            {(message) => (
              <p class="text-muted-foreground text-body mt-4 text-center">{message()}</p>
            )}
          </Show>
          <div class="border-border rounded-card mt-4 border p-1">
            <Suspense
              fallback={<p class="text-muted-foreground text-body p-4 text-center">Loading…</p>}
            >
              {/* `reason` is advisory — it only picks which half of the panel
                  leads. The server re-derives every requirement at decision
                  time, so a tampered value widens nothing.

                  `signedInHere()` is what keeps `reason=create` from leading
                  with sign-up a second time. The URL still says `create` after
                  the account exists, so a later bounce back to this screen — a
                  `login_required` replay, or a decision the server refused —
                  would otherwise reopen "Create your OSN account" at someone
                  who has just made one, which reads as the flow having thrown
                  the new account away. Once a ceremony has happened on this
                  page, the way forward is signing in. */}
              <AuthorizeSignIn
                initialMode={reason() === "create" && !signedInHere() ? "register" : "signIn"}
                onSuccess={() => void afterSignIn()}
              />
            </Suspense>
          </div>
        </Match>

        <Match when={screen() === "picker"}>
          <h1 class="text-foreground text-title mb-1 font-medium">Choose a profile</h1>
          <p class="text-muted-foreground text-body mb-4">
            {clientName()} will see the profile you pick, and only that one.
          </p>
          <div class="flex flex-col gap-2">
            <For each={profiles()}>
              {(profile) => (
                <button
                  type="button"
                  class="border-border hover:bg-muted flex items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors"
                  onClick={() => {
                    setChosenId(profile.id);
                    setPickerOpen(false);
                  }}
                >
                  <ProfileAvatar profile={profile} />
                  <div class="flex min-w-0 flex-col">
                    <span class="text-foreground text-body truncate font-medium">
                      {profile.displayName || `@${profile.handle}`}
                    </span>
                    <span class="text-subtle text-meta truncate">@{profile.handle}</span>
                  </div>
                </button>
              )}
            </For>
          </div>
          <Show when={ctx()?.linkedProfileId}>
            <p class="text-muted-foreground text-meta mt-4">
              {clientName()} already knows one of these profiles. Picking a different one looks like
              a different person to it.
            </p>
          </Show>
          {/* A decline path from the picker too: without it, refusing means
              abandoning the tab, which leaves the request alive for its TTL.
              Deny grants nothing, so the fallback profile id is harmless. */}
          <div class="mt-6">
            <Button
              variant="secondary"
              class="w-full"
              disabled={submitting()}
              onClick={() => void decide(false)}
            >
              Cancel
            </Button>
          </div>
        </Match>

        <Match when={screen() === "consent"}>
          <ClientCard context={ctx()} />

          <ul class="mt-6 flex flex-col gap-3">
            <For each={ctx()?.scopes ?? []}>
              {(scope) => (
                <li class="border-border rounded-card border p-3">
                  <p class="text-foreground text-body font-medium">{scopeLabel(scope)}</p>
                  <Show when={scopeDetail(scope)}>
                    {(detail) => <p class="text-muted-foreground text-meta mt-1">{detail()}</p>}
                  </Show>
                </li>
              )}
            </For>
          </ul>

          <Show when={selected()}>
            {(profile) => (
              <div class="border-border mt-6 flex items-center gap-3 rounded-lg border px-3 py-2.5">
                <ProfileAvatar profile={profile()} />
                <div class="flex min-w-0 flex-1 flex-col">
                  <span class="text-foreground text-body truncate font-medium">
                    {profile().displayName || `@${profile().handle}`}
                  </span>
                  <span class="text-subtle text-meta truncate">@{profile().handle}</span>
                </div>
                <Show when={profiles().length > 1}>
                  <Button
                    variant="secondary"
                    size="sm"
                    class="text-meta"
                    onClick={() => setPickerOpen(true)}
                  >
                    Change
                  </Button>
                </Show>
              </div>
            )}
          </Show>

          <Show when={notice()}>
            {(message) => (
              <p class="text-destructive text-body mt-4" role="alert">
                {message()}
              </p>
            )}
          </Show>

          <div class="mt-6 flex gap-2">
            <Button
              class="flex-1"
              disabled={submitting() || !selectedId()}
              onClick={() => void decide(true)}
            >
              Allow
            </Button>
            <Button
              variant="secondary"
              class="flex-1"
              disabled={submitting()}
              onClick={() => void decide(false)}
            >
              Cancel
            </Button>
          </div>
          <p class="text-subtle text-meta mt-3 text-center">
            You can undo this later in your OSN settings.
          </p>
        </Match>
      </Switch>
    </main>
  );
}

function ProfileAvatar(props: { profile: PublicProfile }) {
  return (
    <Avatar class="h-9 w-9">
      {/* No `loading="lazy"`: the avatar is inside the first viewport on both
          the picker and the consent screen, so deferring it only costs a round
          trip. */}
      <Show when={safeAvatarUrl(props.profile.avatarUrl)}>
        {(url) => (
          <AvatarImage src={url()} alt={props.profile.handle} referrerpolicy="no-referrer" />
        )}
      </Show>
      <AvatarFallback class="text-meta">{profileInitials(props.profile)}</AvatarFallback>
    </Avatar>
  );
}

function ClientCard(props: { context: AuthorizeContext | undefined }) {
  const client = () => props.context?.client;
  return (
    <div class="flex flex-col items-center text-center">
      {/* The logo URL is untrusted input — render it as an image source and
          nothing else, never interpolated into markup. */}
      <Show when={safeAvatarUrl(client()?.logoUrl)}>
        {(url) => (
          <img
            src={url()}
            alt=""
            class="border-border mb-4 h-12 w-12 rounded-lg border object-cover"
            referrerpolicy="no-referrer"
          />
        )}
      </Show>
      <h1 class="text-foreground text-title font-medium">{client()?.name}</h1>
      <p class="text-muted-foreground text-body mt-1">wants to use your OSN account</p>
      {/* Verifiable identity signal. The name above is self-asserted and can
          impersonate a first-party app; the redirect host is what the client
          actually registered, and third-party clients are called out so a
          look-alike cannot pass itself off as an OSN app. */}
      <Show
        when={client()?.firstParty}
        fallback={
          <p class="text-muted-foreground text-caption mt-3 flex flex-wrap items-center justify-center gap-x-1.5 gap-y-1">
            <span class="border-border text-muted-foreground rounded-full border px-2 py-0.5 font-medium">
              Third-party app
            </span>
            <Show when={client()?.redirectDomain}>
              {(domain) => (
                <span>
                  sends you to <span class="text-foreground font-medium">{domain()}</span>
                </span>
              )}
            </Show>
          </p>
        }
      >
        <p class="text-caption mt-3 font-medium text-emerald-600 dark:text-emerald-400">
          Verified OSN app
        </p>
      </Show>
    </div>
  );
}
