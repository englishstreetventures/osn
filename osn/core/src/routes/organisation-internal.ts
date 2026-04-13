import { DbLive, type Db } from "@osn/db/service";
import { Effect, Layer } from "effect";
import { Elysia, t } from "elysia";

import { requireArc } from "../lib/arc-middleware";
import { createOrganisationService } from "../services/organisation";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const AUDIENCE = "osn-core";
const SCOPE_ORG_READ = "org:read";
/** S-M2: defined now so future mutation endpoints use the write scope, not read. */
const _SCOPE_ORG_WRITE = "org:write";
void _SCOPE_ORG_WRITE;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function safeError(e: unknown): string {
  if (e instanceof Error) {
    if ("_tag" in e && (e._tag === "OrgError" || e._tag === "NotFoundError")) {
      return (e as { message: string }).message;
    }
  }
  return "Request failed";
}

// ---------------------------------------------------------------------------
// Internal organisation routes — ARC token protected
// ---------------------------------------------------------------------------

export function createInternalOrganisationRoutes(dbLayer: Layer.Layer<Db> = DbLive) {
  const org = createOrganisationService();

  const run = <A, E>(eff: Effect.Effect<A, E, Db>): Promise<A> =>
    Effect.runPromise(eff.pipe(Effect.provide(dbLayer)) as Effect.Effect<A, never, never>);

  return new Elysia({ prefix: "/organisations/internal" })
    .get(
      "/user-orgs",
      async ({ query, headers, set }) => {
        const caller = await requireArc(
          headers.authorization,
          set,
          dbLayer,
          AUDIENCE,
          SCOPE_ORG_READ,
        );
        if (!caller) return { error: "Unauthorized" };

        try {
          const list = await run(org.listUserOrganisations(query.userId));
          return { organisationIds: list.map((o) => o.id) };
        } catch (e) {
          set.status = 500;
          return { error: safeError(e) };
        }
      },
      {
        query: t.Object({
          userId: t.String({ minLength: 1, maxLength: 50 }),
        }),
      },
    )
    .get(
      "/membership",
      async ({ query, headers, set }) => {
        const caller = await requireArc(
          headers.authorization,
          set,
          dbLayer,
          AUDIENCE,
          SCOPE_ORG_READ,
        );
        if (!caller) return { error: "Unauthorized" };

        try {
          const role = await run(org.getMemberRole(query.orgId, query.userId));
          return { role };
        } catch (e) {
          set.status = 500;
          return { error: safeError(e) };
        }
      },
      {
        query: t.Object({
          orgId: t.String({ minLength: 1, maxLength: 50 }),
          userId: t.String({ minLength: 1, maxLength: 50 }),
        }),
      },
    );
}
