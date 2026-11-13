import { SecurityEventsBanner } from "@osn/auth-ui/SecurityEventsBanner";
import type { SecurityEventsClient, SecurityEventSummary } from "@osn/client";

import type { Story } from "../../lab/types.ts";
import { Gallery } from "../design-system/chrome.tsx";
import { ADDED, never, stepUpClient } from "./settings-bench.tsx";

/**
 * The banner over every signed-in page while an account has unacknowledged
 * security events: the warn edge and wash, the ink left alone (D17). The one
 * message box the package draws by hand.
 */
export const meta = { title: "osn/auth-ui/SecurityEventsBanner", layout: "padded" as const };

const events: SecurityEventSummary[] = [
  {
    id: "sev_a",
    kind: "recovery_link_declined",
    createdAt: ADDED,
    uaLabel: "Firefox on Windows",
    ipHash: null,
  },
];

const client: SecurityEventsClient = {
  list: () => Promise.resolve({ events }),
  acknowledge: () => never(),
  acknowledgeAll: () => never(),
};

export const Events: Story = {
  render: () => (
    <Gallery
      title="osn/auth-ui SecurityEventsBanner — one event"
      intro="A declined recovery link. Acknowledge opens the step-up sheet, which holds."
    >
      <div class="w-full max-w-2xl">
        <SecurityEventsBanner client={client} stepUpClient={stepUpClient} productName="Musubi" />
      </div>
    </Gallery>
  ),
};

export const Phone: Story = {
  render: () => (
    <Gallery title="osn/auth-ui SecurityEventsBanner — a 320px phone" intro="The same, at 288px.">
      <div class="w-72">
        <SecurityEventsBanner client={client} stepUpClient={stepUpClient} productName="Musubi" />
      </div>
    </Gallery>
  ),
};
