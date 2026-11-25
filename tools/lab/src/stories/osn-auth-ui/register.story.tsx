import { ENROLLING_KEY, forgetEnrolling } from "@osn/auth-ui/pending-sign-up";
import { Register } from "@osn/auth-ui/Register";
import type { PublicProfile, RegistrationClient, Session } from "@osn/client";
import { AuthContext } from "@osn/client/solid";
import { createResource, type ComponentProps } from "solid-js";

import type { Story } from "../../lab/types.ts";
import { Gallery } from "../design-system/chrome.tsx";
import { AuthorizeColumn, DialogBench, never } from "./settings-bench.tsx";

/**
 * The create-account view in both hosts musubi gives it: the dialog, which
 * it names through its `AuthHeader`, and `/authorize`, where its Cancel reads
 * "Sign in instead". Every call never answers.
 */
export const meta = { title: "osn/auth-ui/Register", layout: "padded" as const };

type AuthValue = ComponentProps<typeof AuthContext.Provider>["value"];

const client: RegistrationClient = {
  checkHandle: () => Promise.resolve({ available: true }),
  beginRegistration: () => never(),
  registrationStatus: () => never(),
  resendRegistrationLink: () => never(),
  passkeyRegisterBegin: () => never(),
  passkeyRegisterComplete: () => never(),
};

/** Musubi's own pages, as both its hosts pass them. */
const legal = { termsHref: "/terms", privacyHref: "/privacy" };

/** Signed out, built inside a render so its resources go with the story. */
function signedOut(): AuthValue {
  const [session] = createResource<Session | null>(() => null, { initialValue: null });
  const [profiles] = createResource<PublicProfile[] | null>(() => null, { initialValue: null });
  return {
    session,
    profiles,
    profilesError: () => undefined,
    refetchProfiles: () => never(),
    activeProfileId: () => null,
    pendingDeletion: () => false,
    renewSession: () => never(),
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
      title="osn/auth-ui Register — in the dialog"
      intro='The details step in the real sheet, named "Create your Musubi account", ending with the way across to sign-in, as Musubi passes it.'
    >
      <DialogBench>
        <AuthContext.Provider value={signedOut()}>
          <Register
            host="dialog"
            client={client}
            productName="Musubi"
            legal={legal}
            onCancel={() => {}}
            onSignIn={() => {}}
          />
        </AuthContext.Provider>
      </DialogBench>
    </Gallery>
  ),
};

export const OnAuthorize: Story = {
  render: () => (
    <Gallery
      title="osn/auth-ui Register — on /authorize"
      intro='The page host, with Cancel as a ghost "Sign in instead", since it switches views.'
    >
      <AuthorizeColumn>
        <AuthContext.Provider value={signedOut()}>
          <Register
            host="page"
            client={client}
            productName="Musubi"
            legal={legal}
            cancelLabel="Sign in instead"
            onCancel={() => {}}
          />
        </AuthContext.Provider>
      </AuthorizeColumn>
    </Gallery>
  ),
};

/**
 * The passkey step as a reload, a closed dialog or a closed tab brings it
 * back: the account the browser kept, named by the handle the server made it
 * under. The kept entry is written for this story and removed once the view
 * has read it, so no other story opens on it.
 */
export const PasskeyStep: Story = {
  render: () => {
    localStorage.setItem(
      ENROLLING_KEY,
      JSON.stringify({ profileId: "usr_lab", handle: "ada", expiresAt: Date.now() + 60_000 }),
    );
    const view = (
      <AuthContext.Provider value={signedOut()}>
        <Register
          host="dialog"
          client={client}
          productName="Musubi"
          legal={legal}
          onCancel={() => {}}
          onSignIn={() => {}}
        />
      </AuthContext.Provider>
    );
    forgetEnrolling();
    return (
      <Gallery
        title="osn/auth-ui Register — the passkey step, come back to"
        intro="Add a passkey, naming the handle the account was made under."
      >
        <DialogBench>{view}</DialogBench>
      </Gallery>
    );
  },
};
