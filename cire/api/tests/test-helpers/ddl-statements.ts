/**
 * `src/db/setup.ts`'s `DDL` as whole statements, for a D1 binding, whose
 * `prepare` takes exactly one. Split on `;`, except inside a trigger: the
 * statements in a trigger's body end in `;` too, so everything from
 * `CREATE TRIGGER` to its `END` stays one statement.
 */
export function ddlStatements(ddl: string): string[] {
  const statements: string[] = [];
  let trigger: string[] | null = null;
  for (const raw of ddl.split(";")) {
    const piece = raw.trim();
    if (!piece) continue;
    if (trigger) {
      trigger.push(piece);
      if (/^END$/i.test(piece)) {
        statements.push(trigger.join(";\n"));
        trigger = null;
      }
    } else if (/^CREATE TRIGGER/i.test(piece)) {
      trigger = [piece];
    } else {
      statements.push(piece);
    }
  }
  if (trigger) throw new Error(`a trigger with no END: ${trigger[0]?.slice(0, 80)}`);
  return statements;
}
