import { StepUpDialog } from "@osn/auth-ui/StepUpDialog";
import type { StepUpPurpose, StepUpToken } from "@osn/client";

import { stepUpClient, totpClient } from "../lib/authClients";
import { runPasskeyCeremony } from "../lib/webauthn-ceremony";

export interface StepUpSheetProps {
  purpose: StepUpPurpose;
  title?: string;
  reason?: string;
  warning?: string;
  onToken: (token: StepUpToken) => void;
  onCancel: () => void;
}

/**
 * `@osn/auth-ui`'s step-up sheet with Musubi's clients and passkey ceremony,
 * for a screen outside Settings → Security. Its own module, loaded only when
 * a screen asks for a step-up (`createStepUp` in `lib/step-up.tsx`), so the
 * ceremony's code is fetched by those who use it.
 */
export default function StepUpSheet(props: StepUpSheetProps) {
  return (
    <StepUpDialog
      client={stepUpClient}
      totpClient={totpClient}
      runPasskeyCeremony={runPasskeyCeremony}
      purpose={props.purpose}
      title={props.title}
      reason={props.reason}
      warning={props.warning}
      onToken={(token) => props.onToken(token)}
      onCancel={() => props.onCancel()}
    />
  );
}
