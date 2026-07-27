import { AuthProvider } from "@osn/client/solid";
import { SignIn } from "@osn/ui/auth/SignIn";

import { OSN_ISSUER_URL, TURNSTILE_SITEKEY } from "../lib/auth";
import { loginClient, recoveryClient } from "../lib/authClients";

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
 */
export function AuthorizeSignIn(props: { onSuccess: () => void }) {
  return (
    <AuthProvider config={{ issuerUrl: OSN_ISSUER_URL }}>
      <SignIn
        client={loginClient}
        recoveryClient={recoveryClient}
        turnstileSiteKey={TURNSTILE_SITEKEY}
        onSuccess={() => props.onSuccess()}
      />
    </AuthProvider>
  );
}
