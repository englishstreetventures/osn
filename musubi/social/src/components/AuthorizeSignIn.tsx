import { Register } from "@osn/auth-ui/Register";
import { SignIn } from "@osn/auth-ui/SignIn";
import { AuthProvider } from "@osn/client/solid";
import { Button } from "@shared/ui/ui/button";
import { createSignal, Show } from "solid-js";

import { osnAuth, PRODUCT_NAME, TURNSTILE_SITEKEY } from "../lib/auth";
import { loginClient, recoveryClient, registrationClient } from "../lib/authClients";
import { runPasskeyRegistrationDeferred } from "../lib/webauthn-registration-deferred";

/**
 * The sign-in half of the consent screen, kept behind a `lazy()` boundary.
 *
 * `SignIn` needs `AuthProvider`, and `AuthProvider` bootstraps a session on
 * mount — `POST /token`, which rotates the refresh session — plus a profile
 * list the consent screen never reads (`GET /authorize/context` already
 * carries both). Neither belongs on the signed-in path, which is the common
 * one, so the provider is mounted here rather than around the route: the
 * session load and the WebAuthn code run only when a ceremony is actually
 * required. It takes the page's one auth runtime, as the shell's provider does,
 * so the two share one session cache and one `/token` grant.
 *
 * Both halves of "who are you" live here. A visitor sent by an app they have
 * never used may not have a Musubi account at all, and until this screen offered
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
    <AuthProvider auth={osnAuth}>
      <Show
        when={mode() === "register"}
        fallback={
          <>
            <SignIn
              host="page"
              registrationClient={registrationClient}
              runPasskeyRegistration={runPasskeyRegistrationDeferred}
              client={loginClient}
              recoveryClient={recoveryClient}
              turnstileSiteKey={TURNSTILE_SITEKEY}
              productName={PRODUCT_NAME}
              onSuccess={() => props.onSuccess()}
            />
            <p class="text-muted-foreground text-body mt-6 text-center">
              No account yet?{" "}
              <Button
                variant="link"
                size="inline"
                type="button"
                onClick={() => setMode("register")}
              >
                Create one
              </Button>
            </p>
          </>
        }
      >
        {/* Registration ends with an enrolled passkey and an adopted session,
            which is exactly what the parked request is waiting for — so the
            new account carries straight on to consent, no second sign-in. */}
        <Register
          host="page"
          client={registrationClient}
          turnstileSiteKey={TURNSTILE_SITEKEY}
          productName={PRODUCT_NAME}
          cancelLabel="Sign in instead"
          onCancel={() => setMode("signIn")}
          onSuccess={() => props.onSuccess()}
        />
      </Show>
    </AuthProvider>
  );
}
