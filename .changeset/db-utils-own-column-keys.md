---
"@shared/db-utils": patch
---

`insertManyViaJsonEach` treats only the table's own columns as columns. A row key that names a member of `Object.prototype` (`constructor`, `toString`, `hasOwnProperty`, `valueOf`, or an own `__proto__` key) now throws "is not a column of this table", the same as any other unknown key. Before, it passed the column check and either put the member's name into the SQL column list or failed later with a `TypeError`.
