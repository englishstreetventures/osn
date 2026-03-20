Start new feature work for: $ARGUMENTS

If $ARGUMENTS is empty, ask the user for a feature name before proceeding.

Run the following two agents **in parallel**:

---

**Agent 1 — Branch prep** (general-purpose agent):

1. Run `git checkout main`
2. Run `git pull origin main`
3. Derive a kebab-case branch name from the feature description, prefixed with `feat/`
4. Run `git checkout -b <branch-name>`
5. Report the exact branch name created

---

**Agent 2 — Feature planner** (Plan subagent):

Explore the Cire monorepo and produce a concise implementation plan for the feature described in $ARGUMENTS.

The plan should:
- Identify relevant existing files and patterns (Hono route handlers in `apps/api/src/routes/`, service layer in `apps/api/src/services/`, Astro pages in `apps/web/src/pages/`, SolidJS islands, Drizzle schema in `packages/db/`)
- List the files that need to be created or modified
- Outline the implementation steps in order
- Flag any Cloudflare-specific concerns (D1 migrations needed, wrangler binding changes, Worker CPU time, Cloudflare Pages routing)
- Note whether a new Drizzle migration is required

---

After both agents complete, summarise:
- The branch that was created
- The full implementation plan

---

Once the user confirms they are happy with the implementation plan, prompt them:

"Ready to push this branch? Run `/prep-pr` to run tests, get performance and security reviews, and push the branch."
