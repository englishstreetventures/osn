import * as Cloudflare from "alchemy/Cloudflare";

/**
 * The providers and state store every product stack passes to `Alchemy.Stack`.
 * State lives in the account's Alchemy state store; `scripts/check-alchemy-usage.ts`
 * refuses any other state constructor in a stack file.
 */
export const stackOptions = () => ({
  providers: Cloudflare.providers(),
  state: Cloudflare.state(),
});
