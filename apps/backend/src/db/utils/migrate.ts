import { migrate } from "drizzle-orm/node-postgres/migrator";

import { client, db } from "..";

try {
  await migrate(db, { migrationsFolder: "./src/db/drizzle" });
} catch (err) {
  console.log(err);
} finally {
  client.end();
}
