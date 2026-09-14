/**
 * Whether this device has been told to stop offering recovery-code setup, per
 * profile.
 *
 * Scoped to a profile id rather than to the account, because no account id
 * ever reaches the client — the access token carries `sub`, `email`, `handle`
 * and `displayName` and nothing else, and no authenticated route returns one.
 * The account email is the only account-wide identifier available here, and a
 * key built from it would leave one person's address in `localStorage` for the
 * next person to use the device. A profile id is opaque and scopes the
 * decision more narrowly than the account, so a shared device never hides the
 * prompt from its next user. The cost is that an account with several profiles
 * is asked once per profile.
 *
 * Reads and writes fail soft: `localStorage` throws outright in a private
 * window, and the right answer when the decision cannot be stored is to ask
 * again rather than to crash a banner.
 */

const KEY_PREFIX = "musubi:recovery-codes-prompt-dismissed:";

function keyFor(profileId: string): string {
  return `${KEY_PREFIX}${profileId}`;
}

export function isRecoveryPromptDismissed(profileId: string | null): boolean {
  if (!profileId) return false;
  try {
    return localStorage.getItem(keyFor(profileId)) === "1";
  } catch {
    return false;
  }
}

export function dismissRecoveryPrompt(profileId: string | null): void {
  if (!profileId) return;
  try {
    localStorage.setItem(keyFor(profileId), "1");
  } catch {
    /* ignore write failures — the prompt reappears on the next load */
  }
}
