/**
 * The portal's role vocabulary, and the only place it decides anything from a
 * role.
 *
 * It mirrors `WeddingRole` in `cire/api/src/middleware/wedding-role.ts`: the
 * wedding's owner, plus the roles a `wedding_hosts` seat may hold. The API is
 * the enforcement — every gate re-checks — so what is decided here is only what
 * the portal OFFERS. An affordance offered to someone the API refuses is a
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

/** A role a co-host seat can hold. The owner created the wedding and is never
 *  rowed into `wedding_hosts`, so no control can assign it. */
export type AssignableRole = Exclude<WeddingRole, "owner">;

/**
 * The roles the seat dropdown offers. Exhaustive over {@link AssignableRole} by
 * type: a role added to the vocabulary widens that union, and this map stops
 * compiling until the dropdown has been told whether to offer it.
 */
const ASSIGNABLE = {
  editor: true,
  viewer: true,
  helper: true,
} satisfies Record<AssignableRole, true>;

/** Dropdown order, most privilege first — the order the explainers above the
 *  handle input read in. */
export const ASSIGNABLE_ROLES: readonly AssignableRole[] = (
  Object.keys(ASSIGNABLE) as AssignableRole[]
).toSorted((a, b) => ROLE_RANK[b] - ROLE_RANK[a]);

/** What an unrecognised role degrades to: the narrowest there is, derived from
 *  the rank map rather than written out. */
export const LEAST_PRIVILEGE_ROLE: WeddingRole = (Object.keys(ROLE_RANK) as WeddingRole[]).reduce(
  (lowest, role) => (ROLE_RANK[role] < ROLE_RANK[lowest] ? role : lowest),
);

/** The same floor, among the roles a seat can hold. Separate from
 *  {@link LEAST_PRIVILEGE_ROLE} only because that one is typed to include the
 *  owner, who is not a seat. */
export const LEAST_PRIVILEGE_SEAT_ROLE: AssignableRole = ASSIGNABLE_ROLES.reduce((lowest, role) =>
  ROLE_RANK[role] < ROLE_RANK[lowest] ? role : lowest,
);

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

/**
 * A role read off a co-host seat, narrowed to what a seat can actually hold.
 *
 * The co-host list is seats only — the API rows the wedding's owner separately
 * — so `owner` is not a value this can honestly return. Exhaustive over
 * {@link WeddingRole}, so a role added later has to be put on one side of that
 * line rather than falling through as a seat by default.
 */
export function asSeatRole(role: string): AssignableRole {
  const known = normaliseWeddingRole(role);
  switch (known) {
    case "editor":
      return "editor";
    case "viewer":
      return "viewer";
    case "helper":
      return "helper";
    case "owner":
      // Never a seat. A row claiming to be one is shown as the narrowest seat
      // rather than as an owner the panel would then offer to demote.
      return LEAST_PRIVILEGE_SEAT_ROLE;
  }
  const _exhaustive: never = known;
  return LEAST_PRIVILEGE_SEAT_ROLE;
}

/** The surfaces the portal offers a role — one field per API gate. */
export interface RoleSurfaces {
  /** The wedding dashboard and everything it reads — `weddingMember()`. */
  canOpenDashboard: boolean;
  /** The module write surfaces, and seating another co-host — `weddingEditor()`. */
  canEdit: boolean;
  /** Claim codes, the wedding's own settings, and changing or removing a seat —
   *  `weddingOwner()`. */
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
      "Created this wedding. The only one who can change who helps, rotate claim codes, or delete it.",
    badgeTitle: "You created this wedding and manage who helps with it",
  },
  editor: {
    label: "Editor",
    summary: "Can change guests, events and the invite, and bring in more co-hosts.",
    badgeTitle: "You can view and edit this wedding",
  },
  viewer: {
    label: "Viewer",
    summary: "Can see the whole dashboard and change nothing.",
    badgeTitle: "You can view this wedding — ask the owner for editor access to make changes",
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
 * `editor` is the highest a seat can hold — every module write, plus the right
 * to seat more co-hosts — and it is the one grant worth a second look.
 */
const CONFIRM_ON_GRANT = {
  editor: true,
  viewer: false,
  helper: false,
} satisfies Record<AssignableRole, boolean>;

/** Does moving a seat from `from` to `to` need confirming? Only a promotion
 *  does: a demotion takes away nothing the owner cannot hand straight back. */
export function needsPromotionConfirmation(from: WeddingRole, to: AssignableRole): boolean {
  return CONFIRM_ON_GRANT[to] && ROLE_RANK[to] > ROLE_RANK[from];
}
