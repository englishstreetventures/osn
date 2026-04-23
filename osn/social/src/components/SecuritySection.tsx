import { PasskeysView } from "@osn/ui/auth/PasskeysView";
import { startAuthentication, startRegistration } from "@simplewebauthn/browser";

import { passkeysClient, stepUpClient } from "../lib/authClients";

/**
 * Security section of the Settings page — passkey list / add / rename /
 * delete. Lives in its own module so the Settings route can code-split
 * the `@simplewebauthn/browser` dependency; visitors who never open
 * the Security tab don't pay the parse cost.
 */
export interface SecuritySectionProps {
  accessToken: string;
  profileId: string;
}

export default function SecuritySection(props: SecuritySectionProps) {
  return (
    <PasskeysView
      client={passkeysClient}
      stepUpClient={stepUpClient}
      accessToken={props.accessToken}
      profileId={props.profileId}
      runPasskeyCeremony={(options: unknown) =>
        startAuthentication({
          optionsJSON: options as Parameters<typeof startAuthentication>[0]["optionsJSON"],
        })
      }
      runPasskeyRegistration={(options: unknown) =>
        startRegistration({
          optionsJSON: options as Parameters<typeof startRegistration>[0]["optionsJSON"],
        })
      }
    />
  );
}
