import { SignIn } from "@osn/auth-ui/SignIn";
import type { LoginClient, PublicProfile, RecoveryClient, Session } from "@osn/client";
import { AuthContext } from "@osn/client/solid";
import { Card } from "@shared/ui/ui/card";
import { createResource, type ComponentProps } from "solid-js";

import type { Story } from "../../lab/types.ts";
import { Gallery, Mono } from "../design-system/chrome.tsx";

export const meta = { title: "osn/auth-ui/SignIn", layout: "padded" as const };

/**
 * The view musubi opens in its "Sign in" dialog, in a frame the width of that
 * dialog (`max-w-sm`) painted with its surface. The colours are musubi's, which
 * is the lab's own mapping, so the **light · dark** toggle (or `?theme=dark`)
 * is the theme check.
 *
 * Nothing here reaches an issuer. The session and both clients are fixed
 * objects in this file, and every call they take never answers.
 */

type AuthValue = ComponentProps<typeof AuthContext.Provider>["value"];

/** A request that never settles: the answer to every call the view can make. */
function never<T>(): Promise<T> {
  return new Promise<T>(() => {});
}

const loginClient: LoginClient = {
  passkeyBegin: () => never(),
  passkeyComplete: () => never(),
};

const recoveryClient: RecoveryClient = {
  generateRecoveryCodes: () => never(),
  getRecoveryCodesStatus: () => never(),
  loginWithRecoveryCode: () => never(),
  emailRecoveryBegin: () => never(),
  emailRecoveryStatus: () => never(),
  emailRecoveryResend: () => never(),
  totpRecoveryComplete: () => never(),
  disown: () => never(),
};

/**
 * Signed out, with no profiles. Built inside a render, so its resources have
 * an owner and go when the story does.
 */
function signedOut(): AuthValue {
  const [session] = createResource<Session | null>(() => null, { initialValue: null });
  const [profiles] = createResource<PublicProfile[] | null>(() => null, { initialValue: null });
  return {
    session,
    profiles,
    profilesError: () => undefined,
    refetchProfiles: () => never(),
    activeProfileId: () => null,
    logout: () => never(),
    adoptSession: () => never(),
    refreshHeldSession: () => never(),
    switchProfile: () => never(),
    createProfile: () => never(),
    deleteProfile: () => never(),
    authFetch: () => never(),
  };
}

export const Default: Story = {
  render: () => (
    <Gallery
      title="osn/auth-ui SignIn — default"
      intro={
        <>
          What a signed-out person sees on opening "Sign in": the heading with Cancel, the{" "}
          <Mono>Email or @handle</Mono> field, Continue and "Lost your passkey?". Type a handle and
          press Continue to see "Verifying…" hold, since the passkey call never answers. "Lost your
          passkey?" opens the recovery-code form; with no registration client passed, the emailed
          link and authenticator-app routes stay off. A browser without WebAuthn shows the view that
          says so instead.
        </>
      }
    >
      <AuthContext.Provider value={signedOut()}>
        <Card padding="lg" class="w-full max-w-sm shrink-0">
          <SignIn
            client={loginClient}
            recoveryClient={recoveryClient}
            productName="Musubi"
            onCancel={() => {}}
          />
        </Card>
      </AuthContext.Provider>
    </Gallery>
  ),
};
