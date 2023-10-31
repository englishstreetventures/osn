import Elysia from "elysia";

import { createContext } from "#routes/context";

import { getUserProfile, userSignUp } from "./handlers";
import { InsertUser } from "#db/types";

export const routes = new Elysia()
  .state("ctx", createContext())
  .group("/user", routes => routes
    .get("/profile/:id", ({ store: { ctx }, params: { id } }) => getUserProfile(ctx, { id }))
    .post("/sign-up", ({ store: { ctx }, body }) => userSignUp(ctx, body as InsertUser))
    .post("/sign-in", () => "cool beans you're signed in")
    .post("/sign-out", () => "cool beans you're signed out")
  );
