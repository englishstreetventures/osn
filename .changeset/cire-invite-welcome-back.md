---
"@cire/invites": minor
"@cire/api": minor
---

Greet returning guests as returning. A household that has replied itself, fully or in part, now sees "Welcome back to your invite" with its name ("Welcome back to your invite, the Okafor Family", or "Welcome back to your invite, Anna") in place of its usual greeting once its invite opens, from a saved session or a code. While it still owes replies and RSVPs are open, a line under the greeting says "You still have replies to give", and the line goes once the last reply is in. A hero with no couple title shows "Welcome back to your invite" in place of "You're Invited". Replies the couple recorded for a household by phone or on paper do not count: the claim payload gains one flag for the household, `householdReplied`, true when any of its replies is its own, and it never says which replies a host wrote. The organiser's own hero title and welcome message never change, and a first-time guest who replies during their visit keeps their first-visit greeting.
