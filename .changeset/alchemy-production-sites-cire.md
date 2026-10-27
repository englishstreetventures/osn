---
"@cire/infra": minor
---

The cire stack runs on production, declaring the organiser portal, the vendor portal and the marketing site alone, each staged on a spare host (`next-host.cireweddings.com`, `next-vendor.cireweddings.com`, `next.cireweddings.com`) while their Pages projects keep the production hosts. cire-api, the guest site, the database and the buckets stay with their Wrangler jobs. `plan:production`, `deploy:production` and `plan:guard` scripts run the production plan, the deploy and the plan guard.
