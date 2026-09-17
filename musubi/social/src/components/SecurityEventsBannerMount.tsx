import { SecurityEventsBanner } from "@osn/auth-ui/SecurityEventsBanner";

import { PRODUCT_NAME } from "../lib/auth";
import { securityEventsClient, stepUpClient, totpClient } from "../lib/authClients";
import { runPasskeyCeremony } from "../lib/webauthn-ceremony";

/**
 * Wires the shared `SecurityEventsBanner` to this app's clients.
 *
 * Its own module, reached only through the lazy import in `AccountBanners`, so
 * `@simplewebauthn/browser` — which the step-up ceremony pulls in — stays out
 * of the entry chunk. This module imports the assertion ceremony and must
 * never import the enrolment one: the banner mounts on every route a signed-in
 * user sees, while enrolment only ever runs from the Security tab.
 *
 * Mounting it is what makes recovery-code generate and consume events reach
 * the user inside the application, rather than only in an email that a filter
 * or an attacker holding the mailbox can swallow.
 */
export default function SecurityEventsBannerMount(props: {
  accessToken: string;
  onVisibleCountChange?: (count: number) => void;
}) {
  return (
    <SecurityEventsBanner
      client={securityEventsClient}
      stepUpClient={stepUpClient}
      accessToken={props.accessToken}
      runPasskeyCeremony={runPasskeyCeremony}
      totpClient={totpClient}
      productName={PRODUCT_NAME}
      onVisibleCountChange={props.onVisibleCountChange}
    />
  );
}
