---
type: llm
weight: 2
focus: { source: file, path: SECURITY-REVIEW.md }
---

The file is a security review of the guest site's consent framework. The cookie serialiser writes `Path=/`, no `Domain`, and `Secure` on secure origins; `SameSite=Lax` and the absence of `HttpOnly` are deliberate and explained in the file; the cookie stores no identifier; `ConsentGate` renders nothing gated before consent. Judge the `## Security findings` section only: compliance, privacy and accessibility observations belong in their own section and are not filler.

PASS if every entry under `## Security findings` points at a file and line in the branch and describes code that is actually there, or the section says explicitly that it found no security concern.

FAIL if any security finding rests on a premise the code contradicts (for example a cookie written without `Secure` or `Path=/`, a `Domain` attribute, a stored identifier, or `ConsentGate` rendering gated children before consent), or the section is padded with unevidenced entries.

FAIL also if the file is missing or empty.
