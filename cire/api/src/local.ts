import { BOOTSTRAP_WEDDING_ID, weddings } from "@cire/db";
import { eq } from "drizzle-orm";
import { Effect } from "effect";

import { createApp } from "./app";
import { createDb, seedDb } from "./db/setup";
import { runCireSync } from "./observability";
import { createAssetsStub } from "./services/invite-assets";
import { createR2Stub } from "./services/r2-imports";

const db = createDb(":memory:");
await seedDb(db);

// Dev convenience: the in-memory seed gives the bootstrap wedding the local dev
// default owner (usr_dev_bootstrap_owner — see resolveBootstrapOwnerProfileId),
// so the organiser dashboard lists nothing for a real signed-in account. Re-point
// it at your OSN profile id via env so the wedding shows up. Find yours in osn.db:
// SELECT id FROM users WHERE handle=...  (BOOTSTRAP_OWNER_PROFILE_ID is also
// honoured by the seed itself; this is a post-seed override for the running server.)
const devOwner = process.env.CIRE_DEV_OWNER_PROFILE_ID;
if (devOwner) {
  db.update(weddings)
    .set({ ownerOsnProfileId: devOwner })
    .where(eq(weddings.id, BOOTSTRAP_WEDDING_ID))
    .run();
  runCireSync(
    Effect.logInfo("dev: bootstrap wedding owner repointed", { ownerOsnProfileId: devOwner }),
  );
}

const origins = (process.env.WEB_ORIGIN ?? "http://localhost:4321,http://localhost:4322")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);
const webOrigin = origins[0];
const port = Number(process.env.PORT ?? 8787);

const r2 = createR2Stub();
const assets = createAssetsStub();

const app = createApp(db, {
  webOrigin,
  allowedOrigins: origins,
  r2,
  assets,
  osnJwksUrl: process.env.OSN_JWKS_URL,
  osnAudience: process.env.OSN_AUDIENCE,
});

const server = Bun.serve({ port, fetch: (request: Request) => app.fetch(request) });
runCireSync(Effect.logInfo("cire-api dev server listening", { port: server.port }));
