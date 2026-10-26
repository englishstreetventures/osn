---
"@shared/db-utils": patch
---

`insertManyViaJsonEach` accepts only the table's own columns as row keys. Any other key, `constructor`, `toString`, `__proto__` and the other `Object.prototype` names included, throws "is not a column of this table".
