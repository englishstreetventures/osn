import type { FeatureFlags, ForRequestOptions } from "@shared/feature-flags";

import type { OsnAccountResolver } from "../services/osn-bridge";

/**
 * Feature flag gating the whole OSN ("Pulse") account-linking surface, and
 * with it the household member step. Off ⇒ the link POST answers 503, the
 * claim and restore responses report the household's linking as disabled and
 * carry no member, so the guest site draws no account-link box and no "Who
 * are you?" step, and an RSVP needs no member. Default off (the `FLAGS`
 * registry in `@shared/feature-flags`).
 */
export const ACCOUNT_LINKING_FLAG = "cire.account-linking" as const;

export interface AccountLinking {
  flags: FeatureFlags;
  /**
   * An ARC resolver is configured, so a link POST can complete. Without one
   * that POST can only answer 503, so the box is not offered either.
   */
  canLink: boolean;
  /**
   * Resolves a profile to its account over ARC, to tell whether this
   * browser's sign-in is the account a household member is linked to.
   */
  resolveAccountId?: OsnAccountResolver;
  /**
   * The same lookup without the cache, for the RSVP's `submitted_via_link`
   * stamp: a profile osn-api has since erased must stop vouching for a reply
   * at once, not when a cached answer expires.
   */
  resolveAccountIdFresh?: OsnAccountResolver;
  /**
   * Origins a musubi profile picture may load from on the guest site. Any
   * other avatar URL is dropped, and the box shows the account's initial.
   */
  avatarOrigins?: readonly string[];
}

/**
 * Whether this household is offered account linking: the flag is on for it
 * (bucketed by household, so a percentage rollout is stable per family) and
 * the deployment can complete a link.
 *
 * Never rejects. A flag provider that throws reads as off, the same answer the
 * registry default gives, so a flag outage hides the optional box rather than
 * failing the invite that carries it.
 *
 * Given the request's `waitUntil`, a stale cached flag payload answers at once
 * and refreshes in the background, so only a cold isolate waits on GrowthBook.
 */
export async function isAccountLinkingOn(
  linking: AccountLinking,
  familyId: string,
  waitUntil?: ForRequestOptions["waitUntil"],
): Promise<boolean> {
  if (!linking.canLink) return false;
  try {
    const flags = await linking.flags.forRequest({ id: familyId }, { waitUntil });
    return flags.isOn(ACCOUNT_LINKING_FLAG);
  } catch {
    return false;
  }
}
