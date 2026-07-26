import { PasskeysView } from "@osn/ui/auth/PasskeysView";
import { RecoveryCodesView } from "@osn/ui/auth/RecoveryCodesView";
import { startAuthentication, startRegistration } from "@simplewebauthn/browser";

import { passkeysClient, recoveryClient, stepUpClient } from "../lib/authClients";

/**
 * Security section of the Settings page — passkey list / add / rename /
 * delete, then recovery codes. Lives in its own module so the Settings
 * route can code-split the `@simplewebauthn/browser` dependency; visitors
 * who never open the Security tab don't pay the parse cost.
 *
 * Both surfaces are step-up gated and share one ceremony runner, so they
 * belong together: passkeys are how you get in, recovery codes are how you
 * get back in once every passkey is gone.
 */
export interface SecuritySectionProps {
  accessToken: string;
  profileId: string;
}

export default function SecuritySection(props: SecuritySectionProps) {
  const runPasskeyCeremony = (options: unknown) =>
    startAuthentication({
      optionsJSON: options as Parameters<typeof startAuthentication>[0]["optionsJSON"],
    });

  return (
    <div class="flex flex-col gap-8">
      <PasskeysView
        client={passkeysClient}
        stepUpClient={stepUpClient}
        accessToken={props.accessToken}
        profileId={props.profileId}
        runPasskeyCeremony={runPasskeyCeremony}
        runPasskeyRegistration={(options: unknown) =>
          startRegistration({
            optionsJSON: options as Parameters<typeof startRegistration>[0]["optionsJSON"],
          })
        }
      />

      <section class="flex flex-col gap-4 border-t pt-8">
        <div class="flex flex-col gap-1">
          <h2 class="text-lg font-semibold">Recovery codes</h2>
          <p class="text-muted-foreground text-sm">
            Keep a set somewhere away from your devices — a recovery code is the only way back in if
            you lose every device that holds a passkey.
          </p>
        </div>
        <RecoveryCodesView
          client={recoveryClient}
          stepUpClient={stepUpClient}
          accessToken={props.accessToken}
          runPasskeyCeremony={runPasskeyCeremony}
        />
      </section>
    </div>
  );
}
