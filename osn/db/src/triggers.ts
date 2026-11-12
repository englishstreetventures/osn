/**
 * The triggers on the OSN identity database, as the migrations create them.
 *
 * Drizzle cannot declare a trigger, so this list copies them for every
 * database built from the schema rather than from the migrations: each test
 * database (`./testing`) and the local file `db:push` builds
 * (`./push-triggers`). `tests/ddl-lockstep.test.ts` holds this list to the
 * migration chain. It compares SQL without case, so the exact text of each
 * trigger is held by the Miniflare D1 test that runs its migration itself:
 * `osn/api/tests/d1/organisation-member-role.test.ts` and
 * `osn/api/tests/d1/account-email-lower-case.test.ts`.
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
  // An account's email holds no capital letter A to Z.
  `CREATE TRIGGER IF NOT EXISTS \`accounts_email_lower_case\` BEFORE INSERT ON \`accounts\`
WHEN NEW.\`email\` <> lower(NEW.\`email\`)
BEGIN
	SELECT RAISE(ABORT, 'account email is not lower case');
END;`,
  `CREATE TRIGGER IF NOT EXISTS \`accounts_email_lower_case_update\` BEFORE UPDATE OF \`email\` ON \`accounts\`
WHEN NEW.\`email\` <> lower(NEW.\`email\`)
BEGIN
	SELECT RAISE(ABORT, 'account email is not lower case');
END;`,
]);
