import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { PERMITTED_OSN_SCOPES, requireOsnArc } from "../../src/lib/arc-middleware";
import { osnArc } from "../helpers/osn-arc";

/**
 * Pulse lets osn-api use four scopes and nothing else, whatever osn-api's key
 * signs: a token for any other scope is refused before Pulse fetches a key.
 * Every route's own refusals are in `tests/routes/internal.test.ts`.
 */

let arc: Awaited<ReturnType<typeof osnArc>>;
beforeEach(async () => {
  arc = await osnArc();
});
afterEach(() => arc.restore());

describe("requireOsnArc", () => {
  it("lets osn-api use exactly the deletion, export and session scopes", () => {
    expect([...PERMITTED_OSN_SCOPES].toSorted()).toEqual([
      "account:deletion-preview",
      "account:erase",
      "account:export",
      "account:sessions-revoke",
    ]);
  });

  it("refuses osn-api's token for a scope Pulse does not let it use", async () => {
    const set: { status?: number } = {};
    expect(
      await requireOsnArc(
        await arc.token("graph:read"),
        set,
        { osnIssuer: arc.verification.issuer, kidSecret: "test-internal-secret" },
        "graph:read",
      ),
    ).toBe(false);
    expect(set.status).toBe(401);
  });

  it("admits osn-api's token for a permitted scope", async () => {
    const set: { status?: number } = {};
    expect(
      await requireOsnArc(
        await arc.token("account:erase"),
        set,
        { osnIssuer: arc.verification.issuer, kidSecret: "test-internal-secret" },
        "account:erase",
      ),
    ).toBe(true);
    expect(set.status).toBeUndefined();
  });
});
