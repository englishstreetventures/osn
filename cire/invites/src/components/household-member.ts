import { invitedMembers } from "./plus-one";
import type { AccountLinkState, ClaimResult, FamilyMember, MemberEmail } from "./types";
import { readAccountLink, readEmail, readMember } from "./utils";

// The household member step: a claim code proves a household, not a person,
// so the invite asks which member is at the keyboard. Replies and the musubi
// link then hang off that choice. The step is on only when the claim payload
// carries `member`: cire-api sends it for every guest household but a host
// preview, and a household of a wedding in `CIRE_MEMBER_STEP_EXCLUDED_WEDDING_IDS`
// while account linking is off for it (`memberStepOn`). The link box waits on
// `cire.account-linking`; so does the step itself in an excluded wedding.

/** Whether the member step is on for this household. */
export function hasMemberStep(result: ClaimResult | null): boolean {
  return result !== null && result.preview !== true && readMember(result) !== null;
}

/** The chosen member, or null for none yet (or no step). */
export function chosenMember(result: ClaimResult | null): FamilyMember | null {
  if (result === null) return null;
  const id = readMember(result)?.guestId ?? null;
  if (id === null) return null;
  return result.members.find((m) => m.guestId === id) ?? null;
}

/** Whether the household must say who is answering before it can reply. */
export function memberRequired(result: ClaimResult | null): boolean {
  return (
    hasMemberStep(result) &&
    chosenMember(result) === null &&
    invitedMembers(result?.members ?? []).length >= 2
  );
}

/**
 * The page's result once `POST /api/claim/member` answered: the member, their
 * own address when they have one, and the account-link state the API computed
 * for them.
 */
export function withChosenMember(
  result: ClaimResult,
  guestId: string,
  accountLink: unknown,
  email: MemberEmail | null = null,
): ClaimResult {
  return {
    ...result,
    member: email === null ? { guestId } : { guestId, email },
    accountLink: accountLink ?? result.accountLink,
  };
}

/** The page's result once the chosen member saved or removed their address. */
export function withMemberEmail(result: ClaimResult, email: MemberEmail | null): ClaimResult {
  const guestId = readMember(result)?.guestId ?? null;
  if (guestId === null) return result;
  return { ...result, member: email === null ? { guestId } : { guestId, email } };
}

/**
 * The page's result after "Not you?": no member, and no musubi sign-in — the
 * control ends that too, so the next person cannot reuse it.
 */
export function withoutMember(result: ClaimResult): ClaimResult {
  const link: AccountLinkState | null = readAccountLink(result.accountLink);
  return {
    ...result,
    member: null,
    accountLink: link
      ? { enabled: true, signedIn: false, linkedGuestIds: link.linkedGuestIds }
      : result.accountLink,
  };
}

/** Choose who this session says it is. Resolves with the API's answer body,
 *  or null when it refused or could not be reached. */
export async function chooseMember(
  apiUrl: string,
  guestId: string,
): Promise<{ accountLink: unknown; email: MemberEmail | null } | null> {
  try {
    const res = await fetch(`${apiUrl}/api/claim/member`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ guestId }),
    });
    if (!res.ok) return null;
    const body: unknown = await res.json().catch(() => null);
    const member =
      typeof body === "object" && body !== null && "member" in body ? body.member : undefined;
    return {
      accountLink:
        typeof body === "object" && body !== null && "accountLink" in body
          ? body.accountLink
          : undefined,
      email:
        typeof member === "object" && member !== null && "email" in member
          ? readEmail(member.email)
          : null,
    };
  } catch {
    return null;
  }
}

/**
 * "Not you?": clear the member and end this browser's cire musubi sign-in.
 * Both requests run together; resolves true only when the server confirmed
 * both, so the page never shows a cleared state that a reload would undo. The
 * sign-in is shared with the organiser portal on this browser, so this signs
 * the organiser out there too (by design: the person at the keyboard said the
 * account is not theirs).
 */
export async function notYou(apiUrl: string): Promise<boolean> {
  const cleared = fetch(`${apiUrl}/api/claim/member`, {
    method: "DELETE",
    credentials: "include",
  }).then(
    (res) => res.ok,
    () => false,
  );
  const signedOut = import("@shared/rp-auth").then(
    (auth) => auth.signOut({ apiBase: apiUrl }),
    () => false,
  );
  const [member, signIn] = await Promise.all([cleared, signedOut]);
  return member && signIn;
}
