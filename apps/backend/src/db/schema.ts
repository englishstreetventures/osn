import { serial, text, timestamp, pgTable, unique } from "drizzle-orm/pg-core";

export const table_users = pgTable("users", {
	id: serial("id").primaryKey().notNull().unique(),
	email: text("email").notNull().unique(),
	firstName: text("firstName").default('placeholder').notNull(),
	createdAt: timestamp("created_at", { mode: 'string' }).defaultNow().notNull(),
},
(table) => {
	return {
		usersIdUnique: unique("users_id_unique").on(table.id),
		usersEmailKey: unique("users_email_key").on(table.email),
	}
});
