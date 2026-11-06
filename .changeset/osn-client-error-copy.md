---
"@osn/client": minor
"@osn/auth-ui": minor
---

Every `@osn/client` REST client's error now extends `OsnApiError` and carries the response's HTTP `status` (`0` when no response arrived) and the server's `error` code. A non-JSON error page, or a success whose body is not JSON, throws the client's own error instead of a `SyntaxError` or `null`; a failed `fetch` throws it at status `0`, and a caller's own abort still passes through. `ProfileManagementError`, an Effect tagged error rather than an `OsnApiError`, carries `status` and `code` as optional fields. New `describeAuthError(err, context?)` in `@osn/client`, which reads either, and `describePasskeyError(err, ceremony)` in `@osn/auth-ui`, whose caller names the WebAuthn ceremony that failed, turn a failure into one plain sentence that never shows the error's message, the code or the browser's text.
