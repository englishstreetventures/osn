import type { RpSession } from "@shared/rp-auth";

/** Best available name for the account: display name, then handle, then email. */
export function accountName(session: RpSession | null | undefined): string {
  return session?.displayName ?? session?.handle ?? session?.email ?? "Your account";
}
