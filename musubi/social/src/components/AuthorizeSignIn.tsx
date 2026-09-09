import { AuthProvider } from "@osn/client/solid";
import { Register } from "@osn/ui/auth/Register";
import { SignIn } from "@osn/ui/auth/SignIn";
import { createSignal, Show } from "solid-js";

import { OSN_ISSUER_URL, TURNSTILE_SITEKEY } from "../lib/auth";
import { loginClient, recoveryClient, registrationClient } from "../lib/authClients";

/**
 * The sign-in half of the consent screen, kept behind a `lazy()` boundary.
 *
 * `SignIn` needs `AuthProvider`, and `AuthProvider` bootstraps a session on
 * mount — `POST /token`, which rotates the refresh session — plus a profile
 * list the consent screen never reads (`GET /authorize/context` already
 * carries both). Neither belongs on the signed-in path, which is the common
 * one, so the provider is mounted here rather than around the route: the
 * Effect runtime and the WebAuthn code load only when a ceremony is actually
 * required.
 *
 * Both halves of "who are you" live here. A visitor sent by an app they have
 * never used may not have an OSN account at all, and until this screen offered
 * a way to make one they were simply stuck: registration used to exist only
 * inside the identity app's own sidebar, which is not where the redirect
 * lands. `mode` starts on registration when the relying party asked for it
 * with `prompt=create`.
 */
export function AuthorizeSignIn(props: {
  onSuccess: () => void;
  /** `"register"` when the app sent `prompt=create`. */
  initialMode?: "signIn" | "register";
}) {
  const [mode, setMode] = createSignal<"signIn" | "register">(props.initialMode ?? "signIn");

  return (
    <AuthProvider config={{ issuerUrl: OSN_ISSUER_URL }}>
      <Show
        when={mode() === "register"}
        fallback={
          <>
            <SignIn
              client={loginClient}
              recoveryClient={recoveryClient}
              turnstileSiteKey={TURNSTILE_SITEKEY}
              onSuccess={() => props.onSuccess()}
            />
            <p class="text-muted-foreground text-body px-4 pb-4 text-center">
              No account yet?{" "}
              <button
                type="button"
                class="text-foreground font-medium underline underline-offset-2"
                onClick={() => setMode("register")}
              >
                Create one
              </button>
            </p>
          </>
        }
      >
        {/* Registration ends with an enrolled passkey and an adopted session,
            which is exactly what the parked request is waiting for — so the
            new account carries straight on to consent, no second sign-in. */}
        <Register
          client={registrationClient}
          turnstileSiteKey={TURNSTILE_SITEKEY}
          onCancel={() => setMode("signIn")}
          onSuccess={() => props.onSuccess()}
        />
      </Show>
    </AuthProvider>
  );
}
