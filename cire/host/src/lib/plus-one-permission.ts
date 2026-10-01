// Who may bring a plus-one, as the organiser portal reads and writes it.
//
// The permission lives on each guest's row (`plusOneAllowed`); a plus-one is a
// row of its own whose `plusOneOf` names the guest who brought them. An editor
// sets the permission for one guest or for every member of a household, and
// turning it off where a plus-one is already named deletes that plus-one with
// their replies — which the API refuses (409 `plus_one_named`) unless the
// request lists every plus-one in scope as confirmed. The contract is
// `wiki/cire/cire-plus-ones.md`.
//
// `authFetch` is a parameter, never an import (see `api.ts`). Frontend code:
// no Effect.
import type { AuthFetch } from "@shared/rp-auth";

import { apiUrl, weddingPath } from "./api";
import type { OrganiserGuestRow } from "./guests-store";

/** One guest's permission, or every member's in one household. */
export type PlusOneScope =
  | { kind: "guest"; guestId: string }
  | { kind: "household"; familyId: string };

/** The fields of a guest row these helpers read. */
type PermissionRow = Pick<
  OrganiserGuestRow,
  "guestId" | "familyId" | "plusOneAllowed" | "plusOneOf"
>;

/** A plus-one's row: it names the guest who brought them. */
export const isPlusOne = (row: Pick<OrganiserGuestRow, "plusOneOf">): boolean =>
  row.plusOneOf != null;

/**
 * Whether the API that served these rows knows about plus-ones at all.
 *
 * The portal and the API deploy separately, and the portal can reach a tier
 * first. An API older than the columns sends no `plusOneAllowed`, and a write to
 * a route it does not have would only fail, so the controls stay hidden.
 */
export function supportsPlusOnes(
  rows: readonly Pick<OrganiserGuestRow, "plusOneAllowed">[],
): boolean {
  return rows.some((row) => typeof row.plusOneAllowed === "boolean");
}

/**
 * Each plus-one directly after the guest who brought them, everyone else in
 * the order given. The organiser list arrives in `sort_order`, and a plus-one's
 * number is whatever was free when they were named, so placement goes by the
 * link. A plus-one whose inviter is not among `members` keeps its place.
 */
export function placePlusOnesAfterInviters<
  T extends { guestId: string; plusOneOf?: string | null },
>(members: readonly T[]): T[] {
  const present = new Set(members.map((m) => m.guestId));
  const byInviter = new Map<string, T>();
  for (const m of members) {
    if (m.plusOneOf != null && present.has(m.plusOneOf)) byInviter.set(m.plusOneOf, m);
  }
  return members
    .filter((m) => m.plusOneOf == null || !present.has(m.plusOneOf))
    .flatMap((m) => {
      const plusOne = byInviter.get(m.guestId);
      return plusOne ? [m, plusOne] : [m];
    });
}

/** How many of a household's own guests may bring a plus-one, of how many. */
export interface HouseholdPermission {
  allowed: number;
  total: number;
}

/** Count a household's permission. Plus-ones are not counted: they cannot
 *  bring one. */
export function householdPermission(
  members: readonly Pick<OrganiserGuestRow, "plusOneAllowed" | "plusOneOf">[],
): HouseholdPermission {
  let allowed = 0;
  let total = 0;
  for (const member of members) {
    if (isPlusOne(member)) continue;
    total += 1;
    if (member.plusOneAllowed === true) allowed += 1;
  }
  return { allowed, total };
}

/** Is `row` one whose permission a write to `scope` sets? */
function isCoveredBy(row: PermissionRow, scope: PlusOneScope): boolean {
  if (isPlusOne(row)) return false;
  return scope.kind === "guest" ? row.guestId === scope.guestId : row.familyId === scope.familyId;
}

/**
 * The named plus-ones that turning `scope` off would delete: the one the guest
 * brought, or every plus-one in the household — the household route deletes
 * them all.
 *
 * Pass the whole list, never a search-filtered view of it: the confirmation
 * built from this has to name everyone the delete reaches.
 */
export function plusOnesRemovedBy<T extends PermissionRow>(
  rows: readonly T[],
  scope: PlusOneScope,
): T[] {
  return scope.kind === "guest"
    ? rows.filter((row) => row.plusOneOf === scope.guestId)
    : rows.filter((row) => row.familyId === scope.familyId && isPlusOne(row));
}

/**
 * The rows after a successful write of `allowed` to `scope`.
 *
 * Turning permission off always leaves no plus-one in scope on the server: the
 * API writes only when every plus-one in scope was confirmed, and deletes them
 * with the switch. So they come out of the rows either way — keeping one the
 * household had already removed would show a guest who no longer exists.
 */
export function withPermission<T extends PermissionRow>(
  rows: readonly T[],
  scope: PlusOneScope,
  allowed: boolean,
): T[] {
  const gone = allowed
    ? new Set<string>()
    : new Set(plusOnesRemovedBy(rows, scope).map((row) => row.guestId));
  const next: T[] = [];
  for (const row of rows) {
    if (gone.has(row.guestId)) continue;
    // A copy, never the cached row itself: the cache is replaced, not edited.
    next.push(isCoveredBy(row, scope) ? Object.assign({}, row, { plusOneAllowed: allowed }) : row);
  }
  return next;
}

/**
 * A plus-one the organiser was shown and agreed to remove, with the name as
 * the guest list served it. The API deletes only when every plus-one in scope
 * matches one of these exactly, so a household that names, swaps or renames
 * its plus-one meanwhile makes the write refuse rather than reach someone the
 * organiser never saw.
 */
export interface ConfirmedPlusOne {
  guestId: string;
  firstName: string;
  lastName: string;
}

/** What the API said to a permission write. */
export type PermissionAnswer =
  /** Written. `removed` counts the plus-ones deleted with it. */
  | { kind: "saved"; removed: number }
  /** Refused: a plus-one in scope was not among those confirmed — none were
   *  sent, or the household changed its plus-ones since the list was read. */
  | { kind: "named"; named: number }
  /** The session is gone. */
  | { kind: "unauthenticated" }
  /** Any other refusal. */
  | { kind: "refused"; status: number; error: string | null };

/** The fields of the API's answer this reads. Each is type-checked before use:
 *  the body is whatever came back, a proxy's error page included. */
interface PermissionReply {
  plusOneRemoved?: boolean;
  plusOnesRemoved?: number;
  error?: string;
  named?: number;
}

function permissionPath(weddingId: string, scope: PlusOneScope): string {
  const wedding = weddingPath(weddingId);
  return scope.kind === "guest"
    ? `${wedding}/guests/${encodeURIComponent(scope.guestId)}/plus-one`
    : `${wedding}/families/${encodeURIComponent(scope.familyId)}/plus-one`;
}

/**
 * Set the permission for `scope`.
 *
 * `remove` lists the plus-ones that turning it off may delete: the ones the
 * organiser was shown and said yes to, as the confirmation captured them. Never
 * a list read again at the moment of sending — that would echo whatever is
 * current and defeat the API's check. The delete sits outside the change
 * history and cannot be undone. `null` confirms nobody.
 */
export async function putPlusOnePermission(
  authFetch: AuthFetch,
  weddingId: string,
  scope: PlusOneScope,
  allowed: boolean,
  remove: readonly ConfirmedPlusOne[] | null,
): Promise<PermissionAnswer> {
  // Only the three fields: the API refuses any key it does not know.
  const removePlusOnes = remove?.map(({ guestId, firstName, lastName }) => ({
    guestId,
    firstName,
    lastName,
  }));
  const res = await authFetch(apiUrl(permissionPath(weddingId, scope)), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(removePlusOnes ? { allowed, removePlusOnes } : { allowed }),
  });
  if (res.status === 401) return { kind: "unauthenticated" };
  const body = (await res.json().catch(() => null)) as PermissionReply | null;
  if (res.ok) {
    const removed =
      scope.kind === "guest"
        ? body?.plusOneRemoved === true
          ? 1
          : 0
        : typeof body?.plusOnesRemoved === "number"
          ? body.plusOnesRemoved
          : 0;
    return { kind: "saved", removed };
  }
  const error = typeof body?.error === "string" ? body.error : null;
  // 409 also answers `plus_one_cannot_invite`, so the code decides, not the
  // status.
  if (res.status === 409 && error === "plus_one_named") {
    return { kind: "named", named: typeof body?.named === "number" ? body.named : 1 };
  }
  return { kind: "refused", status: res.status, error };
}
