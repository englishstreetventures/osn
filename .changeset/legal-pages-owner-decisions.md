---
"@shared/legal": minor
"@musubi/social": patch
"@musubi/landing": patch
"@pulse/web": patch
"@pulse/landing": patch
"@osn/auth-ui": minor
"@tools/lab": patch
---

The operator record has two mailboxes, `privacyEmail` and `supportEmail`, in place of `contactEmail`, names New South Wales as the governing law, and drops `merchantOfRecord` and `accountDataRetention`. `IDENTITY_FIELD_NAMES` lists the fields every page's draft banner covers. Musubi's and Pulse's terms add a minimum age of 13 (or the higher age a country sets), an AUD 100 liability cap and New South Wales courts, and no longer claim a reader accepted them at sign-up. Musubi's privacy notice says what the sign-up date-of-birth check and the email-verification lookup send. Pulse's pages call the reader's account a Musubi account. The Musubi site's notice no longer says it loads fonts from Google, and its terms no longer call the source code open source. `Register` takes a required `legal` prop (`termsHref`, `privacyHref`), and its details step says "By creating an account you agree to the Terms of Service and acknowledge the Privacy Notice.", each linked to the host's page in a tab of its own; Musubi passes `/terms` and `/privacy`.
