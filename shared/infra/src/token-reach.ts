import type { CheckOutcome } from "./secrets/check";
import { redactAccountIds } from "./secrets/compare";

/** The HTTP status and body of `GET /client/v4/accounts` called with a tier's token. */
export interface AccountListing {
  readonly status: number;
  readonly body: string;
}

const refused = (exitCode: 1 | 2, message: string): CheckOutcome => ({
  exitCode,
  stdout: "",
  stderr: `${redactAccountIds(message)}\n`,
});

/**
 * Dev and production are kept apart only by which account each tier's token
 * reaches, so a run goes ahead only when the token reaches exactly one
 * account and it is the one `accountId` names. Exits 1 when the token reaches
 * any other account, or none; 2 when the listing fails or cannot be read.
 * Prints no account id.
 */
export function checkTokenReach(accountId: string, listing: AccountListing): CheckOutcome {
  let parsed: unknown;
  try {
    parsed = JSON.parse(listing.body);
  } catch {
    return refused(
      2,
      `GET /accounts returned HTTP ${listing.status} with a body that is not JSON.`,
    );
  }
  const response = parsed as {
    readonly success?: unknown;
    readonly errors?: readonly { readonly code?: unknown; readonly message?: unknown }[];
    readonly result?: unknown;
    readonly result_info?: { readonly total_count?: unknown };
  };
  if (listing.status !== 200 || response.success !== true || !Array.isArray(response.result)) {
    const errors = (response.errors ?? [])
      .map((error) => `${String(error.code)} ${String(error.message)}`)
      .join("; ");
    return refused(
      2,
      `GET /accounts returned HTTP ${listing.status}${errors === "" ? "" : `: ${errors}`}. The token must be able to list the accounts it reaches.`,
    );
  }
  const ids = (response.result as readonly { readonly id?: unknown }[]).map(
    (account) => account.id,
  );
  const total =
    typeof response.result_info?.total_count === "number"
      ? response.result_info.total_count
      : ids.length;
  if (total !== 1 || ids.length !== 1) {
    return refused(
      1,
      `This token reaches ${total} accounts. A tier's token must reach exactly one: its own.`,
    );
  }
  if (ids[0] !== accountId) {
    return refused(
      1,
      "This token reaches one account, but not the one CLOUDFLARE_ACCOUNT_ID names.",
    );
  }
  return {
    exitCode: 0,
    stdout: "The token reaches exactly the account CLOUDFLARE_ACCOUNT_ID names.\n",
    stderr: "",
  };
}
