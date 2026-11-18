/**
 * An app's step-up request, Musubi's half.
 *
 * An app whose own pages cannot run a step-up (cire's organiser portal holds
 * no OSN token, and passkeys are bound to Musubi's origin) asks osn-api for a
 * request over ARC and sends the person to Musubi's confirm page with its id.
 * The page reads the request, runs a step-up for the request's purpose, and
 * confirms; osn-api answers where to send the person back, with a code on the
 * address's fragment that only the app's page in the browser that asked can
 * use. Read by Musubi's `/confirm/:requestId` page.
 *
 * Each call ends at {@link STEP_UP_DEADLINE_MS}, as every step-up call does.
 */

import { reach, readJson, withDeadline } from "./auth-fetch";
import type { AuthFetch } from "./runtime";
import { STEP_UP_DEADLINE_MS, StepUpError, type StepUpPurpose } from "./step-up";

export interface AppStepUpClientConfig {
  /** osn-api's origin. */
  issuerUrl: string;
  /** Renews the access token and retries once on a 401. */
  authFetch: AuthFetch;
}

/** A pending request of the signed-in account: what it asks, and where it returns. */
export interface AppStepUpRequest {
  readonly purpose: StepUpPurpose;
  /** The host the person is sent back to, shown on the page before they confirm. */
  readonly returnHost: string;
}

/** What a confirm answered. */
export type AppStepUpConfirmed =
  | { readonly status: "confirmed"; readonly returnTo: string }
  /** No pending request of this account by that id: gone, used, or never this account's. */
  | { readonly status: "gone" };

/**
 * A rejection of `authFetch` about the session reaches the caller unchanged;
 * every other failure is a `StepUpError`: a refused step-up token is one at
 * status `403`, a rate limit at `429`, no answer in time at `0`.
 */
export interface AppStepUpClient {
  /** The pending request `requestId` of the signed-in account, or null when there is none. */
  read(requestId: string): Promise<AppStepUpRequest | null>;
  /** Confirms the request with a step-up token minted for its purpose. */
  confirm(input: { requestId: string; stepUpToken: string }): Promise<AppStepUpConfirmed>;
}

export function createAppStepUpClient(config: AppStepUpClientConfig): AppStepUpClient {
  const base = config.issuerUrl.replace(/\/$/, "");
  const { authFetch } = config;
  const urlOf = (requestId: string) => `${base}/step-up/requests/${encodeURIComponent(requestId)}`;

  return {
    read: (requestId) =>
      withDeadline(StepUpError, STEP_UP_DEADLINE_MS, async (signal) => {
        const res = await reach(
          StepUpError,
          urlOf(requestId),
          { method: "GET", credentials: "include", signal },
          authFetch,
        );
        if (res.status === 404) return null;
        if (!res.ok) throw new StepUpError(`Request failed: ${res.status}`, res.status);
        const raw = await readJson<{ purpose?: unknown; return_host?: unknown }>(StepUpError, res);
        if (raw.purpose !== "cire_app_delete" || typeof raw.return_host !== "string") {
          throw new StepUpError("Unexpected step-up request", 200);
        }
        return { purpose: raw.purpose, returnHost: raw.return_host };
      }),
    confirm: (input) =>
      withDeadline(StepUpError, STEP_UP_DEADLINE_MS, async (signal) => {
        const res = await reach(
          StepUpError,
          `${urlOf(input.requestId)}/confirm`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "include",
            body: JSON.stringify({ step_up_token: input.stepUpToken }),
            signal,
          },
          authFetch,
        );
        if (res.status === 404) return { status: "gone" };
        if (!res.ok) throw new StepUpError(`Request failed: ${res.status}`, res.status);
        const raw = await readJson<{ return_to?: unknown }>(StepUpError, res);
        if (typeof raw.return_to !== "string") {
          throw new StepUpError("Unexpected step-up answer", 200);
        }
        return { status: "confirmed", returnTo: raw.return_to };
      }),
  };
}
