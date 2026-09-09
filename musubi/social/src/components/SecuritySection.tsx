import { PasskeysView } from "@osn/ui/auth/PasskeysView";
import { RecoveryCodesView } from "@osn/ui/auth/RecoveryCodesView";
import { TotpView } from "@osn/ui/auth/TotpView";

import { passkeysClient, recoveryClient, stepUpClient, totpClient } from "../lib/authClients";
import { runPasskeyCeremony } from "../lib/webauthn-ceremony";
import { runPasskeyRegistration } from "../lib/webauthn-registration";

/**
 * Security section of the Settings page — passkey list / add / rename /
 * delete, then the authenticator app, then recovery codes. Lives in its own
 * module so the Settings route can code-split the `@simplewebauthn/browser`
 * dependency; visitors who never open the Security tab don't pay the parse
 * cost.
 *
 * All three surfaces are step-up gated and share one ceremony runner, so they
 * belong together. They are also the whole answer to "how do I get back in":
 * a passkey is how you get in, and an authenticator app and recovery codes are
 * the two independent ways back when every passkey is gone.
 *
 * Order is deliberate. Passkeys first because they are the thing in daily use;
 * the authenticator next because it is the recovery factor a user is most
 * likely to set up; recovery codes last because they are the fallback for
 * when even that is gone.
 */
export interface SecuritySectionProps {
  accessToken: string;
  profileId: string;
}

export default function SecuritySection(props: SecuritySectionProps) {
  return (
    <div class="flex flex-col gap-8">
      <PasskeysView
        client={passkeysClient}
        stepUpClient={stepUpClient}
        accessToken={props.accessToken}
        profileId={props.profileId}
        runPasskeyCeremony={runPasskeyCeremony}
        runPasskeyRegistration={runPasskeyRegistration}
        totpClient={totpClient}
      />

      <section class="flex flex-col gap-4 border-t pt-8">
        <TotpView
          client={totpClient}
          stepUpClient={stepUpClient}
          accessToken={props.accessToken}
          runPasskeyCeremony={runPasskeyCeremony}
        />
      </section>

      <section class="flex flex-col gap-4 border-t pt-8">
        <div class="flex flex-col gap-1">
          <h2 class="text-lg font-semibold">Recovery codes</h2>
          <p class="text-muted-foreground text-sm">
            Keep a set somewhere away from your devices — a recovery code works when every other way
            back in is gone.
          </p>
        </div>
        <RecoveryCodesView
          client={recoveryClient}
          stepUpClient={stepUpClient}
          accessToken={props.accessToken}
          runPasskeyCeremony={runPasskeyCeremony}
          totpClient={totpClient}
        />
      </section>
    </div>
  );
}
