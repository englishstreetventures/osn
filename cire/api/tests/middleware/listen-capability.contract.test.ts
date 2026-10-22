import { describe, expect, it } from "bun:test";

import { ASSIGNABLE_ROLES as PORTAL_ROLES, surfacesFor } from "../../../host/src/lib/wedding-roles";
import type { WeddingRole } from "../../src/middleware/wedding-role";
import { decideCapability, LISTEN_CAPABILITY } from "../../src/middleware/wedding-role";

// The portal's `canListen` against the grant it mirrors.
//
// `@cire/host` depends on nothing in `@cire/api`, so `surfacesFor().canListen`
// is a hand-kept copy of who `GET /realtime/:topic` admits. If the two
// disagreed, a tab the API refuses would keep subscribing and being refused up
// to its attempt limit on every open, each refusal under the daily ceiling
// spending a subscribe; or a seat the API admits would never listen. This holds
// them equal for every role either side knows. The portal's module has no
// imports, so it loads here as it is.

/** Every role the API decides for. Typed, so a role added to the API's
 *  vocabulary fails to compile here until it is listed. */
const API_ROLES = {
  owner: true,
  editor: true,
  viewer: true,
  helper: true,
} as const satisfies Record<WeddingRole, true>;

describe("the portal listens exactly where the API admits a subscribe", () => {
  it("knows the same roles as the API", () => {
    const portal: string[] = [...PORTAL_ROLES];
    expect(portal.toSorted()).toEqual(Object.keys(API_ROLES).toSorted());
  });

  for (const role of Object.keys(API_ROLES) as WeddingRole[]) {
    it(`agrees for ${role}`, () => {
      expect(surfacesFor(role).canListen).toBe(decideCapability(role, LISTEN_CAPABILITY).allowed);
    });
  }
});
