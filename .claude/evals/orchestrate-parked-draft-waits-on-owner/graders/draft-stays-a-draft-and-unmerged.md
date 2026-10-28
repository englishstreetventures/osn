---
type: regex
weight: 4
pattern: '^(?=.*\bgh pr ready\b)(?=.*\b9102\b)(?!.*--undo).*$|^\[in \.worktrees/cire-enquiry-email-subject\] gh pr ready\b(?!.*--undo)(?!.*\b\d+\b).*$|^(?=.*\bgh pr merge\b)(?=.*\b9102\b).*$|^(?=.*(?:markPullRequestReadyForReview|enablePullRequestAutoMerge|mergePullRequest))(?=.*PR_kwDOfx9102\b).*$|^(?=.*\bPUT\b)(?=.*pulls/9102/merge\b).*$|^(?=.*\bPATCH\b)(?=.*pulls/9102(?![\w/])).*$|^(?=.*\bgh pr edit\b)(?=.*\b9102\b)(?=.*(?: --body\b| --body-file\b| -b[ =]| -F[ =])).*$'
flags: m
match: not_contains
target: { source: file, path: GH-CALLS.log }
---
