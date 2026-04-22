/**
 * Out-of-band security event client (M-PK1b).
 *
 * Backs the Settings banner that surfaces "did you do this?" prompts for
 * account-level security actions (recovery-code regeneration today, more
 * kinds to follow). The banner renders what's on the audit trail even if
 * the confirmation email was suppressed by an attacker holding the inbox.
 */

export interface SecurityEventsClientConfig {
  /** OSN issuer base URL, e.g. http://localhost:4000 */
  issuerUrl: string;
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

export interface SecurityEventsClient {
  list(input: { accessToken: string }): Promise<{ events: SecurityEventSummary[] }>;
  /**
   * Acknowledges a single security event. Requires a fresh step-up token
   * (S-M1) — the banner is the defence against a compromised access token,
   * so the access token alone cannot dismiss it.
   */
  acknowledge(input: {
    accessToken: string;
    id: string;
    stepUpToken: string;
  }): Promise<{ acknowledged: boolean }>;
  /**
   * Dismisses every unacknowledged event in a single call. One step-up
   * ceremony → the entire banner clears. Matches the UX pattern used by
   * `POST /sessions/revoke-all-other`.
   */
  acknowledgeAll(input: {
    accessToken: string;
    stepUpToken: string;
  }): Promise<{ acknowledged: number }>;
}

export function createSecurityEventsClient(
  config: SecurityEventsClientConfig,
): SecurityEventsClient {
  const base = config.issuerUrl.replace(/\/$/, "");

  const withAuth = (accessToken: string): RequestInit => ({
    credentials: "include",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
  });

  return {
    list: async (input) => {
      const res = await fetch(`${base}/account/security-events`, {
        ...withAuth(input.accessToken),
      });
      const json = (await res.json()) as { events?: SecurityEventSummary[]; error?: string };
      if (!res.ok || !Array.isArray(json.events)) {
        throw new SecurityEventsError(json.error ?? `Request failed: ${res.status}`);
      }
      return { events: json.events };
    },
    acknowledge: async (input) => {
      const res = await fetch(
        `${base}/account/security-events/${encodeURIComponent(input.id)}/ack`,
        {
          ...withAuth(input.accessToken),
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
      const res = await fetch(`${base}/account/security-events/ack-all`, {
        ...withAuth(input.accessToken),
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
