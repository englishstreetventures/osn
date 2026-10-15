import { describe, expect, it } from "bun:test";

import { Elysia } from "elysia";

import { vendorOrgMember } from "../../src/middleware/vendor-org-member";
import type { OsnOrgMembershipResolver } from "../../src/services/osn-bridge";
import { appRequest, jsonBody } from "../test-helpers";

const ORG = "org_probe";

/** Membership resolver that records each lookup: usr_member is a member of ORG. */
function recordingMembership() {
  const lookups: [string, string][] = [];
  const resolve: OsnOrgMembershipResolver = async (orgId, profileId) => {
    lookups.push([orgId, profileId]);
    return orgId === ORG && profileId === "usr_member" ? "member" : null;
  };
  return { resolve, lookups };
}

/** Stands in for the upstream osnAuth() plugin by resolving a fixed profile. */
function buildApp(membership: OsnOrgMembershipResolver, profileId?: string) {
  return new Elysia({ aot: false })
    .resolve(() => ({ osnProfileId: profileId }))
    .use(vendorOrgMember(ORG, membership))
    .get("/probe", ({ orgRole }) => ({ orgRole: orgRole ?? null }));
}

describe("vendorOrgMember", () => {
  it("admits a member of the org and names their role", async () => {
    const { resolve, lookups } = recordingMembership();
    const res = await appRequest(buildApp(resolve, "usr_member"), "/probe");
    expect(res.status).toBe(200);
    expect(await jsonBody(res)).toEqual({ orgRole: "member" });
    expect(lookups).toEqual([[ORG, "usr_member"]]);
  });

  it("refuses 403 not_org_member when the resolver finds no membership", async () => {
    const { resolve } = recordingMembership();
    const res = await appRequest(buildApp(resolve, "usr_stranger"), "/probe");
    expect(res.status).toBe(403);
    expect(await jsonBody(res)).toEqual({ error: "not_org_member" });
  });

  it("refuses 401 with no profile, without asking the resolver", async () => {
    const { resolve, lookups } = recordingMembership();
    const res = await appRequest(buildApp(resolve), "/probe");
    expect(res.status).toBe(401);
    expect(await jsonBody(res)).toEqual({ error: "unauthorised" });
    expect(lookups).toEqual([]);
  });
});
