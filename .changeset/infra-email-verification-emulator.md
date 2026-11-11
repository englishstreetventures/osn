---
"@shared/infra": patch
"@musubi/infra": patch
---

The secret inventory forbids `OSN_EMAIL_VERIFICATION_EMULATOR_URL` on osn-api on both tiers, as the production deploy's preflight does, and the musubi stack's read check names it and `OSN_EMAIL_VERIFICATION_API` as deliberately unset on dev, each with its reason.
