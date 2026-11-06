/**
 * Out-of-band security event client (M-PK1b).
 *
 * Backs the banner that surfaces "did you do this?" prompts for account-level
 * security actions. Where that banner mounts is the host application's
 * choice; `@musubi/social` puts it in the application shell, so it is seen
 * without being looked for. The banner renders what's on the audit trail even
 * if the confirmation email was suppressed by an attacker holding the inbox.
 */

import type { AuthFetch } from "./runtime";

export interface SecurityEventsClientConfig {
  /** OSN issuer base URL, e.g. http://localhost:4000 */
  issuerUrl: string;
  /** The page runtime's `authFetch` (`createOsnAuthRuntime`). */
  authFetch: AuthFetch;
}

export class SecurityEventsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecurityEventsError";
  }
}

/** Keep in sync with SecurityEventKind in @shared/observability/metrics. */
export type SecurityEventKind = "recovery_code_generate" | "recovery_code_consume";

export interface SecurityEventSummary {
  id: string;
  kind: SecurityEventKind;
  /** Unix seconds */
  createdAt: number;
  uaLabel: string | null;
  ipHash: string | null;
}

/**
 * A rejection of `authFetch` reaches the caller unchanged; a failed response
 * becomes a `SecurityEventsError`.
 */
export interface SecurityEventsClient {
  list(): Promise<{ events: SecurityEventSummary[] }>;
  /**
   * Acknowledges a single security event. Requires a fresh step-up token —
   * the banner is the defence against a compromised access token, so the
   * access token alone cannot dismiss it.
   */
  acknowledge(input: { id: string; stepUpToken: string }): Promise<{ acknowledged: boolean }>;
  /**
   * Dismisses every unacknowledged event in a single call. One step-up
   * ceremony → the entire banner clears. Matches the UX pattern used by
   * `POST /sessions/revoke-all-other`.
   */
  acknowledgeAll(input: { stepUpToken: string }): Promise<{ acknowledged: number }>;
}

const INIT: RequestInit = {
  credentials: "include",
  headers: { "Content-Type": "application/json" },
};

export function createSecurityEventsClient(
  config: SecurityEventsClientConfig,
): SecurityEventsClient {
  const base = config.issuerUrl.replace(/\/$/, "");
  const { authFetch } = config;

  return {
    list: async () => {
      const res = await authFetch(`${base}/account/security-events`, INIT);
      const json = (await res.json()) as { events?: SecurityEventSummary[]; error?: string };
      if (!res.ok || !Array.isArray(json.events)) {
        throw new SecurityEventsError(json.error ?? `Request failed: ${res.status}`);
      }
      return { events: json.events };
    },
    acknowledge: async (input) => {
      const res = await authFetch(
        `${base}/account/security-events/${encodeURIComponent(input.id)}/ack`,
        {
          ...INIT,
          method: "POST",
          body: JSON.stringify({ step_up_token: input.stepUpToken }),
        },
      );
      const json = (await res.json()) as { acknowledged?: boolean; error?: string };
      if (!res.ok) {
        throw new SecurityEventsError(json.error ?? `Request failed: ${res.status}`);
      }
      return { acknowledged: json.acknowledged === true };
    },
    acknowledgeAll: async (input) => {
      const res = await authFetch(`${base}/account/security-events/ack-all`, {
        ...INIT,
        method: "POST",
        body: JSON.stringify({ step_up_token: input.stepUpToken }),
      });
      const json = (await res.json()) as { acknowledged?: number; error?: string };
      if (!res.ok || typeof json.acknowledged !== "number") {
        throw new SecurityEventsError(json.error ?? `Request failed: ${res.status}`);
      }
      return { acknowledged: json.acknowledged };
    },
  };
}
