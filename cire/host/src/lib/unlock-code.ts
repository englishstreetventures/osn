// An owner redeeming an unlock code: the request and its copy. The API decides
// everything — whether the code is good, whether the wedding needs it — and
// this only turns its answer into words.
// Frontend code: no Effect.
import type { AuthFetch } from "@shared/rp-auth";

import { apiUrl, weddingPath } from "./api";
import { isPaidTier, isTier, TIER_LABEL } from "./tiers";
import type { PaidTier } from "./tiers";

/** The refusals worded the same whatever else the body says. */
const REFUSALS = {
  // Unknown, expired and used up are one answer from the API, by design.
  unlock_code_invalid:
    "That code is not valid, or it has expired or been used. Check it against the one you were given.",
  purchase_in_flight:
    "An upgrade payment for this wedding is still open. Try the code again once it has finished or closed, within a day.",
  forbidden: "Only an owner of this wedding can use a code.",
} as const;

const FALLBACK = "Could not check the code. Try again.";

export type RedeemOutcome = { ok: true; tier: PaidTier } | { ok: false; message: string };

function refusal(status: number, body: { error?: unknown; tier?: unknown } | null): string {
  const error = body?.error;
  if (error === "tier_already_held" && isTier(body?.tier)) {
    return `This wedding is already on ${TIER_LABEL[body.tier]}, so the code would add nothing. It has not been used.`;
  }
  if (typeof error === "string" && Object.hasOwn(REFUSALS, error)) {
    return REFUSALS[error as keyof typeof REFUSALS];
  }
  if (status === 429) return "Too many attempts. Wait a minute and try again.";
  return FALLBACK;
}

/** Redeem `code` for the wedding. Surrounding spaces go; the API folds the rest. */
export async function redeemUnlockCode(
  authFetch: AuthFetch,
  weddingId: string,
  code: string,
): Promise<RedeemOutcome> {
  const res = await authFetch(apiUrl(weddingPath(weddingId, "/unlock-code")), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ unlockCode: code.trim() }),
  });
  const body = (await res.json().catch(() => null)) as { error?: unknown; tier?: unknown } | null;
  if (res.ok && isPaidTier(body?.tier)) return { ok: true, tier: body.tier };
  return { ok: false, message: res.ok ? FALLBACK : refusal(res.status, body) };
}
