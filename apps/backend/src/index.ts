import { Elysia } from "elysia";

import { auth } from "#routes";

try {
  const app = new Elysia()
    .get('/', () => 'hello')
    .use(auth.routes)
    .listen(Bun.env.PORT);  
  console.log(`🦊 Elysia is running at ${app.server?.hostname}:${app.server?.port}`);
} catch (err) {
  console.log("ERR: ", err);
}
