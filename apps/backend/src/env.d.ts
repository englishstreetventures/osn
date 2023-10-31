import { number, object, string, Input } from "valibot";

const EnvSchema = object({
  PORT: number(),
  DB_URL: string(),
});

declare module "bun" {
  interface Env extends Input<typeof EnvSchema> {}
}

declare global {
  namespace NodeJS {
    interface ProcessEnv extends Input<typeof EnvSchema> {}
  }
}
