import { Hono } from "hono";
import { Effect, Schema } from "effect";
import { claimService } from "../services/claim";
import { sessionService } from "../services/session";
import { ClaimBody } from "../schemas/claim";
import { buildSessionCookie } from "../lib/cookie";
import { DbService } from "../db";
import type { AppVariables } from "../app";

const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

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
      const { publicId } = yield* Schema.decodeUnknown(ClaimBody)(raw);
      const result = yield* claimService.lookup(publicId.trim().toUpperCase());
      // Session write may fail (DB transient error) — we still hand the user
      // their invite payload and skip Set-Cookie. Error is logged inside the
      // service. They can re-login to mint a fresh session.
      const session: { token: string; expiresAt: Date } | undefined = yield* sessionService
        .create(result.familyId, SESSION_TTL_SECONDS)
        .pipe(Effect.catchTag("SessionWriteError", () => Effect.succeed(undefined)));
      if (session) {
        const webOrigin = c.var.webOrigin;
        c.header(
          "Set-Cookie",
          buildSessionCookie(session.token, {
            secure: webOrigin.startsWith("https://"),
            maxAgeSeconds: SESSION_TTL_SECONDS,
          }),
        );
      }
      return c.json(result);
    }).pipe(
      Effect.provideService(DbService, c.var.db),
      Effect.catchTag("ParseError", () =>
        Effect.succeed(c.json({ error: "Missing or invalid fields" }, 400)),
      ),
      Effect.catchTag("InvalidCredentials", () =>
        Effect.succeed(c.json({ error: "Invalid credentials" }, 401)),
      ),
    ),
  );
});
