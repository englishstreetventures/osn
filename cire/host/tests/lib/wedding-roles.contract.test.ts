import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { ASSIGNABLE_ROLES, ROLE_COPY, type WeddingRole } from "../../src/lib/wedding-roles";

/**
 * The portal's role list against the column it mirrors.
 *
 * `@cire/host` depends on neither `@cire/api` nor `@cire/db`, so nothing in
 * `src/lib/wedding-roles.ts` can be derived from `wedding_hosts.role` the way
 * the API derives its own vocabulary. Its exhaustive switches therefore prove
 * only that the portal agrees with itself: a role added to the column compiles
 * the portal unchanged, and every seat holding it renders as the floor.
 *
 * This reads the column and fails when that happens. The same shape as
 * `headers.test.ts`, which reads `public/_headers` — a text pin is the only
 * link available across a package boundary that carries no dependency.
 */
describe("the role vocabulary matches wedding_hosts.role", () => {
  const schemaPath = fileURLToPath(new URL("../../../db/src/schema.ts", import.meta.url));
  const schema = readFileSync(schemaPath, "utf8");

  /** The column's declared values, read off the Drizzle definition. */
  const stored = (): string[] => {
    const declaration = schema.match(/role: text\("role", \{ enum: \[([^\]]+)\] \}\)/)?.[1];
    // A null here means the column was rewritten into a shape this regex no
    // longer sees, which is exactly the drift this file exists to catch — so it
    // fails rather than passing on an empty list.
    expect(declaration, "could not read the role enum from cire/db/src/schema.ts").toBeTruthy();
    return [...(declaration ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
  };

  /**
   * The one stored value the portal deliberately has no word for. It is the
   * column's DDL default and its pre-roles legacy value; `normaliseHostRole` in
   * `cire/api/src/services/hosts.ts` folds it to `editor` before any response
   * carries it, so the portal never sees one.
   */
  const NOT_SENT_TO_THE_PORTAL = new Set(["host"]);

  it("offers every role a seat can be given", () => {
    const expected = stored()
      .filter((role) => !NOT_SENT_TO_THE_PORTAL.has(role))
      .toSorted();
    expect(ASSIGNABLE_ROLES.toSorted()).toEqual(expected);
  });

  it("knows every role the API can put on a wedding, plus the owner", () => {
    const expected = [
      "owner",
      ...stored().filter((role) => !NOT_SENT_TO_THE_PORTAL.has(role)),
    ].toSorted();
    expect((Object.keys(ROLE_COPY) as WeddingRole[]).toSorted()).toEqual(expected);
  });
});
