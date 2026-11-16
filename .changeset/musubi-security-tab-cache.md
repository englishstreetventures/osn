---
"@musubi/social": patch
"@osn/auth-ui": minor
---

Settings' Security tab reads through Musubi's page cache. Coming back to the tab draws the passkeys, the authenticator app and the recovery-code count it last had at once, and reads them again behind them; the cache goes with the session that read it, as every page's does. After a write on the tab no row it may have changed is shown again: a rename or a removal shows its outcome at once, a refused write keeps the rows, and anything else draws the panel's placeholder until the read lands — the old set's recovery count included. Remove, Save, "Add an authenticator app" and Generate, pressed while a read is out, are busy ("Checking…") until it lands and act only on what it answers. `PasskeysView`, `TotpView` and `RecoveryCodesView` take an optional `read` (`SettingsRead`, exported from `@osn/auth-ui/settings-read` with `ownRead` and `writeEnd`); without one they read for themselves.
