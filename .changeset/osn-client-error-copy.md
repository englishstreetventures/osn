---
"@osn/client": minor
"@osn/auth-ui": minor
---

Every `@osn/client` error now extends `OsnApiError` and carries the response's HTTP `status` (`0` when no response arrived) and the server's `error` code. A non-JSON error page, or a success whose body is not JSON, throws the client's own error instead of a `SyntaxError` or `null`; a failed `fetch` throws it at status `0`, and a caller's own abort still passes through. `ProfileManagementError` carries `status` and `code` too. New `describeAuthError(err, context?)` in `@osn/client` and `describePasskeyError(err)` in `@osn/auth-ui` turn a failure into one plain sentence that never shows the error's message, the code or the browser's text.
