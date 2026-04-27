import { DataExportView } from "@osn/ui/auth/DataExportView";
import { startAuthentication } from "@simplewebauthn/browser";

import { accountExportClient, stepUpClient } from "../lib/authClients";

/**
 * Privacy & Data section of Settings — currently hosts the GDPR Art. 15 /
 * Art. 20 + CCPA right-to-know data-export action (C-H1). Code-split out
 * of SettingsPage so the WebAuthn dependency loads lazily, mirroring the
 * SecuritySection pattern.
 */
export interface PrivacySectionProps {
  accessToken: string;
}

export default function PrivacySection(props: PrivacySectionProps) {
  return (
    <DataExportView
      accountExportClient={accountExportClient}
      stepUpClient={stepUpClient}
      accessToken={props.accessToken}
      runPasskeyCeremony={(options: unknown) =>
        startAuthentication({
          optionsJSON: options as Parameters<typeof startAuthentication>[0]["optionsJSON"],
        })
      }
    />
  );
}
