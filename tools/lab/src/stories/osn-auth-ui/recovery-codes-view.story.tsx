import { RecoveryCodesView } from "@osn/auth-ui/RecoveryCodesView";
import type { RecoveryClient } from "@osn/client";

import type { Story } from "../../lab/types.ts";
import { Gallery } from "../design-system/chrome.tsx";
import { ADDED, failed, never, SettingsCard, stepUpClient } from "./settings-bench.tsx";

/**
 * Settings → Security's recovery codes, in musubi's card. Its heading is the
 * host's. "Generate new codes" opens the dialog that asks first, a bottom
 * sheet below `md`; its Generate opens the step-up sheet, which holds there.
 */
export const meta = { title: "osn/auth-ui/RecoveryCodesView", layout: "padded" as const };

type Status = Awaited<ReturnType<RecoveryClient["getRecoveryCodesStatus"]>>;

function client(status: () => Promise<Status>): RecoveryClient {
  return {
    getRecoveryCodesStatus: status,
    generateRecoveryCodes: () => never(),
    loginWithRecoveryCode: () => never(),
    emailRecoveryBegin: () => never(),
    emailRecoveryStatus: () => never(),
    emailRecoveryResend: () => never(),
    totpRecoveryComplete: () => never(),
    disown: () => never(),
  };
}

function panel(status: () => Promise<Status>, phone?: boolean) {
  return (
    <SettingsCard phone={phone}>
      <RecoveryCodesView
        client={client(status)}
        stepUpClient={stepUpClient}
        runPasskeyCeremony={() => never()}
        productName="Musubi"
      />
    </SettingsCard>
  );
}

export const CodesHeld: Story = {
  render: () => (
    <Gallery
      title="osn/auth-ui RecoveryCodesView — codes held"
      intro="Seven of ten unused. Generate new codes asks first, in a sheet."
    >
      {panel(() => Promise.resolve({ active: 7, total: 10, generatedAt: ADDED }))}
    </Gallery>
  ),
};

export const NoCodes: Story = {
  render: () => (
    <Gallery
      title="osn/auth-ui RecoveryCodesView — no codes"
      intro="An account with none: a warn notice, not red text."
    >
      {panel(() => Promise.resolve({ active: 0, total: 0, generatedAt: null }))}
    </Gallery>
  ),
};

export const Checking: Story = {
  render: () => (
    <Gallery
      title="osn/auth-ui RecoveryCodesView — checking"
      intro="The status never arrives: a line's placeholder, and the button says why it waits."
    >
      {panel(() => never())}
    </Gallery>
  ),
};

export const StatusUnread: Story = {
  render: () => (
    <Gallery
      title="osn/auth-ui RecoveryCodesView — status unread"
      intro="The status read fails: the failed-load line with Try again. Generating still works, and asks first."
    >
      {panel(() => failed())}
    </Gallery>
  ),
};

export const Phone: Story = {
  render: () => (
    <Gallery
      title="osn/auth-ui RecoveryCodesView — a 320px phone"
      intro="Codes held, on a 320px screen."
    >
      {panel(() => Promise.resolve({ active: 7, total: 10, generatedAt: ADDED }), true)}
    </Gallery>
  ),
};
