import { Elysia } from "elysia";

const app = new Elysia()
  .get("/", () => ({ status: "ok", service: "osn-api" }))
  .get("/health", () => ({ status: "healthy" }));

export { app };
export type App = typeof app;
