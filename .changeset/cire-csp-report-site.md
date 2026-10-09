---
"@cire/api": patch
---

Tell CSP reports apart by site and by disposition.

- Each `csp violation report` log line carries the reporting document's origin
  (`documentOrigin`, never its query or fragment) and a `site` label: `invites`,
  `host` or `vendor` when the origin is that entry of `WEB_ORIGIN`, otherwise
  `other`.
- `disposition` is `enforce`, `report` or `unknown`. A report with no
  disposition is `unknown`, no longer `report`.
- The `cire.csp.report` counter carries `site` and `disposition` beside
  `effectiveDirective`.
- Local dev reads the vendor portal origin from `WEB_ORIGIN` entry 3, so local
  vendor claim links point at the local vendor portal.
