# Registering a stack

Reference for `prep-pr`'s final step.

### Register the stack

A correct base gives a correct diff. It does **not** make GitHub render a stack — that is a separate object, and skipping this step is why stacks used to get built by hand in the web UI.

Only when `$BASE` is not `main`, i.e. this PR sits on top of another:

```bash
gh stack --help >/dev/null 2>&1 || gh extension install github/gh-stack
gh stack link <bottom-pr> [<middle-pr> …] <this-pr>      # bottom to top, PR numbers or branches
gh stack checkout <stack-number>                         # confirm — number that link printed
```

`gh stack link` needs no local stack state, which is what makes it the right command in a worktree layout — and is also why `gh stack view` on its own is not the confirmation. `view` reads local tracking that `link` never writes, so it reports "not part of a stack" on a stack that exists. `gh stack checkout <stack-number>` imports the tracking, fails loudly if the stack is not there, and prints the chain. It reuses PRs that already exist and never drops one. Two arguments minimum, so the bottom PR of a stack has nothing to register until the second PR opens.

If the extension is missing and cannot be installed (a remote environment with no network), say so and stop there. The base chain is already correct, so the diffs and merge order hold; the stack can be registered later from any machine.

Merge order and rebase rules are in `[[wiki/conventions/stacked-prs]]`.
