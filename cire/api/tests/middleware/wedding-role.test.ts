import { describe, expect, it } from "bun:test";

import { decideCapability, policyFor } from "../../src/middleware/wedding-role";
import type { WeddingCapability, WeddingRole } from "../../src/middleware/wedding-role";

// The authorisation table itself, asserted role by role and capability by
// capability rather than through the gates. A gate test proves one mount site
// behaves; this proves the policy every gate reads, so a role added without a
// deliberate decision shows up here as a failure rather than as silence.

const ROLES: readonly WeddingRole[] = ["owner", "editor", "viewer", "helper"];
const CAPABILITIES: readonly WeddingCapability[] = ["member", "editor", "runSheet"];

/** Every (role, capability) pair, as `allowed` booleans. Written out in full on
 *  purpose — a table that derives its expectations from the code under test
 *  would agree with any change to it. */
const EXPECTED: Record<WeddingRole, Record<WeddingCapability, boolean>> = {
  owner: { member: true, editor: true, runSheet: true },
  editor: { member: true, editor: true, runSheet: true },
  viewer: { member: true, editor: false, runSheet: true },
  // The whole point of the role: the run sheet, and nothing else. `member`
  // being false here is what keeps a helper out of the guest list, the budget,
  // the registry, the vendors and the RSVPs.
  helper: { member: false, editor: false, runSheet: true },
};

describe("policyFor", () => {
  for (const role of ROLES) {
    for (const capability of CAPABILITIES) {
      const expected = EXPECTED[role][capability];
      it(`${expected ? "grants" : "refuses"} ${capability} to ${role}`, () => {
        expect(decideCapability(role, capability).allowed).toBe(expected);
      });
    }
  }

  it("covers every role in the table — no role is left unasserted", () => {
    expect(Object.keys(EXPECTED).toSorted()).toEqual([...ROLES].toSorted());
  });
});

describe("refusal strings", () => {
  it("gives a viewer read_only_role, the string the portal turns into an upgrade prompt", () => {
    const decision = decideCapability("viewer", "editor");
    expect(decision).toEqual({ allowed: false, error: "read_only_role" });
  });

  it("reserves read_only_role for the viewer alone", () => {
    // Every other role's refusal must be indistinguishable from a stranger's,
    // so a refusal never discloses that the caller holds a seat at all.
    const leaky = ROLES.filter((role) => role !== "viewer").filter((role) =>
      CAPABILITIES.some((capability) => {
        const decision = decideCapability(role, capability);
        return !decision.allowed && decision.error === "read_only_role";
      }),
    );
    expect(leaky).toEqual([]);
  });

  it("never carries an error on an allowed decision", () => {
    for (const role of ROLES) {
      for (const capability of CAPABILITIES) {
        const decision = decideCapability(role, capability);
        if (decision.allowed) expect(decision).toEqual({ allowed: true });
      }
    }
  });
});

describe("policy shape", () => {
  it("names a refusal string for every role, including the fully-privileged ones", () => {
    // `refusal` is read only when a capability is missing, but an owner or
    // editor gaining a capability they lack later must not read `undefined`.
    for (const role of ROLES) {
      expect(["forbidden", "read_only_role"]).toContain(policyFor(role).refusal);
    }
  });

  it("grants the owner every capability there is", () => {
    expect([...policyFor("owner").capabilities].toSorted()).toEqual([...CAPABILITIES].toSorted());
  });
});
