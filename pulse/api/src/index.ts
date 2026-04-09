import { Elysia } from "elysia";
import { cors } from "@elysiajs/cors";
import { eventsRoutes, settingsRoutes } from "./routes/events";

const app = new Elysia()
  .use(cors())
  .get("/", () => ({ status: "ok", service: "osn-api" }))
  .get("/health", () => ({ status: "healthy" }))
  .use(eventsRoutes)
  .use(settingsRoutes);

const port = process.env.PORT || 3001;

if (process.env.NODE_ENV !== "test") {
  app.listen(port);
  console.log(`🚀 API server running at http://localhost:${port}`);
}

export { app };
export type App = typeof app;
