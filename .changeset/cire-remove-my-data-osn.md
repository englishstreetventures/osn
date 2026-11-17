---
"@osn/api": minor
"@osn/client": minor
"@osn/auth-ui": patch
"@shared/observability": patch
"@musubi/social": minor
"@musubi/infra": patch
---

An app whose own pages cannot run a step-up asks for one through Musubi: an app step-up request. osn-api adds the purpose `cire_app_delete` (spent by `cire-api` alone), `POST /internal/step-up/requests` to begin a request bound to the hash of a secret the app's cookie holds in the asking browser, `GET /step-up/requests/:id` and `POST /step-up/requests/:id/confirm` for Musubi's confirm page, and a request form of `/internal/step-up/verify` that spends nothing and answers the account and every profile of it. The return address is pinned to `CIRE_ORGANISER_ORIGIN`, which the musubi stack sets. `@osn/client` adds `createAppStepUpClient`; `@osn/auth-ui`'s step-up sheet offers its three factors for the new purpose. Musubi adds `/confirm/:requestId`, and follows an app's `http:` link to this machine, which osn-api forwards from a local run only. New counter `osn.auth.app_step_up.requests`; two step-up limiters join the rate-limit endpoint list. The musubi stack registers cire-api's dev key with `step-up:verify`.
