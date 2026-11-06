/**
 * Out-of-band security event client (M-PK1b).
 *
 * Backs the banner that surfaces "did you do this?" prompts for account-level
 * security actions. Where that banner mounts is the host application's
 * choice; `@musubi/social` puts it in the application shell, so it is seen
 * without being looked for. The banner renders what's on the audit trail even
 * if the confirmation email was suppressed by an attacker holding the inbox.
 */

import { OsnApiError } from "./api-error";
import { reach, readJson, responseError } from "./auth-fetch";

export interface SecurityEventsClientConfig {
  /** OSN issuer base URL, e.g. http://localhost:4000 */
  issuerUrl: string;
}

export class SecurityEventsError extends OsnApiError {
  constructor(message: string, status: number, code?: string) {
    super(message, status, code);
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
   * Acknowledges a single security event. Requires a fresh step-up token —
   * the banner is the defence against a compromised access token, so the
   * access token alone cannot dismiss it.
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

function withAuth(accessToken: string): RequestInit {
  return {
    credentials: "include",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
  };
}

export function createSecurityEventsClient(
  config: SecurityEventsClientConfig,
): SecurityEventsClient {
  const base = config.issuerUrl.replace(/\/$/, "");

  return {
    list: async (input) => {
      const res = await reach(SecurityEventsError, `${base}/account/security-events`, {
        ...withAuth(input.accessToken),
      });
      const json = await readJson<{ events?: SecurityEventSummary[] }>(SecurityEventsError, res);
      if (!Array.isArray(json.events)) throw responseError(SecurityEventsError, res, json);
      return { events: json.events };
    },
    acknowledge: async (input) => {
      const res = await reach(
        SecurityEventsError,
        `${base}/account/security-events/${encodeURIComponent(input.id)}/ack`,
        {
          ...withAuth(input.accessToken),
          method: "POST",
          body: JSON.stringify({ step_up_token: input.stepUpToken }),
        },
      );
      const json = await readJson<{ acknowledged?: boolean }>(SecurityEventsError, res);
      return { acknowledged: json.acknowledged === true };
    },
    acknowledgeAll: async (input) => {
      const res = await reach(SecurityEventsError, `${base}/account/security-events/ack-all`, {
        ...withAuth(input.accessToken),
        method: "POST",
        body: JSON.stringify({ step_up_token: input.stepUpToken }),
      });
      const json = await readJson<{ acknowledged?: number }>(SecurityEventsError, res);
      if (typeof json.acknowledged !== "number") {
        throw responseError(SecurityEventsError, res, json);
      }
      return { acknowledged: json.acknowledged };
    },
  };
}
