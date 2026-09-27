---
"@cire/api": minor
"@cire/host": minor
---

Mark plus-ones in the organiser RSVP table and the guest exports. `GET /rsvps`
entries carry the inviter's name (`plusOneOfName`); `rsvps.csv` and
`guests.csv` gain a last "Plus-one Of" column and list each plus-one after the
guest who brought them; the RSVP report's Recorded By says "Household" for a
reply the household gave for its plus-one. The RSVP table marks a plus-one's
row "Plus-one of <inviter>", badges a household-given reply Household-entered,
finds plus-ones by search, and records a plus-one's reply without the dietary
fields the organiser route refuses, warning before a save clears ones the
household gave.
