Starting feature or fix work in this session? Invoke the `new-feat` skill before
anything else — it takes or opens the issue, cuts the branch (worktree locally,
in-place branch on the remote environment), writes the plan to `NEW-FEAT.md`, and
runs `stress-plan` on that plan before any code is written. Skip it only for a
one-line change on a branch that already exists.

Resuming a branch: read `NEW-FEAT.md` at the root of the checkout first. It is the
branch's blackboard — where the work stands and which gates have actually run.
