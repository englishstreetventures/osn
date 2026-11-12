import type { RunPasskeyRegistration } from "@osn/auth-ui";
import { SignIn } from "@osn/auth-ui/SignIn";
import type {
  LoginClient,
  PublicProfile,
  RecoveryClient,
  RegistrationClient,
  Session,
} from "@osn/client";
import { AuthContext } from "@osn/client/solid";
import { Card } from "@shared/ui/ui/card";
import { createResource, Show, type ComponentProps, type JSX } from "solid-js";

import type { Story } from "../../lab/types.ts";
import { Gallery, Mono } from "../design-system/chrome.tsx";

export const meta = { title: "osn/auth-ui/SignIn", layout: "padded" as const };

/**
 * The view musubi opens in its "Sign in" dialog, in a frame the size of that
 * dialog and unpadded, as `DialogContent` is, so the view's own column is the
 * only inset. The colours are musubi's, which is the lab's own mapping, so the
 * **light · dark** toggle (or `?theme=dark`) is the theme check.
 *
 * `SignIn` gets every client musubi passes it, with Turnstile off, so every view
 * reachable from here is one musubi ships. Nothing reaches an issuer: the
 * session and the clients are fixed objects in this file, and every call they
 * take never answers.
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
 * With this and `runPasskeyRegistration` present, the recovery chooser offers
 * the emailed link and the authenticator app beside the recovery code, as it
 * does in musubi.
 */
const registrationClient: RegistrationClient = {
  checkHandle: () => never(),
  beginRegistration: () => never(),
  registrationStatus: () => never(),
  resendRegistrationLink: () => never(),
  passkeyRegisterBegin: () => never(),
  passkeyRegisterComplete: () => never(),
};

const runPasskeyRegistration: RunPasskeyRegistration = () => never();

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

/**
 * musubi's dialog, unpadded as `DialogContent` is. At `md` and up it is a
 * 24rem card. Below `md` it is a sheet as wide as the screen, with only its
 * top corners rounded (`--ui-radius-sheet`) and only its top edge drawn.
 * `Card` owns its shape and has no such face, so the sheet is a `div` with
 * the fill, edge and corners `DialogContent`'s sheet presentation gives it.
 * The sheet face is a 20rem screen, the narrowest supported, painted above
 * the sheet with `DialogOverlay`'s fill, so the sheet's edge shows on a light
 * page as it does in musubi.
 */
function DialogFrame(props: { children: JSX.Element; face?: "card" | "sheet" }) {
  return (
    <Show
      when={props.face === "sheet"}
      fallback={<Card class="w-full max-w-sm shrink-0">{props.children}</Card>}
    >
      <div class="w-80 shrink-0 bg-black/50 pt-16">
        <div class="border-ui-hairline bg-ui-surface rounded-t-ui-sheet border-t">
          {props.children}
        </div>
      </div>
    </Show>
  );
}

/** `SignIn` as musubi mounts it, signed out. */
function MusubiSignIn() {
  return (
    <AuthContext.Provider value={signedOut()}>
      <SignIn
        client={loginClient}
        recoveryClient={recoveryClient}
        registrationClient={registrationClient}
        runPasskeyRegistration={runPasskeyRegistration}
        productName="Musubi"
        onCancel={() => {}}
      />
    </AuthContext.Provider>
  );
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
          passkey?" opens the recovery chooser: a recovery code, an emailed link or an authenticator
          app. A browser without WebAuthn shows the view that says so instead.
        </>
      }
    >
      <DialogFrame>
        <MusubiSignIn />
      </DialogFrame>
    </Gallery>
  ),
};

export const Phone: Story = {
  render: () => (
    <Gallery
      title="osn/auth-ui SignIn — a 320px phone"
      intro={
        <>
          Below <Mono>md</Mono> musubi opens "Sign in" as a sheet from the bottom of the screen, as
          wide as the screen, with its top corners rounded. This is that sheet on the narrowest
          supported phone, under the dimmed page. The view and its stubs are the same as in Default.
        </>
      }
    >
      <DialogFrame face="sheet">
        <MusubiSignIn />
      </DialogFrame>
    </Gallery>
  ),
};
