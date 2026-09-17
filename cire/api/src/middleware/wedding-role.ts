import type { HostRole, RunSheetScope } from "../services/hosts";

/** The caller's effective role on a wedding: its owner, or the app-layer role
 *  of their `wedding_hosts` seat. */
export type WeddingRole = "owner" | HostRole;

/**
 * What a gate asks about — one name per gate, not per route. `member` is the
 * read surface (`weddingMember()`), `editor` the module writes
 * (`weddingEditor()`), `runSheet` the day-of run sheet (`weddingRunSheet()`).
 * The owner-only surface has no capability: `weddingOwner()` compares ids and
 * never consults a role.
 */
export type WeddingCapability = "member" | "editor" | "runSheet";

type RolePolicy = {
  capabilities: readonly WeddingCapability[];
  /**
   * The error string a refusal of THIS role produces, at whichever gate
   * refuses it. `read_only_role` is a viewer's alone — the portal turns it into
   * "ask the owner for editor access", which is only true of someone who can
   * already see the wedding. Every other refusal is the same `forbidden` a
   * stranger gets and so discloses nothing about why.
   */
  refusal: "forbidden" | "read_only_role";
};

const DENY_ALL: RolePolicy = { capabilities: [], refusal: "forbidden" };

/**
 * The authorisation table, and the only place a role's reach is decided.
 *
 * The switch is exhaustive over {@link WeddingRole} and has no `default`, so a
 * role added to `wedding_hosts.role` widens `HostRole`, widens this union, and
 * fails the type check here until it has been given a policy. That is the
 * point: the previous shape — gates each excluding the roles they knew about —
 * admitted a new role everywhere by default, silently and with nothing red.
 *
 * A stored value outside the enum cannot reach this (`normaliseHostRole`
 * degrades it first), but if one ever did, the tail returns {@link DENY_ALL}
 * rather than throwing: a corrupted row must be a refusal, not a 500.
 */
export function policyFor(role: WeddingRole): RolePolicy {
  switch (role) {
    case "owner":
    case "editor":
      return { capabilities: ["member", "editor", "runSheet"], refusal: "forbidden" };
    case "viewer":
      return { capabilities: ["member", "runSheet"], refusal: "read_only_role" };
    case "helper":
      // The run sheet and nothing else. A helper is someone handed a job on the
      // day, not a co-organiser: the member capability would carry the guest
      // list, the budget, the registry, the vendors and the RSVPs with it.
      // Their refusal is the same `forbidden` a stranger gets, so a probe
      // cannot tell a helper's seat from no seat at all.
      return { capabilities: ["runSheet"], refusal: "forbidden" };
  }
  const _exhaustive: never = role;
  return DENY_ALL;
}

/**
 * The scope a caller actually gets, which is not always the one stored on their
 * seat. The column is a helper's setting and no other role's: an owner, an
 * editor and a viewer already read the whole dashboard, so narrowing their run
 * sheet would hide something they can reach by another route — a filter that
 * protects nothing but loses information.
 *
 * Exhaustive over {@link WeddingRole} for the same reason {@link policyFor} is:
 * a role added to the column must be given an answer here before this compiles,
 * and the tail returns the narrow one so a corrupted value cannot widen.
 */
export function runSheetScopeFor(role: WeddingRole, stored: RunSheetScope): RunSheetScope {
  switch (role) {
    case "owner":
    case "editor":
    case "viewer":
      return "full";
    case "helper":
      return stored;
  }
  const _exhaustive: never = role;
  return "own";
}

/** The least a run-sheet row must carry for {@link runSheetVisibleTo} to judge
 *  it: which seat it is assigned to, or `null` for an unassigned one. */
export type RunSheetAssignable = { assignedHostId: string | null };

/**
 * Narrow a run sheet to what `scope` entitles this caller to see.
 *
 * This is the enforcement, and it belongs on the server: a helper scoped `own`
 * who receives the whole run sheet and is shown a filtered view of it has been
 * given the whole run sheet. An unassigned row is nobody's, so `own` does not
 * include it.
 */
export function runSheetVisibleTo<T extends RunSheetAssignable>(
  scope: RunSheetScope,
  callerHostId: string | undefined,
  items: readonly T[],
): T[] {
  if (scope === "full") return [...items];
  if (!callerHostId) return [];
  return items.filter((item) => item.assignedHostId === callerHostId);
}

export type CapabilityDecision =
  | { allowed: true }
  | { allowed: false; error: "forbidden" | "read_only_role" };

/** May `role` exercise `capability`, and if not, what does the caller see? */
export function decideCapability(
  role: WeddingRole,
  capability: WeddingCapability,
): CapabilityDecision {
  const policy = policyFor(role);
  if (policy.capabilities.includes(capability)) return { allowed: true };
  return { allowed: false, error: policy.refusal };
}
