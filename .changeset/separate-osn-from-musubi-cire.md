---
"@cire/host": patch
"@cire/vendor": patch
---

Update the comments in both portals' `src/lib/osn.ts` for the package rename:
the identity app they redirect to is now `@musubi/social`, not `@osn/social`.
No behaviour changes — the origin has always come from configuration, and the
issuer is unchanged.
