import { Hono } from "hono";
import { cors } from "hono/cors";
import { claimRoute } from "./routes/claim";
import { organiserRoute } from "./routes/organiser";
import type { Db } from "./db";

type AppVariables = { db: Db };

export function createApp(db: Db, webOrigin = "http://localhost:4321") {
  const app = new Hono<{ Variables: AppVariables }>();

  // Inject db into every request
  app.use("*", (c, next) => {
    c.set("db", db);
    return next();
  });

  app.use(
    "/api/*",
    cors({
      origin: (origin) => (origin === webOrigin ? origin : null),
      allowMethods: ["GET", "POST", "OPTIONS"],
      allowHeaders: ["Content-Type"],
    }),
  );

  app.route("/api/claim", claimRoute);
  app.route("/api/organiser", organiserRoute);
  app.notFound((c) => c.json({ error: "Not found" }, 404));

  return app;
}
