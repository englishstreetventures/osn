import { DbLive, type Db } from "@osn/db/service";
import { Layer } from "effect";
import { Elysia, t } from "elysia";

import { publishedOutboundKeys } from "../lib/outbound-arc";
import { publicError } from "../lib/public-error";
import { makeAppRunner, type AppRuntime } from "../lib/route-runtime";
import { errorResponse } from "./auth/response-schemas";

/**
 * A JWK Set of osn-api's outbound ARC public keys. `additionalProperties`
 * passes every JWK member through: Elysia deletes undeclared response keys,
 * and a dropped member would leave an app unable to import the key.
 */
const arcJwkSet = t.Object({
  keys: t.Array(
    t.Object(
      {
        kty: t.Optional(t.String()),
        crv: t.Optional(t.String()),
        x: t.Optional(t.String()),
        y: t.Optional(t.String()),
        kid: t.String(),
        alg: t.Literal("ES256"),
        use: t.Literal("sig"),
      },
      { additionalProperties: true },
    ),
  ),
});

/**
 * `GET /.well-known/arc-jwks.json`: the public keys osn-api signs its ARC
 * calls to apps with (`lib/outbound-arc.ts`). Apps resolve an osn-api token's
 * kid here (`@shared/osn-auth-client/arc`). Read fresh on every request, never
 * cached: an isolate writes its key moments before its first call, and the app
 * asks for it on that call.
 */
export function createArcJwksRoutes(
  dbLayer: Layer.Layer<Db> = DbLive,
  loggerLayer: Layer.Layer<never> = Layer.empty,
  runtime?: AppRuntime,
) {
  const { run } = makeAppRunner(runtime, Layer.merge(dbLayer, loggerLayer));
  return new Elysia().get(
    "/.well-known/arc-jwks.json",
    async ({ set }) => {
      set.headers["cache-control"] = "no-store";
      try {
        return { keys: [...(await run(publishedOutboundKeys))] };
      } catch (e) {
        const { status, body } = publicError(e, loggerLayer);
        set.status = status;
        return body;
      }
    },
    {
      response: { 200: arcJwkSet, 500: errorResponse },
      detail: { operationId: "getArcJwks" },
    },
  );
}
