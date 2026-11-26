---
"@tools/e2e": patch
---

`musubi-passkey` reads a row of Musubi's theme menu at 8px, the menu-row corner Musubi maps, and `musubi-account-deletion` reads the drawn "Delete everything" box at 6px, Musubi's small corner, so a fix that rounded the rows by raising the small corner fails there.
