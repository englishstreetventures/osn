---
"@osn/client": major
---

`cancelAccountDeletion` now takes `{ stepUpToken }`, a step-up token for the new purpose `account_restore`, and sends it as `step_up_token`: `POST /account/restore` refuses a cancel without one. Any live session of the account may call it. `StepUpPurpose` gains `account_restore`.

`deleteAccount` takes optional `choices` (`{ action, choice, successorProfileId? }`), the answers to the open actions the new `getAccountDeletionPreview` lists: each organisation a profile of the account owns, who would take it over, and the choices it allows. New types `AccountDeletionChoice`, `AccountDeletionOpenAction` and `AccountDeletionPreview`.
