/**
 * The portal's role vocabulary, and the only place it decides anything from a
 * role.
 *
 * It mirrors `WeddingRole` in `cire/api/src/middleware/wedding-role.ts`: the
 * roles a `wedding_hosts` seat may hold, `owner` among them — a wedding's owners
 * are seats like everyone else, and every owner is equal. The API is the
 * enforcement — every gate re-checks — so what is decided here is only what the
 * portal OFFERS. An affordance offered to someone the API refuses is a
 * control that 403s, which is the defect this module exists to remove.
 *
 * Two rules hold it together.
 *
 * **Every decision is a switch over the whole vocabulary, with no `default`.**
 * Adding a role fails the type check here until each decision has an answer for
 * it. The shape this replaced was a negative check — `role !== "viewer"` meant
 * "may edit" — which hands every role added later whatever the roles it was
 * written against could do. It was also fail-open in the other direction: a
 * role the portal did not recognise is not `viewer` either, so it was offered
 * every write surface.
 *
 * **An unrecognised role degrades to the least privileged one**, read off the
 * rank map rather than named, so a role added below the current floor moves the
 * floor instead of leaving a literal that grants more than the newest role
 * gets. Roles arrive as JSON, so this is where a string becomes a member of the
 * vocabulary.
 *
 * `@cire/host` depends on neither `@cire/api` nor `@cire/db`, so the exhaustive
 * switches below cannot see a role added to `wedding_hosts.role`.
 * `tests/lib/wedding-roles.contract.test.ts` pins this list to that column.
 */

/** Each role's privilege rank, lowest first. */
const ROLE_RANK = {
  helper: 0,
  viewer: 1,
  editor: 2,
  owner: 3,
} as const;

/** The role the signed-in organiser holds on one wedding. */
export type WeddingRole = keyof typeof ROLE_RANK;

/** A role a seat can be given. Every role is one — `owner` included, which is
 *  how a second owner joins a wedding — but who may give which is
 *  {@link assignableRolesFor}'s to say. */
export type AssignableRole = WeddingRole;

/**
 * The roles a seat can be given. Exhaustive over {@link AssignableRole} by
 * type: a role added to the vocabulary widens that union, and this map stops
 * compiling until the portal has been told whether a seat can hold it.
 */
const ASSIGNABLE = {
  owner: true,
  editor: true,
  viewer: true,
  helper: true,
} satisfies Record<AssignableRole, true>;

/** Every role a seat can be given, most privilege first — the order the
 *  dropdown and the explainers above the handle input read in. */
export const ASSIGNABLE_ROLES: readonly AssignableRole[] = (
  Object.keys(ASSIGNABLE) as AssignableRole[]
).toSorted((a, b) => ROLE_RANK[b] - ROLE_RANK[a]);

/** What an unrecognised role degrades to: the narrowest there is, derived from
 *  the rank map rather than written out. */
export const LEAST_PRIVILEGE_ROLE: WeddingRole = (Object.keys(ROLE_RANK) as WeddingRole[]).reduce(
  (lowest, role) => (ROLE_RANK[role] < ROLE_RANK[lowest] ? role : lowest),
);

/**
 * The roles someone holding `role` may give a seat — on someone they add, and
 * through a role change. Mirrors `assignableRolesFor()` in
 * `cire/api/src/middleware/wedding-role.ts`, which the API enforces.
 *
 * Only an owner may grant `owner`: an owner can remove every other seat, so an
 * editor who could make one could make themselves unremovable. An editor's
 * ceiling is their own role. Exhaustive over {@link WeddingRole} with no
 * `default`; the tail grants nothing.
 */
export function assignableRolesFor(role: WeddingRole): readonly AssignableRole[] {
  switch (role) {
    case "owner":
      return ASSIGNABLE_ROLES;
    case "editor":
      return ASSIGNABLE_ROLES.filter((option) => ROLE_RANK[option] <= ROLE_RANK.editor);
    case "viewer":
    case "helper":
      return [];
  }
  const _exhaustive: never = role;
  return [];
}

/**
 * The role a co-host seat is created at.
 *
 * Someone is added able to read the wedding and change nothing, and is raised
 * afterwards by its owner. Adding and granting are then two separate acts, and
 * the one that hands over write access is the one that gets asked about — which
 * is not true when the role is chosen in the same gesture as the handle.
 */
export const NEW_SEAT_ROLE: AssignableRole = "viewer";

/**
 * Map a role string from the API onto the vocabulary, degrading anything the
 * portal does not know to {@link LEAST_PRIVILEGE_ROLE}.
 *
 * `Object.hasOwn`, never `key in map`: `in` walks the prototype chain, so
 * `constructor` and `toString` would pass and be asserted as real roles.
 */
export function normaliseWeddingRole(role: string): WeddingRole {
  if (!Object.hasOwn(ROLE_RANK, role)) return LEAST_PRIVILEGE_ROLE;
  switch (role as WeddingRole) {
    case "owner":
      return "owner";
    case "editor":
      return "editor";
    case "viewer":
      return "viewer";
    case "helper":
      return "helper";
  }
  return LEAST_PRIVILEGE_ROLE;
}

/** The surfaces the portal offers a role — one field per API gate. */
export interface RoleSurfaces {
  /** The wedding dashboard and everything it reads — `weddingMember()`. */
  canOpenDashboard: boolean;
  /** The module write surfaces, and seating another co-host — `weddingEditor()`. */
  canEdit: boolean;
  /** Claim codes, the wedding's own settings, billing, and changing or removing
   *  a seat, an owner's included — `weddingOwner()`. Every owner has it. */
  canManage: boolean;
}

const NO_SURFACES: RoleSurfaces = {
  canOpenDashboard: false,
  canEdit: false,
  canManage: false,
};

/**
 * What `role` is offered in the portal.
 *
 * Exhaustive over {@link WeddingRole} with no `default`; the tail returns
 * {@link NO_SURFACES}, so a value that reached here without passing
 * {@link normaliseWeddingRole} is offered nothing rather than everything.
 */
export function surfacesFor(role: WeddingRole): RoleSurfaces {
  switch (role) {
    case "owner":
      return { canOpenDashboard: true, canEdit: true, canManage: true };
    case "editor":
      return { canOpenDashboard: true, canEdit: true, canManage: false };
    case "viewer":
      return { canOpenDashboard: true, canEdit: false, canManage: false };
    case "helper":
      // The day-of run sheet and nothing else. Every dashboard read is refused
      // for a helper, so opening it would be a screen of errors.
      return { ...NO_SURFACES };
  }
  const _exhaustive: never = role;
  return NO_SURFACES;
}

/** How the portal words a role. */
export interface RoleCopy {
  /** The label on a badge, a dropdown option or an explainer. */
  label: string;
  /** What the role carries, said ABOUT someone — the explainers beside the
   *  handle input, and the dropdown that sets another person's seat. */
  summary: string;
  /** The same fact said TO the person holding it, for the chip in the top bar.
   *  Two strings rather than one: the chip is worn and the explainer is read
   *  about a third party, and one sentence cannot be both without reading like
   *  a translation. */
  badgeTitle: string;
}

/**
 * The one place a stored role becomes a word on screen.
 *
 * The label is the portal's to choose and the stored value is the API's, so
 * keeping the mapping here is what stops the two drifting across a badge, a
 * dropdown, a toast and an explainer.
 */
export const ROLE_COPY = {
  owner: {
    label: "Owner",
    summary:
      "Runs the wedding, as an equal of any other owner: who helps, claim codes, settings and billing, and deleting it.",
    badgeTitle: "You own this wedding and manage who helps with it",
  },
  editor: {
    label: "Editor",
    summary: "Can change guests, events and the invite, and bring in more co-hosts.",
    badgeTitle: "You can view and edit this wedding",
  },
  viewer: {
    label: "Viewer",
    summary: "Can see the whole dashboard and change nothing.",
    badgeTitle: "You can view this wedding — ask an owner for editor access to make changes",
  },
  helper: {
    label: "Helper",
    summary: "Sees the run sheet for the day — not the guest list, the budget or the replies.",
    badgeTitle: "You have the run sheet for the day; the rest of this wedding isn't yours to open",
  },
} satisfies Record<WeddingRole, RoleCopy>;

/**
 * Roles the portal stops to confirm before granting. Exhaustive over
 * {@link AssignableRole}, so a role added later has to be answered for here
 * before this compiles.
 *
 * `owner` hands over the wedding itself — billing, the payout account, and the
 * power to remove every other seat, the granter's own included — and `editor`
 * every module write plus the right to seat more co-hosts. Both are worth a
 * second look.
 */
const CONFIRM_ON_GRANT = {
  owner: true,
  editor: true,
  viewer: false,
  helper: false,
} satisfies Record<AssignableRole, boolean>;

/** Does moving a seat from `from` to `to` need confirming? Only a promotion
 *  does: a demotion takes away nothing an owner cannot hand straight back. */
export function needsPromotionConfirmation(from: WeddingRole, to: AssignableRole): boolean {
  return CONFIRM_ON_GRANT[to] && ROLE_RANK[to] > ROLE_RANK[from];
}

/**
 * Does a role change need confirming, given whose seat it is? An owner moving
 * their OWN seat is stepping down: they give up the owner surface and need
 * another owner to hand it back, so any change to their own seat is asked
 * about. Anyone else's seat confirms on a promotion only.
 */
export function needsRoleChangeConfirmation(
  from: WeddingRole,
  to: AssignableRole,
  ownSeat: boolean,
): boolean {
  if (from === to) return false;
  return ownSeat || needsPromotionConfirmation(from, to);
}
