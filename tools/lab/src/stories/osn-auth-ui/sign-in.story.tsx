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
import { createResource, Show, type ComponentProps } from "solid-js";

import type { Story } from "../../lab/types.ts";
import { Gallery, Mono } from "../design-system/chrome.tsx";
import { AuthorizeColumn, DialogBench } from "./settings-bench.tsx";

export const meta = { title: "osn/auth-ui/SignIn", layout: "padded" as const };

/**
 * The view in both hosts musubi gives it: the "Sign in" dialog, the real
 * sheet (a bottom sheet below `md`; narrow the window to see it), which the
 * view names through its `AuthHeader`; and `/authorize`'s column, with no
 * frame round the panel. The colours are musubi's, which is the lab's own mapping, so the
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

/** `SignIn` as musubi mounts it in `host`, signed out. */
function MusubiSignIn(props: { host: "dialog" | "page" }) {
  const shared = {
    client: loginClient,
    recoveryClient,
    registrationClient,
    runPasskeyRegistration,
    productName: "Musubi",
  };
  return (
    <AuthContext.Provider value={signedOut()}>
      {/* A dialog's Cancel is its footer's, and does nothing here; the page's
          way out is "Create one" under the panel, which the host draws. */}
      <Show when={props.host === "dialog"} fallback={<SignIn host="page" {...shared} />}>
        <SignIn host="dialog" {...shared} onCancel={() => {}} />
      </Show>
    </AuthContext.Provider>
  );
}

export const Default: Story = {
  render: () => (
    <Gallery
      title="osn/auth-ui SignIn — in the dialog"
      intro={
        <>
          What a signed-out person sees on opening "Sign in": the sheet named by its centred title,
          the <Mono>Email or @handle</Mono> field with "Lost your passkey?" under it, then the
          footer's Cancel and Continue. Type a handle and press Continue to see "Verifying…" hold,
          since the passkey call never answers. "Lost your passkey?" renames the sheet "Recover your
          account" and opens the recovery chooser. Escape closes it; the button opens it again.
        </>
      }
    >
      <DialogBench>
        <MusubiSignIn host="dialog" />
      </DialogBench>
    </Gallery>
  ),
};

export const OnAuthorize: Story = {
  render: () => (
    <Gallery
      title="osn/auth-ui SignIn — on /authorize"
      intro={
        <>
          The page host: no frame and no side padding, the title at the dialog title's type under
          the app's name, 24px under the client card and 24px above the form. No Cancel: the page
          offers "Create one" under the panel instead.
        </>
      }
    >
      <AuthorizeColumn>
        <MusubiSignIn host="page" />
      </AuthorizeColumn>
    </Gallery>
  ),
};

export const Phone: Story = {
  render: () => (
    <Gallery
      title="osn/auth-ui SignIn — on /authorize at 320px"
      intro="The page host in a 320px screen's column, 272px after the page's 24px a side."
    >
      <div class="w-68">
        <MusubiSignIn host="page" />
      </div>
    </Gallery>
  ),
};
