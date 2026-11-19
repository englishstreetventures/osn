---
"@musubi/social": patch
"@pulse/web": patch
"@osn/auth-ui": patch
---

Tests that polled a spy with `vi.waitFor` now await a promise the mock resolves when it is called, then check the call count once: `RecoveryCodesPrompt` (whose two quiet cases now settle the status answer before checking the prompt is absent), `OnboardingGate` and `RecoveryLoginForm`. No shipped code changes.
