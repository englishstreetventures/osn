---
"@tools/pr-metrics": patch
---

Stop counting machine records as human turns. `interaction.corrective_turns` is
documented as the one field that measures the person rather than the model, and
it was inflating on exactly the sessions that follow this repository's own
conventions most closely.

Two shapes were being read as prompts:

- **A queued record that is machinery.** `humanTurnText` returned a
  `queued_command`'s prompt unexamined, so every background subagent hand-back
  and task notification scored as a mid-flight course correction. They are now
  rejected on the leading `<` — the same rule the `user` branch has always
  applied to system reminders and slash-command envelopes.
- **A session a program drove.** `~/.claude/projects` keys transcripts by
  working directory, so a headless tool run against a worktree writes into the
  same directory as the person working there, and its opening instruction is an
  ordinary `user` record with no tag to reject it by. `entrypoint` separates
  them: `cli` is a terminal, `sdk-py` and `sdk-cli` are programs. An absent
  value keeps the previous answer, so this only ever removes a false positive.

Measured on one branch: 11 corrective turns recorded against three turns the
person actually sent, none of them a correction. Nine were notifications, two
were an automated security review sharing the directory.

Cards already committed cannot be recomputed — `~/.claude/projects` is local and
unversioned, which is why the card is committed in the first place — so
`wiki/observability/session-metrics.md` now says to read the field on an older
card as an upper bound.
