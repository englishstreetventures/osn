import {
  clearAuthError,
  readAuthError,
  resumeSession,
  startSignIn,
  type RpAuthConfig,
} from "@shared/rp-auth";
import { Notice } from "@shared/ui/ui/notice";
import { createSignal, onMount, Show } from "solid-js";

import Button from "./button";
import { createSignInPress } from "./sign-in-press";

/**
 * The portals' sign-in: one button that leaves for musubi, and the line that
 * explains a sign-in that came back without a session.
 *
 * A portal cannot run the passkey ceremony itself: a WebAuthn credential can
 * only be used on an origin same-site with its RP ID, and identity lives on
 * `musubi.social`. So the button hands off to cire/api's OIDC start leg, which
 * sends the person to musubi and takes the code back in exchange for a cire
 * session cookie. The host and vendor portals say the same words here; the
 * page around it names the portal (`sign-in-card.astro`).
 *
 * **One button, not two.** There is no "Create account with musubi": both
 * would leave for the same issuer and end in the same place, and only the
 * issuer knows whether this person has an account. Its sign-in screen offers
 * "No account yet? Create one", so nobody is stranded, and cire never guesses.
 *
 * **The page does not leave on its own.** It asks cire/api, behind the page,
 * whether this browser already holds a cire session, and carries someone who
 * does to where they were going. That question reaches only cire's own cookie:
 * the issuer's is `SameSite=Lax`, so no background request from here carries
 * it.
 *
 * **After the press**, only the label changes, to "Connecting to musubi…", at
 * full strength; a second press is ignored and announced, and a back-forward
 * restore or `SIGN_IN_PENDING_RESET_MS` puts the button back. That is
 * `createSignInPress` (`sign-in-press.ts`), which the vendor's claim page
 * shares; the panel renders its hidden status line.
 *
 * `auth` is the four `@shared/rp-auth` calls the panel makes, so a story or a
 * test can show each state without leaving the page. Every portal passes
 * nothing and gets the real ones.
 */

export interface SignInAuth {
  startSignIn(config: RpAuthConfig, returnTo: string): void;
  resumeSession(config: RpAuthConfig, options: { home: string }): Promise<boolean>;
  readAuthError(): string | null;
  clearAuthError(): void;
}

const RP_AUTH: SignInAuth = {
  startSignIn: (config, returnTo) => startSignIn(config, returnTo),
  resumeSession: (config, options) => resumeSession(config, options),
  readAuthError: () => readAuthError(),
  clearAuthError: () => clearAuthError(),
};

/** The line under each `?auth_error=` marker the start and callback legs send. */
const FAILED = "Sign-in did not go through. Try again.";
const ERROR_COPY = new Map([
  ["sign_in_declined", "Sign-in was cancelled. Nothing was shared with Cire."],
  ["sign_in_failed", FAILED],
  ["sign_in_unavailable", "Sign-in is temporarily unavailable. Please try again shortly."],
]);

/** The line for a marker off the URL. The set is open — a marker comes from
 *  outside — so one the panel does not know gets the failed line. A `Map`, so
 *  a marker such as `toString` finds nothing on a prototype. */
function errorCopy(marker: string): string {
  return ERROR_COPY.get(marker) ?? FAILED;
}

const COPY = "base:font-ui-body base:text-ui-ink-secondary base:text-ui-sm base:leading-ui-normal";

/**
 * Where to land after signing in. A 401 mid-session sends someone here with
 * `?returnTo=<path>` so they resume on the page they were on. Only a
 * same-origin path is followed — never an absolute URL, a protocol-relative
 * `//`, a backslash (which browsers read as a slash) or `/login` itself —
 * and anything else lands on the dashboard root, so a crafted link cannot
 * turn this into an open redirect.
 */
function resumeTarget(): string {
  const root = new URL("/", window.location.origin).toString();
  const raw = new URLSearchParams(window.location.search).get("returnTo");
  if (!raw || !raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\")) return root;
  try {
    const url = new URL(raw, window.location.origin);
    // Compared in the slash form the page is served at, `/login/`, so the
    // bundle names it only as it is linked.
    if (url.origin !== window.location.origin || url.pathname.replace(/\/*$/, "/") === "/login/") {
      return root;
    }
    // A marker carried inside the page someone was on belongs to a sign-in
    // that already happened; forwarded, it would greet them again on return.
    url.searchParams.delete("auth_error");
    return url.toString();
  } catch {
    return root;
  }
}

export default function SignInPanel(props: { apiBase: string; auth?: SignInAuth }) {
  const auth = () => props.auth ?? RP_AUTH;
  const config = (): RpAuthConfig => ({ apiBase: props.apiBase });
  const [error, setError] = createSignal<string | null>(null);
  const signIn = createSignInPress(() => auth().startSignIn(config(), resumeTarget()));

  onMount(() => {
    const marker = auth().readAuthError();
    if (marker) {
      setError(errorCopy(marker));
      // Drop the marker so a reload does not show it again.
      auth().clearAuthError();
    }
    // Behind the rendered page, so the button is usable straight away.
    void auth().resumeSession(config(), { home: resumeTarget() });
  });

  return (
    <div class="base:flex base:flex-col base:gap-6">
      {/* `alert` because it answers something the person just did: they came
          back from the issuer without a session. */}
      <Show when={error()}>
        {(message) => (
          <Notice tone="danger" alert>
            {message()}
          </Notice>
        )}
      </Show>

      <p class={COPY}>
        Cire uses your musubi account to sign you in. Your passkey stays with musubi — Cire never
        sees it.
      </p>

      <Button
        variant="primary"
        size="lg"
        type="button"
        onClick={() => signIn.press()}
        class="w-full"
      >
        {signIn.label()}
      </Button>
      <output class="base:sr-only">{signIn.status()}</output>

      <p class={COPY}>No musubi account yet? You can create one on the next screen.</p>
    </div>
  );
}
