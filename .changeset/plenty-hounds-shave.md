---
"@osn/social": patch
---

Point the App Site Association file at the renamed Pulse bundle id

`/.well-known/apple-app-site-association` named `FV59Y8RSUH.com.osn.pulse`. The
Pulse bundle id is now `social.musubi.pulse`, so the entry is
`FV59Y8RSUH.social.musubi.pulse`.

The file is the domain half of the `webcredentials:musubi.social` associated
domain: iOS reads it to decide whether an app may use passkeys saved for this
site. A stale app id there fails silently — no error, no prompt, the
association simply never forms and passkeys never appear in the app. The two
values have to move together, which `pulse/ios/project.yml` now says next to
the bundle id itself.
