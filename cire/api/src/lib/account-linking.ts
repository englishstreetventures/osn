import type { FeatureFlags } from "@shared/feature-flags";

/**
 * Feature flag gating the whole OSN ("Pulse") account-linking surface. Off ⇒
 * the link POST answers 503 and the claim and restore responses report the
 * household's linking as disabled, so the guest site draws no account-link
 * box. Default off (the `FLAGS` registry in `@shared/feature-flags`).
 */
export const ACCOUNT_LINKING_FLAG = "cire.account-linking" as const;

export interface AccountLinking {
  flags: FeatureFlags;
  /**
   * An ARC resolver is configured, so a link POST can complete. Without one
   * that POST can only answer 503, so the box is not offered either.
   */
  canLink: boolean;
}

/**
 * Whether this household is offered account linking: the flag is on for it
 * (bucketed by household, so a percentage rollout is stable per family) and
 * the deployment can complete a link.
 *
 * Never rejects. A flag provider that throws reads as off, the same answer the
 * registry default gives, so a flag outage hides the optional box rather than
 * failing the invite that carries it.
 */
export async function isAccountLinkingOn(
  linking: AccountLinking,
  familyId: string,
): Promise<boolean> {
  if (!linking.canLink) return false;
  try {
    const flags = await linking.flags.forRequest({ id: familyId });
    return flags.isOn(ACCOUNT_LINKING_FLAG);
  } catch {
    return false;
  }
}
