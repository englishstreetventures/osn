/**
 * Account-data export client (C-H1, GDPR Art. 15 + Art. 20).
 *
 * Two endpoints:
 *   - `GET /account/export/status` — lightweight, no step-up; returns the
 *     last export timestamp and when the next export becomes available
 *     under the daily limiter. The UI polls this so it can render a
 *     countdown without burning the daily budget.
 *   - `GET /account/export` — streams the NDJSON bundle. Step-up gated
 *     (passkey or OTP). Returns a `Response` so the caller can pipe the
 *     stream straight to the browser download / Tauri save dialog
 *     without ever materialising the bundle in memory.
 */

export interface AccountExportClientConfig {
  /** OSN issuer base URL, e.g. http://localhost:4000 */
  issuerUrl: string;
}

export interface AccountExportStatus {
  lastExportAt: string | null;
  nextAvailableAt: string | null;
}

export class AccountExportError extends Error {
  constructor(
    message: string,
    readonly code:
      | "step_up_required"
      | "rate_limited"
      | "invalid_step_up_token"
      | "unauthorized"
      | "network_error"
      | "unknown" = "unknown",
  ) {
    super(message);
    this.name = "AccountExportError";
  }
}

export interface AccountExportClient {
  status(input: { accessToken: string }): Promise<AccountExportStatus>;
  /**
   * Initiates the streaming download. Returns a `Response` whose body is
   * the NDJSON stream. The caller is responsible for piping it to
   * disk / browser download — call `.body` and pipe through
   * `URL.createObjectURL(await response.blob())` for browser, or
   * stream chunks to the Tauri save dialog.
   */
  download(input: { accessToken: string; stepUpToken: string }): Promise<Response>;
}

export function createAccountExportClient(config: AccountExportClientConfig): AccountExportClient {
  const base = config.issuerUrl.replace(/\/$/, "");
  return {
    status: async ({ accessToken }) => {
      const res = await fetch(`${base}/account/export/status`, {
        credentials: "include",
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (res.status === 401) throw new AccountExportError("unauthorized", "unauthorized");
      if (res.status === 429) throw new AccountExportError("rate_limited", "rate_limited");
      if (!res.ok) throw new AccountExportError(`HTTP ${res.status}`, "unknown");
      return (await res.json()) as AccountExportStatus;
    },
    download: async ({ accessToken, stepUpToken }) => {
      const res = await fetch(`${base}/account/export`, {
        credentials: "include",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          // Step-up token in a header so it doesn't end up in URL access
          // logs even though the endpoint accepts it via query for
          // browsers that can't inject headers on <a download>.
          "X-Step-Up-Token": stepUpToken,
        },
      });
      if (res.status === 401) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        if (body.error === "invalid_step_up_token") {
          throw new AccountExportError("invalid_step_up_token", "invalid_step_up_token");
        }
        throw new AccountExportError("unauthorized", "unauthorized");
      }
      if (res.status === 403) {
        throw new AccountExportError("step_up_required", "step_up_required");
      }
      if (res.status === 429) throw new AccountExportError("rate_limited", "rate_limited");
      if (!res.ok) throw new AccountExportError(`HTTP ${res.status}`, "unknown");
      return res;
    },
  };
}
