import { SecurityEventsBanner } from "@osn/ui/auth/SecurityEventsBanner";
import { startAuthentication } from "@simplewebauthn/browser";

import { securityEventsClient, stepUpClient } from "../lib/authClients";

/**
 * Wires the shared `SecurityEventsBanner` to this app's clients. Split into its
 * own module (lazy-loaded by SettingsPage) so `@simplewebauthn/browser` — pulled
 * in by the step-up ceremony — stays out of the main app bundle (P-I1).
 *
 * Mounting this is what makes recovery-code generate/consume events actually
 * reach the user in-app; before it, the audit design's "survives email
 * filtering" channel was unmounted dead code and only the best-effort email
 * path was live.
 */
export default function SecurityEventsBannerMount(props: { accessToken: string }) {
  const runPasskeyCeremony = (options: unknown) =>
    startAuthentication({
      optionsJSON: options as Parameters<typeof startAuthentication>[0]["optionsJSON"],
    });

  return (
    <SecurityEventsBanner
      client={securityEventsClient}
      stepUpClient={stepUpClient}
      accessToken={props.accessToken}
      runPasskeyCeremony={runPasskeyCeremony}
    />
  );
}
