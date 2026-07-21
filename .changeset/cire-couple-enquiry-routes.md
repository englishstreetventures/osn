---
"@cire/api": patch
---

Vendors S4: couple-side enquiry routes under
`/api/organiser/weddings/:weddingId/enquiries`. `GET /enquiries` (list) and
`GET /enquiries/:id/messages` are `weddingMember`-gated reads; `POST /enquiries`
(open), `POST /enquiries/:id/messages` (reply), and
`POST /enquiries/:id/add-to-budget` are `weddingEditor`-gated writes behind a
per-user rate limiter (viewer co-hosts get 403 `read_only_role`). Every
id-bearing handler re-loads the enquiry scoped to the gated wedding and answers
404 on a cross-tenant mismatch. Service tagged errors map to HTTP:
`EnquiryNotFound`→404, `EnquiryAwaitingVendor`→409 `awaiting_vendor`,
`ZapUnavailable`→503. The enquiry service (zap c2b client + email sender) is
built once in `createApp` from injected deps and wired from env in `index.ts`
(`createZapChatClientFromEnv` over `ZAP_API_URL` + the existing cire ARC key);
a null zap client keeps the routes mounted with open/reply degrading to 503.
