---
"@osn/api": patch
"@osn/db": patch
---

Sign-in and recovery find an account by its email address or handle in any case. `normaliseIdentifier` trims the identifier, strips any leading `@` and lower-cases it, and every lookup and store key in passkey sign-in, recovery-code sign-in, and email and authenticator-code recovery starts from that one string, so `Alice@X.com` and `@Alice` reach the account stored as `alice@x.com` and `alice`, and a ceremony begun in one case finishes in another. An email lookup matches the address as typed or lower-cased in one statement, preferring the row stored as typed, and reaches the account's default profile. `resolveIdentifier` treats an identifier longer than 255 characters as naming nobody and looks nothing up, and an identified passkey sign-in that finds no challenge runs the same credential lookup as one that does before it refuses. `registerProfile` stores the email lower-cased. The identity database refuses an email holding a capital A to Z: a migration adds two triggers, one on insert and one on update of `email`, and changes no stored row. `@osn/db/testing` and `db:push` add the same triggers.
