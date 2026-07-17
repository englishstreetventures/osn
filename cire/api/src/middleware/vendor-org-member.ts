import { Elysia } from "elysia";

import type { OsnOrgMembershipResolver } from "../services/osn-bridge";

interface GateError {
  status: number;
  body: { error: string };
}

const fail = (status: number, error: string) => ({
  orgRole: undefined as "admin" | "member" | undefined,
  orgGateError: { status, body: { error } } as GateError | undefined,
});

const pass = (role: "admin" | "member") => ({
  orgRole: role as "admin" | "member" | undefined,
  orgGateError: undefined as GateError | undefined,
});

/**
 * Authz gate for /api/vendor/orgs/:orgId/* — confirms the authenticated caller
 * (identified by osnProfileId set by upstream osnAuth()) is a member of the
 * org. Calls the org membership resolver (osn-bridge's `OsnOrgMembershipResolver`
 * or a test stub). A `null` result — whether the profile is genuinely not a
 * member OR osn-api is unreachable — maps to 403 `not_org_member` (fail-closed
 * on writes; a transient osn outage blocks listing changes but never leaks
 * another org's data). Attaches `orgRole` to context on success.
 */
export function vendorOrgMember(orgId: string, orgMembership: OsnOrgMembershipResolver) {
  return new Elysia()
    .derive({ as: "scoped" }, async (ctx) => {
      const { osnProfileId } = ctx as unknown as { osnProfileId?: string };

      if (!osnProfileId) return fail(401, "unauthorised");

      const role = await orgMembership(orgId, osnProfileId);
      if (!role) return fail(403, "not_org_member");

      return pass(role);
    })
    .onBeforeHandle({ as: "scoped" }, ({ orgGateError, set }) => {
      if (orgGateError) {
        set.status = orgGateError.status;
        return orgGateError.body;
      }
    });
}
