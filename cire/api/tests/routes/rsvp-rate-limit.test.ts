import { describe, expect, it } from "bun:test";

import { guests, rsvpChanges } from "@cire/db";
import { events as eventsData } from "@cire/db/seed";
import { createRateLimiter } from "@shared/rate-limit";
import { eq } from "drizzle-orm";

import { createApp } from "../../src/app";
import { createDb, seedDb } from "../../src/db/setup";
import { parseSessionToken } from "../../src/lib/cookie";
import { appRequest } from "../test-helpers";

// `POST /api/rsvp` sits behind the household cookie and a per-IP limiter, like
// the other guest writes. Each submit can write a row per changed reply to the
// change log, so the limiter is what bounds how fast one household code can
// spend the account's daily D1 write budget.

const ORIGIN = "http://localhost:4321";

async function setup(rsvpLimit: number) {
  const db = createDb(":memory:");
  seedDb(db);
  const app = createApp(db, {
    claimLimiter: createRateLimiter({ maxRequests: 10_000, windowMs: 60_000 }),
    rsvpLimiter: createRateLimiter({ maxRequests: rsvpLimit, windowMs: 60_000 }),
  });
  const claim = await appRequest(app, "/api/claim", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: ORIGIN },
    body: JSON.stringify({ publicId: "TESTONE-IVY-AA11" }),
  });
  const cookie = `cire_session=${parseSessionToken(claim.headers.get("Set-Cookie"))}`;
  const ada = db
    .select({ id: guests.id })
    .from(guests)
    .where(eq(guests.firstName, "Ada"))
    .all()[0]!;
  return { db, app, cookie, ada: ada.id };
}

const submit = (
  app: ReturnType<typeof createApp>,
  cookie: string,
  guestId: string,
  status: string,
  headers: Record<string, string> = {},
) =>
  appRequest(app, "/api/rsvp", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: cookie, ...headers },
    body: JSON.stringify({
      rsvps: [
        {
          guestId,
          eventId: eventsData.hindu.id,
          status,
          dietary: "",
          dietaryPresets: [],
          dietaryConsent: false,
        },
      ],
    }),
  });

describe("POST /api/rsvp rate limit", () => {
  it("429s past the per-IP budget and writes nothing for the refused submit", async () => {
    const { db, app, cookie, ada } = await setup(2);
    expect((await submit(app, cookie, ada, "attending")).status).toBe(200);
    expect((await submit(app, cookie, ada, "declined")).status).toBe(200);
    const refused = await submit(app, cookie, ada, "attending");
    expect(refused.status).toBe(429);
    expect(refused.headers.get("retry-after")).toBe("60");
    expect(db.select().from(rsvpChanges).all()).toHaveLength(2);
  });

  it("refuses a request with no resolvable client IP", async () => {
    const { app, cookie, ada } = await setup(100);
    const res = await submit(app, cookie, ada, "attending", { "cf-connecting-ip": "" });
    expect(res.status).toBe(429);
  });
});
