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
      intro='The details step in the real sheet, named "Create your Musubi account".'
    >
      <DialogBench>
        <AuthContext.Provider value={signedOut()}>
          <Register host="dialog" client={client} productName="Musubi" onCancel={() => {}} />
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
            cancelLabel="Sign in instead"
            onCancel={() => {}}
          />
        </AuthContext.Provider>
      </AuthorizeColumn>
    </Gallery>
  ),
};
