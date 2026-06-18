---
---

fix(cire/api): a malformed CIRE_API_ARC_PRIVATE_KEY now disables the OSN bridge (add-hosts / account-linking answer 503) instead of throwing out of the resolver builders. A corrupt ARC key previously made cire-api throw on every authenticated request — taking down the whole organiser dashboard — because importKeyFromJwk JSON.parse failures were unguarded. Both env-driven resolver builders now catch the import failure and degrade exactly like an absent key.
