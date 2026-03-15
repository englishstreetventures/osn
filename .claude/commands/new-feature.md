Start new feature work for: $ARGUMENTS

If $ARGUMENTS is empty, ask the user for a feature name before proceeding.

Run the following two agents **in parallel**:

---

**Agent 1 — Branch prep** (general-purpose agent):

1. Run `git checkout main`
2. Run `git pull origin main`
3. Derive a kebab-case branch name from the feature description, prefixed with `feat/` (e.g. `feat/user-profile-page`)
4. Run `git checkout -b <branch-name>`
5. Report the exact branch name created

---

**Agent 2 — Feature planner** (Plan subagent):

Explore the OSN codebase and produce a concise implementation plan for the feature described in $ARGUMENTS.

The plan should:
- Identify relevant existing files and patterns (Effect.ts services, Elysia routes, Drizzle schema, SolidJS/Tauri frontend)
- List the files that need to be created or modified
- Outline the implementation steps in order
- Flag any Effect.ts, WebSocket, or E2E encryption considerations
- Note if a changeset will be needed (it always is)

---

After both agents complete, summarise:
- The branch that was created
- The full implementation plan
