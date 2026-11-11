---
"@musubi/social": patch
---

Every Musubi page carries an `Origin-Trial` header that enrols `https://musubi.social` in Chrome's Email Verification Protocol trial, so Chrome can fill the sign-up form's email verification field there. The token expires on 2 March 2027, and the trial may end sooner, with the rollout of the Chrome release after 160. A test fails once the token names another origin or feature or has expired.
