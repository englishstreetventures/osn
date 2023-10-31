import { schema } from "#db";
import { createSelectSchema, createInsertSchema } from "drizzle-valibot";
import { Input, string, toTrimmed, email } from "valibot";
import { table_users } from "./schema";

export const selectUserSchema = createSelectSchema(schema.table_users);
export type SelectUser = Input<typeof selectUserSchema>;

export const insertUserSchema = createInsertSchema(table_users, {
	email: string([toTrimmed(), email()]),
});
export type InsertUser = Input<typeof insertUserSchema>;
