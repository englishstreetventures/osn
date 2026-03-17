import { Elysia } from "elysia";
import { cors } from "@elysiajs/cors";
import { createAuthRoutes } from "@osn/core";
import { DbLive } from "@osn/db/service";

const port = Number(process.env.PORT) || 4000;

const authConfig = {
  rpId: process.env.OSN_RP_ID || "localhost",
  rpName: process.env.OSN_RP_NAME || "OSN",
  origin: process.env.OSN_ORIGIN || "http://localhost:5173",
  issuerUrl: process.env.OSN_ISSUER_URL || `http://localhost:${port}`,
  jwtSecret: process.env.OSN_JWT_SECRET || "dev-secret-change-in-prod",
  accessTokenTtl: Number(process.env.OSN_ACCESS_TOKEN_TTL) || 3600,
  refreshTokenTtl: Number(process.env.OSN_REFRESH_TOKEN_TTL) || 2592000,
};

const app = new Elysia()
  .use(cors())
  .get("/", () => ({ status: "ok", service: "osn-auth" }))
  .get("/health", () => ({ status: "healthy" }))
  .use(createAuthRoutes(authConfig, DbLive));

if (process.env.NODE_ENV !== "test") {
  app.listen(port);
  console.log(`OSN auth server running at http://localhost:${port}`);
}

export { app };
export type App = typeof app;
