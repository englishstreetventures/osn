/**
 * Account-level client helpers — currently just the step-up-gated email
 * change ceremony. Kept in its own module so the settings UI can import
 * only what it needs without dragging in the full Effect service.
 */

export interface AccountClientConfig {
  /** OSN issuer base URL, e.g. http://localhost:4000 */
  issuerUrl: string;
}

export class AccountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AccountError";
  }
}

export interface AccountClient {
  /** Sends an OTP to the NEW email address. Does not mutate the account yet. */
  changeEmailBegin(input: { accessToken: string; newEmail: string }): Promise<{ sent: true }>;
  /**
   * Swaps the account's email after verifying both the OTP (sent to the
   * new address by `changeEmailBegin`) and a fresh step-up token. Revokes
   * every other session atomically with the email update.
   */
  changeEmailComplete(input: {
    accessToken: string;
    code: string;
    stepUpToken: string;
  }): Promise<{ email: string }>;
}

async function postJson<T>(url: string, bearer: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${bearer}`,
    },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as T & { error?: string };
  if (!res.ok) {
    throw new AccountError(json.error ?? `Request failed: ${res.status}`);
  }
  return json;
}

export function createAccountClient(config: AccountClientConfig): AccountClient {
  const base = config.issuerUrl.replace(/\/$/, "");

  return {
    changeEmailBegin: (input) =>
      postJson<{ sent: true }>(`${base}/account/email/begin`, input.accessToken, {
        new_email: input.newEmail,
      }),
    changeEmailComplete: (input) =>
      postJson<{ email: string }>(`${base}/account/email/complete`, input.accessToken, {
        code: input.code,
        step_up_token: input.stepUpToken,
      }),
  };
}
