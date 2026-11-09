/**
 * The second half of `db:push`: adds the triggers in `./triggers` to the local
 * SQLite file `drizzle-kit push` has just built. drizzle-kit builds tables and
 * indexes from the schema and cannot declare a trigger, so without this the
 * local stack would take writes every deployed and test database refuses.
 *
 * drizzle-kit leaves a trigger it does not know in place, and each trigger is
 * created only if absent, so pushing again keeps them and this runs again
 * safely. A failure throws and fails `db:push`.
 */
import { Database } from "bun:sqlite";

import { localDbUrl } from "../drizzle.config";
import { TRIGGERS } from "./triggers";

const db = new Database(localDbUrl, { create: false, readwrite: true });
try {
  db.transaction(() => {
    for (const statement of TRIGGERS) db.run(statement);
  })();
} finally {
  db.close();
}
