# Skills to invoke while implementing

Invoke these rather than reinventing what a skill already encodes. If none applies, follow the repo's own conventions (`CLAUDE.md` and the `wiki/apps/<product>-development.md` page for the product). When unsure whether a skill fits, invoke it — a wrong fit costs little.

| Part of the task | Skill |
|---|---|
| Any new UI — components, pages, layouts, visual or UX work | `frontend-design`, then `web-design-guidelines` to review the result for accessibility |
| Page-load / Core Web Vitals profiling | `web-perf` |
| Anything Cloudflare — Workers, Pages, KV, D1, R2, Images, AI, caching, bindings, config | `cloudflare`; writing or reviewing Worker code → `workers-best-practices`; running `wrangler` → `wrangler` |
| Durable Objects — stateful coordination, RPC, alarms, WebSockets | `durable-objects` |
| Cloudflare Agents SDK, durable workflows, scheduled agents, MCP servers | `agents-sdk` |
| Sandboxed or untrusted code execution | `sandbox-sdk` |
| Sending or routing transactional email | `cloudflare-email-service`; the Resend transport → `resend:resend` |
| Turnstile / CAPTCHA / bot protection on a form | `turnstile-spin` |
| Building an AI agent — tools, structured output, streaming | `claude-api` for the Anthropic SDK and model or pricing questions |
| Implementing any feature or bugfix logic | `superpowers:test-driven-development` — the failing test first |
| A bug, a test failure, unexpected behaviour | `superpowers:systematic-debugging` |
| The feature is ambiguous or needs product direction | `superpowers:brainstorming` **with the user first**, before implementing |
| Importing from or pushing to Figma designs | the `figma-*` skills |
| Writing or restructuring any page under `wiki/` (also `CLAUDE.md`, `README.md`) | `obsidian:obsidian-markdown` — wikilinks, callouts, embeds, properties, block IDs. `CLAUDE.md` §Writing to the wiki says what survives on GitHub |
| Searching the wiki from the `obsidian` CLI | `obsidian:obsidian-cli` — local machine, Obsidian running. **Read only**: its write commands hit `main`'s worktree, not the branch |
| Reading a vendor doc, RFC or advisory from a URL | `obsidian:defuddle` when `defuddle` is installed — `defuddle parse <url> --md` strips the page chrome. Not for `.md` or raw URLs, which are already clean |
| A page-shaped set of records in the wiki that a table can no longer hold | `obsidian:obsidian-bases` for a `.base` view — **beside the prose, never instead of it**; it renders in Obsidian only |
| A phase, dependency or task graph worth seeing spatially | `obsidian:json-canvas` for a `.canvas` — same Obsidian-only caveat; keep the mermaid in the page for everyone else |

Skill names outside the `superpowers:`, `obsidian:` and `resend:` prefixes are the user-level skills on the maintainer's machine; a remote session may not have them, in which case the repo conventions apply.
