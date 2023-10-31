import { randomInt } from "crypto";
import { eq } from "drizzle-orm";
import { parse } from "valibot";

import { schema } from "#db";
import { insertUserSchema, type InsertUser } from "#db/types";
import { type Context } from "#routes/context";

export const getUserProfile = (ctx: Context, params: {id: string}) => ctx.db.select().from(schema.table_users).where(eq(schema.table_users.id, +params.id));
export const userSignUp = (ctx: Context, body: InsertUser) => ctx.db.insert(schema.table_users).values(
  parse(
    insertUserSchema,
    {
      id: randomInt(100),
      firstName: body.firstName,
      email: body.email
    } satisfies InsertUser
  )
);
