import { describe, expect, it } from "vitest";

import {
  ASSIGNABLE_ROLES,
  assignableRolesFor,
  LEAST_PRIVILEGE_ROLE,
  needsPromotionConfirmation,
  needsRoleChangeConfirmation,
  normaliseWeddingRole,
  ROLE_COPY,
  surfacesFor,
  type WeddingRole,
} from "../../src/lib/wedding-roles";

/**
 * The portal's role vocabulary. What these pin is the property every affordance
 * in the portal rests on: each role is decided about by name, none inherits a
 * surface by not being mentioned, and a role nobody here knows is offered
 * nothing.
 *
 * `ROLES` is derived from `ROLE_COPY`, which is `satisfies Record<WeddingRole,
 * …>`, so a role added to the vocabulary joins this list by itself and every
 * table-driven case below runs against it. A list written out here would keep
 * passing while saying nothing about the new role.
 */
const ROLES = Object.keys(ROLE_COPY) as WeddingRole[];

describe("the vocabulary", () => {
  it("is the four roles the API can send", () => {
    expect(ROLES.toSorted()).toEqual(["editor", "helper", "owner", "viewer"]);
  });

  it("offers every role on a seat, owner included, most privilege first", () => {
    expect(ASSIGNABLE_ROLES).toEqual(["owner", "editor", "viewer", "helper"]);
  });

  it("puts the floor at the narrowest role, and offers it nothing", () => {
    expect(LEAST_PRIVILEGE_ROLE).toBe("helper");
    expect(surfacesFor(LEAST_PRIVILEGE_ROLE)).toEqual({
      canOpenDashboard: false,
      canEdit: false,
      canManage: false,
    });
  });

  it("gives every role a label, a summary and a badge title", () => {
    const missing = ROLES.filter((role) => {
      const copy = ROLE_COPY[role];
      return !copy.label || !copy.summary || !copy.badgeTitle;
    });
    expect(missing).toEqual([]);
  });
});

describe("normaliseWeddingRole", () => {
  it("passes every known role through unchanged", () => {
    for (const role of ROLES) expect(normaliseWeddingRole(role)).toBe(role);
  });

  it("degrades anything else to the least privileged role", () => {
    // `host` is the API's legacy stored value (folded to `editor` server-side,
    // never sent), `admin` a role that does not exist, and the last three are
    // the prototype members a `key in map` guard would have admitted.
    for (const value of ["host", "admin", "", "OWNER", "constructor", "__proto__", "toString"]) {
      expect(normaliseWeddingRole(value)).toBe(LEAST_PRIVILEGE_ROLE);
    }
  });
});

describe("surfacesFor", () => {
  it("gives the owner every surface", () => {
    expect(surfacesFor("owner")).toEqual({
      canOpenDashboard: true,
      canEdit: true,
      canManage: true,
    });
  });

  it("gives an editor the dashboard and the writes, but not management", () => {
    expect(surfacesFor("editor")).toEqual({
      canOpenDashboard: true,
      canEdit: true,
      canManage: false,
    });
  });

  it("gives a viewer the dashboard and nothing that writes", () => {
    expect(surfacesFor("viewer")).toEqual({
      canOpenDashboard: true,
      canEdit: false,
      canManage: false,
    });
  });

  it("gives a helper no dashboard at all", () => {
    expect(surfacesFor("helper")).toEqual({
      canOpenDashboard: false,
      canEdit: false,
      canManage: false,
    });
  });

  it("offers a write surface to exactly the roles the API's editor gate admits", () => {
    // Asserted over the whole vocabulary rather than role by role, so a role
    // added without a decision cannot pass by being absent from a list.
    expect(ROLES.filter((role) => surfacesFor(role).canEdit).toSorted()).toEqual([
      "editor",
      "owner",
    ]);
  });

  it("offers management to the owner alone", () => {
    expect(ROLES.filter((role) => surfacesFor(role).canManage)).toEqual(["owner"]);
  });

  it("never offers a write surface without the dashboard it lives on", () => {
    const stranded = ROLES.filter((role) => {
      const surfaces = surfacesFor(role);
      return (surfaces.canEdit || surfaces.canManage) && !surfaces.canOpenDashboard;
    });
    expect(stranded).toEqual([]);
  });
});

describe("needsPromotionConfirmation", () => {
  it("confirms making someone an owner, from every role below it", () => {
    expect(needsPromotionConfirmation("editor", "owner")).toBe(true);
    expect(needsPromotionConfirmation("viewer", "owner")).toBe(true);
    expect(needsPromotionConfirmation("helper", "owner")).toBe(true);
  });

  it("confirms a promotion to editor from every role below it", () => {
    expect(needsPromotionConfirmation("viewer", "editor")).toBe(true);
    expect(needsPromotionConfirmation("helper", "editor")).toBe(true);
  });

  it("does not confirm a demotion", () => {
    expect(needsPromotionConfirmation("editor", "viewer")).toBe(false);
    expect(needsPromotionConfirmation("editor", "helper")).toBe(false);
    expect(needsPromotionConfirmation("viewer", "helper")).toBe(false);
  });

  it("does not confirm a promotion that hands over no write surface", () => {
    expect(needsPromotionConfirmation("helper", "viewer")).toBe(false);
  });

  it("does not confirm setting a role to the one already held", () => {
    for (const role of ASSIGNABLE_ROLES) {
      expect(needsPromotionConfirmation(role, role)).toBe(false);
    }
  });

  it("confirms every grant that hands over a write surface", () => {
    // The property rather than the list: any assignable role the portal would
    // give an edit surface to has to be confirmed before it is granted.
    const writeGranting = ASSIGNABLE_ROLES.filter((role) => surfacesFor(role).canEdit);
    // Guards the assertion below against passing on an empty list.
    expect(writeGranting.length).toBeGreaterThan(0);
    const unconfirmed = writeGranting.filter(
      (role) => !needsPromotionConfirmation(LEAST_PRIVILEGE_ROLE, role),
    );
    expect(unconfirmed).toEqual([]);
  });
});

describe("assignableRolesFor", () => {
  it("lets an owner grant every role, owner included", () => {
    expect(assignableRolesFor("owner")).toEqual(["owner", "editor", "viewer", "helper"]);
  });

  it("lets an editor, a viewer and a helper grant nothing", () => {
    expect(assignableRolesFor("editor")).toEqual([]);
    expect(assignableRolesFor("viewer")).toEqual([]);
    expect(assignableRolesFor("helper")).toEqual([]);
  });

  it("lets only the roles offered management grant anything", () => {
    const granting = ROLES.filter((role) => assignableRolesFor(role).length > 0);
    const managing = ROLES.filter((role) => surfacesFor(role).canManage);
    expect(granting).toEqual(managing);
  });
});

describe("needsRoleChangeConfirmation", () => {
  it("asks an owner before any change to their own seat — stepping down", () => {
    for (const to of ["editor", "viewer", "helper"] as const) {
      expect(needsRoleChangeConfirmation("owner", to, true)).toBe(true);
    }
  });

  it("does not ask an owner to demote another owner", () => {
    expect(needsRoleChangeConfirmation("owner", "editor", false)).toBe(false);
  });

  it("asks before a promotion, whoever's seat it is", () => {
    expect(needsRoleChangeConfirmation("viewer", "owner", false)).toBe(true);
    expect(needsRoleChangeConfirmation("viewer", "editor", false)).toBe(true);
  });

  it("never asks about a change to the role already held", () => {
    for (const role of ASSIGNABLE_ROLES) {
      expect(needsRoleChangeConfirmation(role, role, true)).toBe(false);
      expect(needsRoleChangeConfirmation(role, role, false)).toBe(false);
    }
  });
});
