import { pgTable, unique, serial, text, timestamp } from "drizzle-orm/pg-core"

import { sql } from "drizzle-orm"


export const users = pgTable("users", {
	id: serial("id").primaryKey().notNull(),
	email: text("email").notNull(),
	firstName: text("firstName").default('placeholder').notNull(),
	createdAt: timestamp("created_at", { mode: 'string' }).defaultNow().notNull(),
},
(table) => {
	return {
		usersIdUnique: unique("users_id_unique").on(table.id),
		usersEmailKey: unique("users_email_key").on(table.email),
	}
});