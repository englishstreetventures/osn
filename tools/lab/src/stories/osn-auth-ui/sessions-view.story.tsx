import { SessionsView } from "@osn/auth-ui/SessionsView";
import type { SessionsClient, SessionSummary } from "@osn/client";

import type { Story } from "../../lab/types.ts";
import { Gallery } from "../design-system/chrome.tsx";
import { ADDED, never, SettingsCard } from "./settings-bench.tsx";

/**
 * The session list, which no app mounts yet, in the card musubi would draw it
 * in. Each row's Sign out is named by its device.
 */
export const meta = { title: "osn/auth-ui/SessionsView", layout: "padded" as const };

const rows: SessionSummary[] = [
  {
    id: "ses_a",
    uaLabel: "Chrome on macOS",
    createdAt: ADDED,
    lastUsedAt: ADDED + 5_000,
    expiresAt: ADDED + 2_592_000,
    isCurrent: true,
  },
  {
    id: "ses_b",
    uaLabel: "Safari on iPhone",
    createdAt: ADDED + 100,
    lastUsedAt: null,
    expiresAt: ADDED + 2_592_100,
    isCurrent: false,
  },
];

function client(list: () => Promise<{ sessions: SessionSummary[] }>): SessionsClient {
  return { list, revoke: () => never(), revokeAllOther: () => never() };
}

export const List: Story = {
  render: () => (
    <Gallery
      title="osn/auth-ui SessionsView — two sessions"
      intro="This device, marked in the accent ink, and one other."
    >
      <SettingsCard>
        <SessionsView client={client(() => Promise.resolve({ sessions: rows }))} />
      </SettingsCard>
    </Gallery>
  ),
};

export const Loading: Story = {
  render: () => (
    <Gallery title="osn/auth-ui SessionsView — loading" intro="The list never arrives.">
      <SettingsCard>
        <SessionsView client={client(() => never())} />
      </SettingsCard>
    </Gallery>
  ),
};
