import { PasskeysView } from "@osn/auth-ui/PasskeysView";
import type { PasskeysClient, PasskeySummary } from "@osn/client";

import type { Story } from "../../lab/types.ts";
import { Gallery, Mono } from "../design-system/chrome.tsx";
import { ADDED, failed, never, SettingsCard, stepUpClient } from "./settings-bench.tsx";

/**
 * Settings → Security's passkey panel, in the card musubi draws it in. Each
 * row is a `Card` nested in that card, 8px corners and 16px inside, and
 * its actions name their passkey. "Remove" opens the step-up sheet titled
 * with the passkey's name; its calls never answer, so it holds there.
 * The colours are musubi's, so the **light · dark** toggle is the theme check.
 */
export const meta = { title: "osn/auth-ui/PasskeysView", layout: "padded" as const };

const rows: PasskeySummary[] = [
  {
    id: "pk_aaaaaaaaaaaa",
    label: "Work laptop",
    aaguid: null,
    transports: null,
    backupEligible: false,
    backupState: false,
    createdAt: ADDED,
    lastUsedAt: ADDED + 5_000,
  },
  {
    id: "pk_bbbbbbbbbbbb",
    label: null,
    aaguid: null,
    transports: null,
    backupEligible: true,
    backupState: true,
    createdAt: ADDED + 100,
    lastUsedAt: null,
  },
];

function client(list: () => Promise<{ passkeys: PasskeySummary[] }>): PasskeysClient {
  return {
    list,
    rename: () => never(),
    delete: () => never(),
    registerBegin: () => never(),
    registerComplete: () => never(),
  };
}

function panel(list: () => Promise<{ passkeys: PasskeySummary[] }>, phone?: boolean) {
  return (
    <SettingsCard phone={phone}>
      <PasskeysView
        client={client(list)}
        stepUpClient={stepUpClient}
        profileId="usr_lab"
        runPasskeyCeremony={() => never()}
        runPasskeyRegistration={() => never()}
      />
    </SettingsCard>
  );
}

export const List: Story = {
  render: () => (
    <Gallery
      title="osn/auth-ui PasskeysView — two passkeys"
      intro={
        <>
          A named passkey and an unnamed synced one ("Synced passkey (synced)"). Each row's Rename
          and Remove are named for screen readers by the passkey: <Mono>Remove Work laptop</Mono>.
          Press Remove to see the step-up sheet ask first.
        </>
      }
    >
      {panel(() => Promise.resolve({ passkeys: rows }))}
    </Gallery>
  ),
};

export const Loading: Story = {
  render: () => (
    <Gallery
      title="osn/auth-ui PasskeysView — loading"
      intro="The list never arrives: one row's placeholder, as tall as a row whose words take one line each."
    >
      {panel(() => never())}
    </Gallery>
  ),
};

export const LoadFailed: Story = {
  render: () => (
    <Gallery
      title="osn/auth-ui PasskeysView — failed to load"
      intro="The list's read fails: the lead, the sentence the error map gives, and Try again."
    >
      {panel(() => failed())}
    </Gallery>
  ),
};

export const Phone: Story = {
  render: () => (
    <Gallery
      title="osn/auth-ui PasskeysView — a 320px phone"
      intro="The card's column on a 320px screen. Row actions are 40px tall below md; the dates wrap."
    >
      {panel(() => Promise.resolve({ passkeys: rows }), true)}
    </Gallery>
  ),
};
