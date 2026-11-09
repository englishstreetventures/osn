/**
 * The triggers on the OSN identity database, as the migrations create them.
 *
 * Drizzle cannot declare a trigger, so this list copies them for every
 * database built from the schema rather than from the migrations: each test
 * database (`./testing`) and the local file `db:push` builds
 * (`./push-triggers`). `tests/ddl-lockstep.test.ts` holds this list to the
 * migration chain. It compares SQL without case, so the exact spelling of each
 * value list is held by `osn/api/tests/d1/organisation-member-role.test.ts`,
 * which runs the migration itself.
 *
 * Each trigger is created only if absent, so every statement runs again
 * safely. Kept out of `./schema` so the Worker, which imports `./schema` and
 * `./service`, does not bundle it.
 */
export const TRIGGERS: readonly string[] = Object.freeze([
  // An organisation member's role is 'admin' or 'member'.
  `CREATE TRIGGER IF NOT EXISTS \`organisation_members_role_known\` BEFORE INSERT ON \`organisation_members\`
WHEN NEW.\`role\` NOT IN ('admin', 'member')
BEGIN
	SELECT RAISE(ABORT, 'organisation member role is not admin or member');
END;`,
  `CREATE TRIGGER IF NOT EXISTS \`organisation_members_role_known_update\` BEFORE UPDATE OF \`role\` ON \`organisation_members\`
WHEN NEW.\`role\` NOT IN ('admin', 'member')
BEGIN
	SELECT RAISE(ABORT, 'organisation member role is not admin or member');
END;`,
]);
