import { TotpView } from "@osn/auth-ui/TotpView";
import type { TotpClient, TotpStatus } from "@osn/client";

import type { Story } from "../../lab/types.ts";
import { Gallery } from "../design-system/chrome.tsx";
import { ADDED, failed, never, SettingsCard, stepUpClient } from "./settings-bench.tsx";

/**
 * Settings → Security's authenticator panel, in musubi's card. Set up, the
 * app is one nested `Card` row; "Remove" opens the step-up sheet titled
 * "Remove {name}?" with its warning. Every call but the status never answers.
 */
export const meta = { title: "osn/auth-ui/TotpView", layout: "padded" as const };

function client(status: () => Promise<TotpStatus>): TotpClient {
  return {
    status,
    enrollBegin: () => never(),
    enrollComplete: () => never(),
    disable: () => never(),
  };
}

function panel(status: () => Promise<TotpStatus>, phone?: boolean) {
  return (
    <SettingsCard phone={phone}>
      <TotpView
        client={client(status)}
        stepUpClient={stepUpClient}
        runPasskeyCeremony={() => never()}
      />
    </SettingsCard>
  );
}

const setUp: TotpStatus = {
  enrolled: true,
  label: "iPhone",
  createdAt: ADDED,
  lastUsedAt: ADDED + 5_000,
};

export const NoneSetUp: Story = {
  render: () => (
    <Gallery
      title="osn/auth-ui TotpView — none set up"
      intro="No app yet: the panel's action is in its header."
    >
      {panel(() =>
        Promise.resolve({ enrolled: false, label: null, createdAt: null, lastUsedAt: null }),
      )}
    </Gallery>
  ),
};

export const SetUp: Story = {
  render: () => (
    <Gallery
      title="osn/auth-ui TotpView — set up"
      intro="One app, as a nested row. Remove opens the step-up sheet, which asks first."
    >
      {panel(() => Promise.resolve(setUp))}
    </Gallery>
  ),
};

export const Loading: Story = {
  render: () => (
    <Gallery title="osn/auth-ui TotpView — loading" intro="The status never arrives.">
      {panel(() => never())}
    </Gallery>
  ),
};

export const LoadFailed: Story = {
  render: () => (
    <Gallery title="osn/auth-ui TotpView — failed to load" intro="The status read fails.">
      {panel(() => failed())}
    </Gallery>
  ),
};

export const Phone: Story = {
  render: () => (
    <Gallery title="osn/auth-ui TotpView — a 320px phone" intro="Set up, on a 320px screen.">
      {panel(() => Promise.resolve(setUp), true)}
    </Gallery>
  ),
};
