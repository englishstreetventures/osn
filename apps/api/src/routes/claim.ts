import { Hono } from "hono";
import { Effect, Schema } from "effect";
import { claimService } from "../services/claim";
import { ClaimBody } from "../schemas/claim";
import { DbService } from "../db";
import type { Db } from "../db";

type AppVariables = { db: Db };

export const claimRoute = new Hono<{ Variables: AppVariables }>();

claimRoute.post("/", async (c) => {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    raw = null;
  }

  return Effect.runPromise(
    Effect.gen(function* () {
      const { publicId, password } = yield* Schema.decodeUnknown(ClaimBody)(raw);
      const result = yield* claimService.lookup(publicId.trim().toUpperCase(), password.trim());
      return c.json(result);
    }).pipe(
      Effect.provideService(DbService, c.var.db),
      Effect.catchTag("ParseError", () =>
        Effect.succeed(c.json({ error: "Missing or invalid fields" }, 400)),
      ),
      Effect.catchTag("InvalidCredentials", () =>
        Effect.succeed(c.json({ error: "Invalid credentials" }, 401)),
      ),
      Effect.catchTag("HashFailure", () => Effect.succeed(c.json({ error: "Server error" }, 500))),
    ),
  );
});
