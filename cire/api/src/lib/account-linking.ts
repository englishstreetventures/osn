import type { FeatureFlags, ForRequestOptions } from "@shared/feature-flags";

import type { OsnAccountResolver } from "../services/osn-bridge";

/**
 * Feature flag gating the whole OSN ("Pulse") account-linking surface. Off ⇒
 * the link POST answers 503, the claim, restore and member-choice responses
 * report the household's linking as disabled, so the guest site draws no
 * account-link box, and no reply is marked as sent through a linked account.
 * The household member step ("Who are you?", reply attribution,
 * `member_required`) is on for every guest household whatever the flag says,
 * except in a wedding listed in `CIRE_MEMBER_STEP_EXCLUDED_WEDDING_IDS`
 * ({@link memberStepOn}). Default off (the `FLAGS` registry in
 * `@shared/feature-flags`).
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
  /**
   * Weddings whose households get the member step only while
   * `cire.account-linking` is on for them, from the
   * `CIRE_MEMBER_STEP_EXCLUDED_WEDDING_IDS` secret. Absent or empty ⇒ every
   * guest household gets it. See {@link memberStepOn}.
   */
  memberStepExcludedWeddings?: ReadonlySet<string>;
}

/** A wedding id as `weddingsService` mints it, or the reserved bootstrap one. */
const WEDDING_ID = /^wed_(?:[0-9a-f]{32}|bootstrap)$/;

/** The parsed `CIRE_MEMBER_STEP_EXCLUDED_WEDDING_IDS`. */
export interface WeddingIdList {
  weddings: ReadonlySet<string>;
  /**
   * Entries that are not the shape of a wedding id, so match no wedding: a
   * typo, a quoted id, a name. A value that is not text at all counts as one.
   */
  malformed: number;
}

/**
 * The wedding ids in `CIRE_MEMBER_STEP_EXCLUDED_WEDDING_IDS`: comma-separated,
 * each trimmed, blanks dropped. Unset ⇒ none. Typed `unknown` because a
 * dashboard value reaches the binding with its own type; one that is not text
 * reads as none rather than failing the app built from it.
 */
export function parseWeddingIdList(raw: unknown): WeddingIdList {
  if (raw === undefined) return { weddings: new Set(), malformed: 0 };
  if (typeof raw !== "string") return { weddings: new Set(), malformed: 1 };
  const weddings = new Set(
    raw
      .split(",")
      .map((id) => id.trim())
      .filter((id) => id.length > 0),
  );
  const malformed = [...weddings].filter((id) => !WEDDING_ID.test(id)).length;
  return { weddings, malformed };
}

/**
 * Whether a household of `weddingId` gets the member step ("Who are you?",
 * reply attribution, `member_required`, "Answered by"). Every guest household
 * does, except in a wedding listed in `excluded`, where the step rides the
 * account-linking flag: on only while `linkingOn` is.
 */
export function memberStepOn(
  excluded: ReadonlySet<string> | undefined,
  weddingId: string,
  linkingOn: boolean,
): boolean {
  return linkingOn || excluded?.has(weddingId) !== true;
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
