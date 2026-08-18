# GitHub Issues Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move 550 open TODO checklist items out of `wiki/TODO.md` and `cire/wiki/todo/*.md` into GitHub Issues across a public repo and a new private tracker, unified by one org Project, and rewrite the commands that used to write to those files.

**Architecture:** A committed bun script parses the markdown into a manifest, a set of safety assertions gates the manifest, and only then does a throttled `gh api` writer create issues epic-first and link sub-issues. Every write is idempotent against a resume manifest, so a run that trips GitHub's 500/hr content-creation limit can stop and continue in the next window.

**Tech Stack:** bun (runtime + test runner), `gh` CLI (REST via `gh api`, GraphQL via `gh api graphql`), GitHub Issues sub-issues API, GitHub Projects v2.

**Spec:** `docs/superpowers/specs/2026-08-15-github-issues-migration-design.md`

## Global Constraints

- **Never delete an issue.** Close it. From `wiki/conventions/review-findings.md`: "**Never delete** findings from the backlog — the history matters." No script, command, or task in this plan may call any delete endpoint.
- **`xchromo/osn` is public.** No item classified `area:security`, `area:performance`, or `area:compliance` may be created there. This is asserted mechanically in Task 5, not left to review.
- **No business content in any issue.** `wiki/business/` is gitignored; entity name, ABN, tax and monetisation planning never appear in an issue body, public or private.
- **Owner `xchromo` is an Organization** (verified: `gh api users/xchromo --jq .type` → `Organization`). Project commands use `--owner xchromo` and org-scoped GraphQL.
- **Content-creation rate limit: 80/min, 500/hr.** The writer throttles to one mutation per **8 seconds** (450/hr) and refuses to start a batch it cannot finish in the current hour without exceeding 450.
- **Item prose carries over verbatim.** Bodies are dense and multi-paragraph. No summarising, no rewording, no truncation.
- **Exactly one `product:` label per issue** — needed so the Project's table view can group by label cleanly.
- Runtime is bun; tests are `bun test`; the repo formats with `bun run format` and lints with `bun run lint` (oxlint).

## Deviations from the spec

Two simplifications found while planning. Both reduce API load and neither changes the outcome.

1. **The `Finding ID` project field is dropped.** Populating it for 356 migrated findings needs 356 extra GraphQL mutations, and the ID already leads the issue title (`S-M34 — …`). It stays greppable with `gh issue list --search "S-M34"`. The Project keeps three fields: Status, Priority, Effort.
2. **Status is set by a built-in Project workflow, not by the script.** The "Item added to project" workflow sets `Status = Backlog` on add, costing zero API calls. The ~10 Up Next items get moved to `Up Next` by hand in the UI (Task 8), which is faster than any scripted pass.

## File Structure

```
scripts/todo-to-issues/
  types.ts        # Item, Classified, Manifest — shared shapes, no logic
  parse.ts        # markdown -> Item[]        (pure, no I/O beyond reading files)
  parse.test.ts
  classify.ts     # Item -> Classified        (repo, labels, findingId, severity)
  classify.test.ts
  wikilinks.ts    # [[wikilink]] -> relative markdown link
  wikilinks.test.ts
  render.ts       # Classified -> issue title + body
  render.test.ts
  assert.ts       # manifest safety gates (the disclosure checks)
  assert.test.ts
  github.ts       # throttled gh api wrapper: createIssue, linkSubIssue
  github.test.ts
  main.ts         # CLI: `plan` (dry run) | `verify` | `apply --phase N`
.migration/
  manifest.json   # committed; issue number <-> source file + line
wiki/runbooks/github-issues-setup.md   # Phase 0, the parts only a human can do
```

Each module has one job and is testable without the network. `github.ts` is the only file that writes to GitHub; everything upstream of it is pure and covered by tests.

---

## Task 1: Parser

Turn the markdown into a flat list of top-level open items, each carrying its section, subsection, and full verbatim body.

**Files:**
- Create: `scripts/todo-to-issues/types.ts`
- Create: `scripts/todo-to-issues/parse.ts`
- Test: `scripts/todo-to-issues/parse.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  ```ts
  export type Item = {
    sourceFile: string;      // "wiki/TODO.md"
    sourceLine: number;      // 1-indexed line of the "- [ ]" line
    section: string;         // "Security Backlog"
    subsection: string | null; // "Medium"
    title: string;           // the checkbox line, checkbox marker stripped
    body: string;            // everything under it, verbatim, trailing blanks trimmed
  };
  export function parseTodo(markdown: string, sourceFile: string): Item[];
  ```

**Parsing rules (exact):**
- `## X` sets `section` and clears `subsection`. `### Y` sets `subsection`.
- A top-level item is `- [ ] ` at **indent 0**. Only unchecked, indent-0 items are returned.
- An item's body runs from the line after its checkbox line until the first of: the next indent-0 checkbox line, the next `#` heading, or a `---` rule. Trailing blank lines are trimmed.
- Nested checkboxes (`  - [x] …`) stay inside the parent's body. They do **not** become issues — the spec fixes the hierarchy at two levels.

- [ ] **Step 1: Write the failing test**

```ts
// scripts/todo-to-issues/parse.test.ts
import { expect, test } from "bun:test";
import { parseTodo } from "./parse";

const SAMPLE = `# OSN Project TODO

## Up Next

Intro paragraph, not an item.

- [ ] **Dev tier** — one-time setup still open. See [[dev-environment]].
- [x] **Already done** — skipped.
- [ ] **Identity move** — multi-line item.
  - **PR C — merged.** cire is registered as \`cid_cire\`.
  - [x] Turnstile client half followed the ceremonies.

  See [[production-deploy]].

---

## Security Backlog

### Medium

- [ ] S-M (cohost-add-ignores-blocks) — nothing consults the block graph.
`;

test("returns only unchecked top-level items", () => {
  const items = parseTodo(SAMPLE, "wiki/TODO.md");
  expect(items.map((i) => i.title)).toEqual([
    "**Dev tier** — one-time setup still open. See [[dev-environment]].",
    "**Identity move** — multi-line item.",
    "S-M (cohost-add-ignores-blocks) — nothing consults the block graph.",
  ]);
});

test("captures nested bullets and continuation paragraphs verbatim", () => {
  const items = parseTodo(SAMPLE, "wiki/TODO.md");
  expect(items[1].body).toBe(
    "  - **PR C — merged.** cire is registered as `cid_cire`.\n" +
      "  - [x] Turnstile client half followed the ceremonies.\n" +
      "\n" +
      "  See [[production-deploy]].",
  );
});

test("records section, subsection, and 1-indexed source line", () => {
  const items = parseTodo(SAMPLE, "wiki/TODO.md");
  expect(items[0].section).toBe("Up Next");
  expect(items[0].subsection).toBeNull();
  expect(items[2].section).toBe("Security Backlog");
  expect(items[2].subsection).toBe("Medium");
  expect(SAMPLE.split("\n")[items[0].sourceLine - 1]).toStartWith("- [ ] **Dev tier**");
});

test("a heading ends the preceding item's body", () => {
  const items = parseTodo(SAMPLE, "wiki/TODO.md");
  expect(items[1].body).not.toContain("Security Backlog");
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `bun test scripts/todo-to-issues/parse.test.ts`
Expected: FAIL — `Cannot find module './parse'`

- [ ] **Step 3: Write the types**

```ts
// scripts/todo-to-issues/types.ts
export type Item = {
  sourceFile: string;
  sourceLine: number;
  section: string;
  subsection: string | null;
  title: string;
  body: string;
};

export type Severity = "critical" | "high" | "medium" | "low" | "info";

export type Classified = Item & {
  repo: "public" | "private";
  labels: string[];
  findingId: string | null;
  severity: Severity | null;
};

export type ManifestEntry = Classified & {
  issueTitle: string;
  issueBody: string;
  epic: string; // the section title this belongs under
  issueNumber?: number;
  issueId?: string; // node id, needed for the sub-issues API
};
```

- [ ] **Step 4: Write the parser**

```ts
// scripts/todo-to-issues/parse.ts
import type { Item } from "./types";

const HEADING = /^(#{1,6})\s+(.*)$/;
const TOP_ITEM = /^- \[( |x)\]\s+(.*)$/;
const RULE = /^---\s*$/;

export function parseTodo(markdown: string, sourceFile: string): Item[] {
  const lines = markdown.split("\n");
  const items: Item[] = [];
  let section = "";
  let subsection: string | null = null;
  let open: (Item & { bodyLines: string[] }) | null = null;

  const flush = () => {
    if (!open) return;
    while (open.bodyLines.length > 0 && open.bodyLines.at(-1)!.trim() === "") {
      open.bodyLines.pop();
    }
    const { bodyLines, ...rest } = open;
    items.push({ ...rest, body: bodyLines.join("\n") });
    open = null;
  };

  for (const [index, line] of lines.entries()) {
    const heading = HEADING.exec(line);
    if (heading) {
      flush();
      if (heading[1].length === 2) {
        section = heading[2].trim();
        subsection = null;
      } else if (heading[1].length === 3) {
        subsection = heading[2].trim();
      }
      continue;
    }

    if (RULE.test(line)) {
      flush();
      continue;
    }

    const item = TOP_ITEM.exec(line);
    if (item) {
      flush();
      if (item[1] === " ") {
        open = {
          sourceFile,
          sourceLine: index + 1,
          section,
          subsection,
          title: item[2].trim(),
          body: "",
          bodyLines: [],
        };
      }
      continue;
    }

    open?.bodyLines.push(line);
  }

  flush();
  return items;
}
```

- [ ] **Step 5: Run the test and watch it pass**

Run: `bun test scripts/todo-to-issues/parse.test.ts`
Expected: PASS, 4 tests

- [ ] **Step 6: Check the parser against the real files**

Run:
```bash
bun -e 'import {parseTodo} from "./scripts/todo-to-issues/parse";
const md = await Bun.file("wiki/TODO.md").text();
console.log(parseTodo(md, "wiki/TODO.md").length)'
```
Expected: `411` — matching `grep -c "^[ \t]*-[ \t]*\[ \]" wiki/TODO.md`. If it does not match, the difference is nested unchecked items (which the grep counts and the parser deliberately does not); confirm with `grep -c "^- \[ \]" wiki/TODO.md` and reconcile before moving on.

- [ ] **Step 7: Commit**

```bash
git add scripts/todo-to-issues/types.ts scripts/todo-to-issues/parse.ts scripts/todo-to-issues/parse.test.ts
git commit -m "feat(scripts): parse TODO checklists into structured items"
```

---

## Task 2: Classifier

Decide which repo an item goes to and what labels it carries.

**Files:**
- Create: `scripts/todo-to-issues/classify.ts`
- Test: `scripts/todo-to-issues/classify.test.ts`

**Interfaces:**
- Consumes: `Item`, `Classified`, `Severity` from `./types`
- Produces:
  ```ts
  export function classify(item: Item): Classified;
  export function findingId(title: string): string | null;
  export function severityOf(findingId: string): Severity | null;
  ```

**Rules:**

Finding IDs appear as `S-H1`, `S-M34`, `S-L1 (zap)`, `S-H (astro-ssrf)`, `S-M (register-abandon…, 2026-08-15)`, `C-H8`, `P-W2`, `AUDIT-Z1`. The regex is `^(S|P|C|T)-(C|H|M|L|W|I)(\d*)\b`. Severity comes from the second letter: `C`→critical, `H`/`W`→high, `M`→medium, `L`→low, `I`→info.

Repo routing is by section, not by severity:

| Section | Repo | `area:` |
|---|---|---|
| Security Backlog, `cire/wiki/todo/security.md` | private | security |
| Performance Backlog, `cire/wiki/todo/perf.md` | private | performance |
| Compliance Backlog | private | compliance |
| everything else | public | see below |

Area for public items: `cire/wiki/todo/db.md` → `schema`; an Up Next or Platform item whose text matches `/\b(deploy|secret|dashboard|wrangler|cron|DNS|WAF|Cloudflare|CI)\b/` → `ops`; otherwise `feature`.

Product — exactly one label:

| Source | `product:` |
|---|---|
| any `cire/wiki/todo/*.md`, `## Cire`, `## Cire Landing` | cire |
| `## Pulse` | pulse |
| `## Zap` | zap |
| `## Landing` | landing |
| `## Platform` | shared |
| `## OSN Core`, `## Verified Identity`, `## Auth Improvements` | osn-core |
| `## Up Next`, `## Future`, the three backlogs | keyword: `cire`→cire, `pulse`→pulse, `zap`→zap, else osn-core |

The keyword arm matches the parenthesised slug first (`S-L1 (zap)` → zap), then a whole-word scan of the title. Backlog items rarely name their product any other way; the dry-run review in Task 5 is where mistakes get caught.

- [ ] **Step 1: Write the failing test**

```ts
// scripts/todo-to-issues/classify.test.ts
import { expect, test } from "bun:test";
import { classify, findingId, severityOf } from "./classify";
import type { Item } from "./types";

const item = (over: Partial<Item>): Item => ({
  sourceFile: "wiki/TODO.md",
  sourceLine: 1,
  section: "Up Next",
  subsection: null,
  title: "placeholder",
  body: "",
  ...over,
});

test("extracts every finding ID shape in the backlogs", () => {
  expect(findingId("S-H1 (client) — Refresh token sent in JSON body")).toBe("S-H1");
  expect(findingId("S-M34 — getClientIp trusts the first hop")).toBe("S-M34");
  expect(findingId("S-H (astro-ssrf) `GHSA-2pvr` — Astro Host-header SSRF")).toBe("S-H");
  expect(findingId("P-W2 — N+1 in listEvents")).toBe("P-W2");
  expect(findingId("C-L7 — retention note missing")).toBe("C-L7");
  expect(findingId("**Dev tier** — one-time setup still open.")).toBeNull();
});

test("maps the finding prefix to a severity", () => {
  expect(severityOf("S-C1")).toBe("critical");
  expect(severityOf("S-H1")).toBe("high");
  expect(severityOf("P-W2")).toBe("high");
  expect(severityOf("S-M34")).toBe("medium");
  expect(severityOf("C-L7")).toBe("low");
  expect(severityOf("P-I3")).toBe("info");
});

test("routes the three backlogs to the private tracker", () => {
  expect(classify(item({ section: "Security Backlog" })).repo).toBe("private");
  expect(classify(item({ section: "Performance Backlog" })).repo).toBe("private");
  expect(classify(item({ section: "Compliance Backlog" })).repo).toBe("private");
  expect(
    classify(item({ sourceFile: "cire/wiki/todo/perf.md", section: "Performance" })).repo,
  ).toBe("private");
});

test("routes planned work to the public repo", () => {
  expect(classify(item({ section: "Zap (`zap/api`)" })).repo).toBe("public");
  expect(classify(item({ section: "Auth Improvements (Copenhagen Book Audit)" })).repo).toBe(
    "public",
  );
});

test("assigns exactly one product label", () => {
  const products = (i: Item) => classify(i).labels.filter((l) => l.startsWith("product:"));
  expect(products(item({ section: "Pulse (`pulse/web`)" }))).toEqual(["product:pulse"]);
  expect(products(item({ section: "Cire Landing (`cire/landing`)" }))).toEqual(["product:cire"]);
  expect(products(item({ section: "Platform" }))).toEqual(["product:shared"]);
  expect(products(item({ section: "Security Backlog", title: "S-L1 (zap) — no alg pin" }))).toEqual(
    ["product:zap"],
  );
  expect(products(item({ section: "Future", title: "Nothing named here" }))).toEqual([
    "product:osn-core",
  ]);
});

test("labels ops work in Up Next as ops, not feature", () => {
  const ops = classify(item({ title: "**Deploy preflight for required secrets** — wrangler" }));
  expect(ops.labels).toContain("area:ops");
  const feat = classify(item({ title: "**Guest list filtering** in the host dashboard" }));
  expect(feat.labels).toContain("area:feature");
});

test("attaches a severity label only to findings", () => {
  const finding = classify(item({ section: "Security Backlog", title: "S-M34 — spoofable hop" }));
  expect(finding.labels).toContain("severity:medium");
  expect(finding.findingId).toBe("S-M34");
  const planned = classify(item({ section: "Platform", title: "Build the vendor portal" }));
  expect(planned.labels.some((l) => l.startsWith("severity:"))).toBe(false);
  expect(planned.severity).toBeNull();
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `bun test scripts/todo-to-issues/classify.test.ts`
Expected: FAIL — `Cannot find module './classify'`

- [ ] **Step 3: Write the classifier**

```ts
// scripts/todo-to-issues/classify.ts
import type { Classified, Item, Severity } from "./types";

const FINDING = /^(S|P|C|T)-(C|H|M|L|W|I)(\d*)\b/;

const SEVERITY: Record<string, Severity> = {
  C: "critical",
  H: "high",
  W: "high",
  M: "medium",
  L: "low",
  I: "info",
};

const OPS = /\b(deploy|secret|dashboard|wrangler|cron|DNS|WAF|Cloudflare|CI)\b/i;

export function findingId(title: string): string | null {
  const match = FINDING.exec(title.trim());
  return match ? `${match[1]}-${match[2]}${match[3]}` : null;
}

export function severityOf(id: string): Severity | null {
  const match = FINDING.exec(id);
  return match ? SEVERITY[match[2]] : null;
}

function areaOf(item: Item): string {
  const { section, sourceFile } = item;
  if (section.startsWith("Security Backlog") || sourceFile.endsWith("todo/security.md")) {
    return "security";
  }
  if (section.startsWith("Performance Backlog") || sourceFile.endsWith("todo/perf.md")) {
    return "performance";
  }
  if (section.startsWith("Compliance Backlog")) return "compliance";
  if (sourceFile.endsWith("todo/db.md")) return "schema";
  if (OPS.test(item.title)) return "ops";
  return "feature";
}

function productOf(item: Item): string {
  const { section, sourceFile, title } = item;
  if (sourceFile.startsWith("cire/") || section.startsWith("Cire")) return "cire";
  if (section.startsWith("Pulse")) return "pulse";
  if (section.startsWith("Zap")) return "zap";
  if (section.startsWith("Landing")) return "landing";
  if (section === "Platform") return "shared";
  if (
    section.startsWith("OSN Core") ||
    section.startsWith("Verified Identity") ||
    section.startsWith("Auth Improvements")
  ) {
    return "osn-core";
  }
  const slug = /^[SPCT]-[CHMLWI]\d*\s*\(([a-z-]+)/.exec(title.trim())?.[1];
  const haystack = `${slug ?? ""} ${title}`;
  if (/\bcire\b/i.test(haystack)) return "cire";
  if (/\bpulse\b/i.test(haystack)) return "pulse";
  if (/\bzap\b/i.test(haystack)) return "zap";
  return "osn-core";
}

export function classify(item: Item): Classified {
  const area = areaOf(item);
  const id = findingId(item.title);
  const severity = id ? severityOf(id) : null;
  const labels = [`product:${productOf(item)}`, `area:${area}`];
  if (severity) labels.push(`severity:${severity}`);
  const repo =
    area === "security" || area === "performance" || area === "compliance" ? "private" : "public";
  return { ...item, repo, labels, findingId: id, severity };
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `bun test scripts/todo-to-issues/classify.test.ts`
Expected: PASS, 7 tests

- [ ] **Step 5: Commit**

```bash
git add scripts/todo-to-issues/classify.ts scripts/todo-to-issues/classify.test.ts
git commit -m "feat(scripts): classify TODO items by repo, product, area and severity"
```

---

## Task 3: Wikilink rewriter

`[[identity-model]]` and `[[changelog/security-fixes]]` are Obsidian links. GitHub renders them as literal text. Resolve them against the real wiki tree or degrade them to code spans — never leave a dead link.

**Files:**
- Create: `scripts/todo-to-issues/wikilinks.ts`
- Test: `scripts/todo-to-issues/wikilinks.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  ```ts
  export function buildWikiIndex(paths: string[]): Map<string, string>;
  export function rewriteWikilinks(text: string, index: Map<string, string>, repoUrl: string): string;
  ```
  `buildWikiIndex` maps a bare name (`identity-model`) and a path-ish name (`changelog/security-fixes`) to a repo path. `rewriteWikilinks` produces absolute `https://github.com/...` links, because the private tracker's issues reference files in the public repo and relative links would break there.

- [ ] **Step 1: Write the failing test**

```ts
// scripts/todo-to-issues/wikilinks.test.ts
import { expect, test } from "bun:test";
import { buildWikiIndex, rewriteWikilinks } from "./wikilinks";

const INDEX = buildWikiIndex([
  "wiki/systems/identity-model.md",
  "wiki/changelog/security-fixes.md",
  "cire/wiki/cire-auth.md",
]);
const URL = "https://github.com/xchromo/osn/blob/main";

test("resolves a bare wikilink to an absolute blob URL", () => {
  expect(rewriteWikilinks("see [[identity-model]] for detail", INDEX, URL)).toBe(
    "see [identity-model](https://github.com/xchromo/osn/blob/main/wiki/systems/identity-model.md) for detail",
  );
});

test("resolves a path-qualified wikilink", () => {
  expect(rewriteWikilinks("[[changelog/security-fixes]]", INDEX, URL)).toBe(
    "[changelog/security-fixes](https://github.com/xchromo/osn/blob/main/wiki/changelog/security-fixes.md)",
  );
});

test("tolerates a trailing slash, as wiki/TODO.md uses", () => {
  expect(rewriteWikilinks("[[changelog/]]", INDEX, URL)).toBe("`changelog/`");
});

test("degrades an unresolved link to a code span, never a dead link", () => {
  const out = rewriteWikilinks("[[does-not-exist]]", INDEX, URL);
  expect(out).toBe("`does-not-exist`");
  expect(out).not.toContain("[[");
});

test("leaves an existing markdown link alone", () => {
  const input = "[The Copenhagen Book](https://thecopenhagenbook.com/)";
  expect(rewriteWikilinks(input, INDEX, URL)).toBe(input);
});

test("rewrites every link on a line, not just the first", () => {
  expect(rewriteWikilinks("[[identity-model]] and [[cire-auth]]", INDEX, URL)).toBe(
    "[identity-model](https://github.com/xchromo/osn/blob/main/wiki/systems/identity-model.md)" +
      " and [cire-auth](https://github.com/xchromo/osn/blob/main/cire/wiki/cire-auth.md)",
  );
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `bun test scripts/todo-to-issues/wikilinks.test.ts`
Expected: FAIL — `Cannot find module './wikilinks'`

- [ ] **Step 3: Write the rewriter**

```ts
// scripts/todo-to-issues/wikilinks.ts
const WIKILINK = /\[\[([^\]]+)\]\]/g;

export function buildWikiIndex(paths: string[]): Map<string, string> {
  const index = new Map<string, string>();
  for (const path of paths) {
    const withoutExt = path.replace(/\.md$/, "");
    const bare = withoutExt.split("/").at(-1)!;
    const parent = withoutExt.split("/").slice(-2).join("/");
    if (!index.has(bare)) index.set(bare, path);
    if (!index.has(parent)) index.set(parent, path);
  }
  return index;
}

export function rewriteWikilinks(
  text: string,
  index: Map<string, string>,
  repoUrl: string,
): string {
  return text.replace(WIKILINK, (_match, raw: string) => {
    const target = raw.split("|")[0].trim().replace(/#.*$/, "");
    const path = index.get(target) ?? index.get(target.replace(/\/$/, ""));
    return path ? `[${target}](${repoUrl}/${path})` : `\`${target}\``;
  });
}
```

Note on `[[changelog/]]`: the trailing slash is stripped before the second lookup, which finds nothing — `changelog` is a directory, not a note — so it degrades to a code span. That is the wanted behaviour and the third test pins it.

- [ ] **Step 4: Run the test and watch it pass**

Run: `bun test scripts/todo-to-issues/wikilinks.test.ts`
Expected: PASS, 6 tests

- [ ] **Step 5: Commit**

```bash
git add scripts/todo-to-issues/wikilinks.ts scripts/todo-to-issues/wikilinks.test.ts
git commit -m "feat(scripts): rewrite Obsidian wikilinks to GitHub blob URLs"
```

---

## Task 4: Renderer and dry-run manifest

Turn a `Classified` into the exact title and body that will be posted, and emit the whole manifest for review.

**Files:**
- Create: `scripts/todo-to-issues/render.ts`
- Create: `scripts/todo-to-issues/main.ts`
- Test: `scripts/todo-to-issues/render.test.ts`
- Modify: `package.json` (add two scripts)

**Interfaces:**
- Consumes: `Classified`, `ManifestEntry`, `rewriteWikilinks`
- Produces:
  ```ts
  export function renderTitle(item: Classified): string;
  export function renderBody(item: Classified, index: Map<string, string>): string;
  export function buildManifest(items: Classified[], index: Map<string, string>): ManifestEntry[];
  ```

**Title rules:** strip markdown emphasis and trailing punctuation, collapse whitespace, cut at 120 chars on a word boundary with a trailing `…`. The full original first line always survives in the body, so nothing is lost to the cut.

**Body shape:**
```
<title line, verbatim, wikilinks rewritten>

<body, verbatim, wikilinks rewritten>

---
Migrated from `wiki/TODO.md:577` — section "Security Backlog / Medium".
```

- [ ] **Step 1: Write the failing test**

```ts
// scripts/todo-to-issues/render.test.ts
import { expect, test } from "bun:test";
import { buildWikiIndex } from "./wikilinks";
import { renderBody, renderTitle } from "./render";
import type { Classified } from "./types";

const INDEX = buildWikiIndex(["wiki/systems/sessions.md"]);

const base: Classified = {
  sourceFile: "wiki/TODO.md",
  sourceLine: 577,
  section: "Security Backlog",
  subsection: "Medium",
  title: "S-M (register-abandon) — **pre-existing**; the cookie ships early. See [[sessions]]",
  body: "  - follow-up: gate `/authorize` too.",
  repo: "private",
  labels: ["product:osn-core", "area:security", "severity:medium"],
  findingId: "S-M",
  severity: "medium",
};

test("strips emphasis and keeps the finding ID leading the title", () => {
  expect(renderTitle(base)).toBe(
    "S-M (register-abandon) — pre-existing; the cookie ships early. See sessions",
  );
});

test("truncates a long title on a word boundary and marks it", () => {
  const long = renderTitle({ ...base, title: "S-M — " + "word ".repeat(60) });
  expect(long.length).toBeLessThanOrEqual(121);
  expect(long).toEndWith("…");
  expect(long).not.toEndWith("wor…");
});

test("body keeps the full original line even when the title was cut", () => {
  const long = { ...base, title: "S-M — " + "word ".repeat(60) };
  expect(renderBody(long, INDEX)).toContain("word word word");
});

test("body carries nested content verbatim", () => {
  expect(renderBody(base, INDEX)).toContain("  - follow-up: gate `/authorize` too.");
});

test("body rewrites wikilinks and cites the source line", () => {
  const out = renderBody(base, INDEX);
  expect(out).toContain("[sessions](https://github.com/xchromo/osn/blob/main/wiki/systems/sessions.md)");
  expect(out).toContain('Migrated from `wiki/TODO.md:577` — section "Security Backlog / Medium".');
  expect(out).not.toContain("[[");
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `bun test scripts/todo-to-issues/render.test.ts`
Expected: FAIL — `Cannot find module './render'`

- [ ] **Step 3: Write the renderer**

```ts
// scripts/todo-to-issues/render.ts
import type { Classified, ManifestEntry } from "./types";
import { rewriteWikilinks } from "./wikilinks";

export const PUBLIC_BLOB = "https://github.com/xchromo/osn/blob/main";
const MAX_TITLE = 120;

export function renderTitle(item: Classified): string {
  const plain = item.title
    .replace(/\[\[([^\]|]+)(\|[^\]]+)?\]\]/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*|__|\*|_/g, "")
    .replace(/\s+/g, " ")
    .replace(/[.,;:]+$/, "")
    .trim();
  if (plain.length <= MAX_TITLE) return plain;
  const cut = plain.slice(0, MAX_TITLE);
  const boundary = cut.lastIndexOf(" ");
  return `${cut.slice(0, boundary > 0 ? boundary : MAX_TITLE).trimEnd()}…`;
}

export function renderBody(item: Classified, index: Map<string, string>): string {
  const where = item.subsection ? `${item.section} / ${item.subsection}` : item.section;
  const parts = [
    rewriteWikilinks(item.title, index, PUBLIC_BLOB),
    item.body ? rewriteWikilinks(item.body, index, PUBLIC_BLOB) : "",
    "---",
    `Migrated from \`${item.sourceFile}:${item.sourceLine}\` — section "${where}".`,
  ];
  return parts.filter((p) => p !== "").join("\n\n");
}

export function buildManifest(
  items: Classified[],
  index: Map<string, string>,
): ManifestEntry[] {
  return items.map((item) => ({
    ...item,
    issueTitle: renderTitle(item),
    issueBody: renderBody(item, index),
    epic: item.subsection ? `${item.section} — ${item.subsection}` : item.section,
  }));
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `bun test scripts/todo-to-issues/render.test.ts`
Expected: PASS, 5 tests

- [ ] **Step 5: Write the `plan` CLI**

```ts
// scripts/todo-to-issues/main.ts
import { Glob } from "bun";
import { classify } from "./classify";
import { parseTodo } from "./parse";
import { buildManifest } from "./render";
import type { ManifestEntry } from "./types";
import { buildWikiIndex } from "./wikilinks";

const SOURCES = ["wiki/TODO.md", ...new Glob("cire/wiki/todo/*.md").scanSync(".")].sort();
const MANIFEST = ".migration/manifest.json";

async function wikiIndex(): Promise<Map<string, string>> {
  const paths = [
    ...new Glob("wiki/**/*.md").scanSync("."),
    ...new Glob("cire/wiki/**/*.md").scanSync("."),
  ];
  return buildWikiIndex(paths.sort());
}

export async function plan(): Promise<ManifestEntry[]> {
  const index = await wikiIndex();
  const classified = [];
  for (const source of SOURCES) {
    const markdown = await Bun.file(source).text();
    classified.push(...parseTodo(markdown, source).map(classify));
  }
  return buildManifest(classified, index);
}

if (import.meta.main) {
  const command = Bun.argv[2] ?? "plan";
  if (command === "plan") {
    const manifest = await plan();
    await Bun.write(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
    const counts = manifest.reduce<Record<string, number>>((acc, entry) => {
      acc[entry.repo] = (acc[entry.repo] ?? 0) + 1;
      return acc;
    }, {});
    console.log(`${manifest.length} items -> ${MANIFEST}`);
    console.log(`  public:  ${counts.public ?? 0}`);
    console.log(`  private: ${counts.private ?? 0}`);
  } else {
    console.error(`unknown command: ${command}`);
    process.exit(1);
  }
}
```

- [ ] **Step 6: Run the dry run and read the counts**

Run: `bun run scripts/todo-to-issues/main.ts plan`
Expected: `541 items` — `public: 185`, `private: 356`.

If the numbers differ, do **not** adjust the expected numbers. Find the misclassified items with:
```bash
bun -e 'const m = await Bun.file(".migration/manifest.json").json();
for (const e of m.filter(x => x.repo === "public" && x.labels.some(l => l.startsWith("severity:"))))
  console.log(e.sourceFile + ":" + e.sourceLine, e.issueTitle.slice(0, 70))'
```

- [ ] **Step 7: Add the package scripts**

In `package.json`, inside `"scripts"`, after `"test:browser"`:
```json
    "migrate:plan": "bun run scripts/todo-to-issues/main.ts plan",
    "migrate:verify": "bun run scripts/todo-to-issues/main.ts verify",
    "test:migration": "bun test scripts/todo-to-issues"
```

- [ ] **Step 8: Commit**

```bash
git add scripts/todo-to-issues/render.ts scripts/todo-to-issues/render.test.ts scripts/todo-to-issues/main.ts package.json .migration/manifest.json
git commit -m "feat(scripts): render migration manifest as a dry run"
```

---

## Task 5: Safety gates

The manifest is the artifact under review. These assertions are what make it safe to run — a public repo must never receive an unpatched finding.

**Files:**
- Create: `scripts/todo-to-issues/assert.ts`
- Test: `scripts/todo-to-issues/assert.test.ts`
- Modify: `scripts/todo-to-issues/main.ts` (add the `verify` command)

**Interfaces:**
- Consumes: `ManifestEntry`
- Produces:
  ```ts
  export type Violation = { rule: string; where: string; detail: string };
  export function checkManifest(manifest: ManifestEntry[]): Violation[];
  ```
  An empty array means the manifest is clear to apply.

**The five gates** (from the spec's Testing section):
1. No public entry carries a `severity:` label or a security/performance/compliance area.
2. No body matches the business-content patterns: `/\bABN\b/`, `/English Street Ventures/i`, `/Lemon Squeezy/i`, `/\bMoR\b/`.
3. No body contains `[[` — every wikilink resolved or degraded.
4. Every entry has exactly one `product:` label and exactly one `area:` label.
5. Counts match the spec: 185 public, 356 private.

- [ ] **Step 1: Write the failing test**

```ts
// scripts/todo-to-issues/assert.test.ts
import { expect, test } from "bun:test";
import { checkManifest } from "./assert";
import type { ManifestEntry } from "./types";

const entry = (over: Partial<ManifestEntry>): ManifestEntry => ({
  sourceFile: "wiki/TODO.md",
  sourceLine: 1,
  section: "Platform",
  subsection: null,
  title: "t",
  body: "",
  repo: "public",
  labels: ["product:shared", "area:feature"],
  findingId: null,
  severity: null,
  issueTitle: "t",
  issueBody: "b",
  epic: "Platform",
  ...over,
});

test("flags a finding routed to the public repo", () => {
  const violations = checkManifest([
    entry({ repo: "public", labels: ["product:osn-core", "area:security", "severity:high"] }),
  ]);
  expect(violations.map((v) => v.rule)).toContain("no-findings-in-public");
});

test("flags business content in a body", () => {
  const violations = checkManifest([
    entry({ issueBody: "invoice via Lemon Squeezy as MoR, ABN 25 693 716 700" }),
  ]);
  expect(violations.map((v) => v.rule)).toContain("no-business-content");
});

test("flags an unresolved wikilink", () => {
  const violations = checkManifest([entry({ issueBody: "see [[nowhere]]" })]);
  expect(violations.map((v) => v.rule)).toContain("no-raw-wikilinks");
});

test("flags a missing or doubled product label", () => {
  expect(
    checkManifest([entry({ labels: ["area:feature"] })]).map((v) => v.rule),
  ).toContain("one-product-label");
  expect(
    checkManifest([entry({ labels: ["product:cire", "product:pulse", "area:feature"] })]).map(
      (v) => v.rule,
    ),
  ).toContain("one-product-label");
});

test("passes a clean manifest", () => {
  expect(checkManifest([entry({})]).filter((v) => v.rule !== "expected-counts")).toEqual([]);
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `bun test scripts/todo-to-issues/assert.test.ts`
Expected: FAIL — `Cannot find module './assert'`

- [ ] **Step 3: Write the gates**

```ts
// scripts/todo-to-issues/assert.ts
import type { ManifestEntry } from "./types";

export type Violation = { rule: string; where: string; detail: string };

const BUSINESS = [/\bABN\b/, /English Street Ventures/i, /Lemon Squeezy/i, /\bMoR\b/];
const PRIVATE_AREAS = ["area:security", "area:performance", "area:compliance"];

export const EXPECTED = { public: 185, private: 356 };

export function checkManifest(manifest: ManifestEntry[]): Violation[] {
  const violations: Violation[] = [];
  const at = (e: ManifestEntry) => `${e.sourceFile}:${e.sourceLine}`;

  for (const entry of manifest) {
    if (
      entry.repo === "public" &&
      (entry.labels.some((l) => l.startsWith("severity:")) ||
        entry.labels.some((l) => PRIVATE_AREAS.includes(l)))
    ) {
      violations.push({
        rule: "no-findings-in-public",
        where: at(entry),
        detail: entry.labels.join(", "),
      });
    }

    const business = BUSINESS.find((p) => p.test(entry.issueBody));
    if (business) {
      violations.push({ rule: "no-business-content", where: at(entry), detail: String(business) });
    }

    if (entry.issueBody.includes("[[")) {
      violations.push({ rule: "no-raw-wikilinks", where: at(entry), detail: entry.issueTitle });
    }

    const products = entry.labels.filter((l) => l.startsWith("product:"));
    if (products.length !== 1) {
      violations.push({ rule: "one-product-label", where: at(entry), detail: products.join(", ") });
    }

    const areas = entry.labels.filter((l) => l.startsWith("area:"));
    if (areas.length !== 1) {
      violations.push({ rule: "one-area-label", where: at(entry), detail: areas.join(", ") });
    }
  }

  for (const repo of ["public", "private"] as const) {
    const actual = manifest.filter((e) => e.repo === repo).length;
    if (actual !== EXPECTED[repo]) {
      violations.push({
        rule: "expected-counts",
        where: repo,
        detail: `expected ${EXPECTED[repo]}, got ${actual}`,
      });
    }
  }

  return violations;
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `bun test scripts/todo-to-issues/assert.test.ts`
Expected: PASS, 5 tests

- [ ] **Step 5: Wire `verify` into the CLI**

In `scripts/todo-to-issues/main.ts`, add the import and the branch:

```ts
import { checkManifest } from "./assert";
```

```ts
  } else if (command === "verify") {
    const violations = checkManifest(await plan());
    if (violations.length === 0) {
      console.log("manifest clear");
    } else {
      for (const v of violations) console.error(`${v.rule}  ${v.where}  ${v.detail}`);
      console.error(`\n${violations.length} violations`);
      process.exit(1);
    }
  } else {
```

- [ ] **Step 6: Run verify against the real manifest and fix what it finds**

Run: `bun run migrate:verify`
Expected: `manifest clear`.

Any `no-findings-in-public` violation is a classifier bug — fix `classify.ts` and add the case to `classify.test.ts`, never suppress the rule. Any `expected-counts` violation means the parse count and the spec disagree; reconcile against `grep -c "^- \[ \]"` before changing the constant.

- [ ] **Step 7: Read five multi-paragraph bodies by hand**

Run:
```bash
bun -e 'const m = await Bun.file(".migration/manifest.json").json();
for (const e of m.filter(x => x.issueBody.length > 1500).slice(0, 5))
  console.log("=".repeat(60) + "\n" + e.issueBody)'
```
Confirm the prose is verbatim — no truncation, code spans intact, links resolved.

- [ ] **Step 8: Commit**

```bash
git add scripts/todo-to-issues/assert.ts scripts/todo-to-issues/assert.test.ts scripts/todo-to-issues/main.ts .migration/manifest.json
git commit -m "feat(scripts): gate the migration manifest on disclosure and shape rules"
```

---

## Task 6: Throttled GitHub writer

The only module that writes. Resumable, throttled, and incapable of deleting.

**Files:**
- Create: `scripts/todo-to-issues/github.ts`
- Test: `scripts/todo-to-issues/github.test.ts`
- Modify: `scripts/todo-to-issues/main.ts` (add `apply --phase N`)

**Interfaces:**
- Consumes: `ManifestEntry`
- Produces:
  ```ts
  export type Created = { number: number; id: string };
  export type Gh = (args: string[], stdin?: string) => Promise<unknown>;
  export function createIssue(gh: Gh, repo: string, e: { title: string; body: string; labels: string[] }): Promise<Created>;
  export function linkSubIssue(gh: Gh, repo: string, parent: number, childId: string): Promise<void>;
  export class Throttle { constructor(minIntervalMs: number); wait(): Promise<void>; }
  ```
  `Gh` is injected so tests never touch the network.

Sub-issue linking uses `POST /repos/{owner}/{repo}/issues/{n}/sub_issues` with `sub_issue_id` — the **node database id**, not the issue number. That is why `createIssue` returns both.

- [ ] **Step 1: Write the failing test**

```ts
// scripts/todo-to-issues/github.test.ts
import { expect, test } from "bun:test";
import { createIssue, linkSubIssue, Throttle } from "./github";

test("creates an issue through gh api and returns number and id", async () => {
  const calls: string[][] = [];
  const gh = async (args: string[]) => {
    calls.push(args);
    return { number: 501, id: 99887766 };
  };
  const created = await createIssue(gh, "xchromo/osn", {
    title: "T",
    body: "B",
    labels: ["product:cire", "area:feature"],
  });
  expect(created).toEqual({ number: 501, id: "99887766" });
  expect(calls[0]).toContain("repos/xchromo/osn/issues");
  expect(calls[0].join(" ")).toContain("--method POST");
  expect(calls[0].join(" ")).toContain("labels[]=product:cire");
});

test("links a sub-issue by database id, not number", async () => {
  const calls: string[][] = [];
  const gh = async (args: string[]) => {
    calls.push(args);
    return {};
  };
  await linkSubIssue(gh, "xchromo/osn", 12, "99887766");
  expect(calls[0].join(" ")).toContain("repos/xchromo/osn/issues/12/sub_issues");
  expect(calls[0].join(" ")).toContain("sub_issue_id=99887766");
});

test("throttle waits at least the minimum interval between calls", async () => {
  const throttle = new Throttle(50);
  const start = Bun.nanoseconds();
  await throttle.wait();
  await throttle.wait();
  expect((Bun.nanoseconds() - start) / 1e6).toBeGreaterThanOrEqual(49);
});

test("no exported function issues a DELETE", async () => {
  const source = await Bun.file("scripts/todo-to-issues/github.ts").text();
  expect(source).not.toContain("DELETE");
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `bun test scripts/todo-to-issues/github.test.ts`
Expected: FAIL — `Cannot find module './github'`

- [ ] **Step 3: Write the writer**

```ts
// scripts/todo-to-issues/github.ts
export type Created = { number: number; id: string };
export type Gh = (args: string[]) => Promise<unknown>;

export class Throttle {
  #last = 0;
  constructor(private readonly minIntervalMs: number) {}
  async wait(): Promise<void> {
    const elapsed = Date.now() - this.#last;
    if (this.#last > 0 && elapsed < this.minIntervalMs) {
      await Bun.sleep(this.minIntervalMs - elapsed);
    }
    this.#last = Date.now();
  }
}

export const ghApi: Gh = async (args) => {
  const proc = Bun.spawn(["gh", "api", ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`gh api failed (${code}): ${err.trim()}`);
  return out.trim() === "" ? {} : JSON.parse(out);
};

export async function createIssue(
  gh: Gh,
  repo: string,
  entry: { title: string; body: string; labels: string[] },
): Promise<Created> {
  const args = [
    `repos/${repo}/issues`,
    "--method",
    "POST",
    "-f",
    `title=${entry.title}`,
    "-f",
    `body=${entry.body}`,
    ...entry.labels.flatMap((label) => ["-f", `labels[]=${label}`]),
  ];
  const result = (await gh(args)) as { number: number; id: number };
  return { number: result.number, id: String(result.id) };
}

export async function linkSubIssue(
  gh: Gh,
  repo: string,
  parent: number,
  childId: string,
): Promise<void> {
  await gh([
    `repos/${repo}/issues/${parent}/sub_issues`,
    "--method",
    "POST",
    "-F",
    `sub_issue_id=${childId}`,
  ]);
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `bun test scripts/todo-to-issues/github.test.ts`
Expected: PASS, 4 tests

- [ ] **Step 5: Add `apply --phase N` to the CLI**

Phases select which sections run, so in-flight work migrates before backlog. Add to `main.ts`:

```ts
import { createIssue, ghApi, linkSubIssue, Throttle } from "./github";

const REPOS = { public: "xchromo/osn", private: "xchromo/osn-tracker" };

const PHASES: Record<string, (e: ManifestEntry) => boolean> = {
  "1": (e) =>
    e.repo === "public" &&
    (e.sourceFile.startsWith("cire/") ||
      ["Up Next", "Landing"].some((s) => e.section.startsWith(s)) ||
      ["OSN Core", "Pulse", "Cire"].some((s) => e.section.startsWith(s))),
  "2": (e) =>
    e.repo === "public" &&
    ["Zap", "Verified Identity", "Platform", "Auth Improvements", "Future"].some((s) =>
      e.section.startsWith(s),
    ),
  "3": (e) => e.repo === "private",
};

async function apply(phase: string): Promise<void> {
  const violations = checkManifest(await plan());
  if (violations.length > 0) throw new Error(`refusing to apply: ${violations.length} violations`);

  const state: Record<string, { number: number; id: string }> =
    (await Bun.file(".migration/created.json")
      .json()
      .catch(() => ({}))) ?? {};
  const select = PHASES[phase];
  if (!select) throw new Error(`unknown phase: ${phase}`);

  const entries = (await plan()).filter(select);
  const throttle = new Throttle(8_000);
  const save = () => Bun.write(".migration/created.json", `${JSON.stringify(state, null, 2)}\n`);
  const key = (e: ManifestEntry) => `${e.sourceFile}:${e.sourceLine}`;

  // Epics first, so every child has a parent to attach to.
  const epics = [...new Set(entries.map((e) => e.epic))];
  for (const epic of epics) {
    const sample = entries.find((e) => e.epic === epic)!;
    const epicKey = `epic:${sample.repo}:${epic}`;
    if (state[epicKey]) continue;
    await throttle.wait();
    state[epicKey] = await createIssue(ghApi, REPOS[sample.repo], {
      title: epic,
      body: `Epic. Migrated from \`${sample.sourceFile}\` — section "${epic}".`,
      labels: ["epic", sample.labels.find((l) => l.startsWith("product:"))!],
    });
    await save();
    console.log(`epic  #${state[epicKey].number}  ${epic}`);
  }

  for (const entry of entries) {
    if (state[key(entry)]) continue;
    await throttle.wait();
    state[key(entry)] = await createIssue(ghApi, REPOS[entry.repo], {
      title: entry.issueTitle,
      body: entry.issueBody,
      labels: entry.labels,
    });
    await save();
    console.log(`issue #${state[key(entry)].number}  ${entry.issueTitle.slice(0, 60)}`);
  }

  for (const entry of entries) {
    const child = state[key(entry)];
    const parent = state[`epic:${entry.repo}:${entry.epic}`];
    if (!child || !parent || state[`link:${key(entry)}`]) continue;
    await throttle.wait();
    await linkSubIssue(ghApi, REPOS[entry.repo], parent.number, child.id);
    state[`link:${key(entry)}`] = child;
    await save();
  }
}
```

and the branch:
```ts
  } else if (command === "apply") {
    await apply(Bun.argv[3] ?? "");
  } else {
```

`.migration/created.json` is the resume record — every write is followed by a save, so a crash costs at most one mutation.

- [ ] **Step 6: Run the full test suite for the script**

Run: `bun run test:migration`
Expected: PASS — all 26 tests across the six test files.

- [ ] **Step 7: Commit**

```bash
git add scripts/todo-to-issues/github.ts scripts/todo-to-issues/github.test.ts scripts/todo-to-issues/main.ts
git commit -m "feat(scripts): throttled resumable GitHub issue writer"
```

---

## Task 7: Phase 0 — repo, labels, Project

The only task that needs the user. Everything here is one-off setup; the runbook records it so it can be redone.

**Files:**
- Create: `wiki/runbooks/github-issues-setup.md`
- Create: `scripts/todo-to-issues/labels.sh`

**Interfaces:**
- Consumes: nothing
- Produces: `xchromo/osn-tracker` (private repo), 19 labels on both repos, the `OSN Platform` Project with three fields and four views.

- [ ] **Step 1: Confirm the token has the project scopes**

Run: `gh auth status`
If `project` and `read:project` are absent, this is the blocking step — the user runs:
```bash
gh auth refresh -h github.com -s project -s read:project
```
Confirm with `gh project list --owner xchromo` (must not error).

- [ ] **Step 2: Create the private tracker**

```bash
gh repo create xchromo/osn-tracker --private \
  --description "Private tracker for OSN security, performance and compliance findings"
```

- [ ] **Step 3: Write the label script**

```bash
# scripts/todo-to-issues/labels.sh
#!/usr/bin/env bash
set -euo pipefail

for repo in xchromo/osn xchromo/osn-tracker; do
  create() { gh label create "$1" --repo "$repo" --color "$2" --description "$3" --force; }

  create "product:osn-core" "1d76db" "OSN identity core"
  create "product:pulse"    "0e8a16" "Pulse events"
  create "product:cire"     "d93f0b" "Cire weddings"
  create "product:zap"      "fbca04" "Zap chat"
  create "product:shared"   "5319e7" "Shared packages and platform"
  create "product:landing"  "c2e0c6" "Marketing sites"

  create "area:feature"     "ededed" "Product work"
  create "area:security"    "b60205" "Security finding"
  create "area:performance" "d4c5f9" "Performance finding"
  create "area:compliance"  "006b75" "Compliance finding"
  create "area:ops"         "bfd4f2" "Deploy, secrets, infrastructure"
  create "area:docs"        "cccccc" "Documentation"
  create "area:schema"      "f9d0c4" "Database schema and migrations"

  create "severity:critical" "b60205" "Blocks deploy"
  create "severity:high"     "d93f0b" "Fix before next release"
  create "severity:medium"   "fbca04" "Schedule into next sprint"
  create "severity:low"      "0e8a16" "Opportunistic fix"
  create "severity:info"     "ededed" "Informational"

  create "epic" "3e4b9e" "Parent issue with sub-issues"
done
```

Run: `chmod +x scripts/todo-to-issues/labels.sh && ./scripts/todo-to-issues/labels.sh`
Expected: 19 labels created per repo (`--force` makes a re-run idempotent).

- [ ] **Step 4: Create the Project and its fields**

```bash
gh project create --owner xchromo --title "OSN Platform"
gh project list --owner xchromo   # note the number, referred to below as $N
```

The project is created public by default for an org — make it private in the UI (Settings → Visibility → Private) **before** any tracker issue is added. This is not optional: a public project leaks private issue titles.

```bash
gh project field-create $N --owner xchromo --name "Status" \
  --data-type SINGLE_SELECT --single-select-options "Backlog,Up Next,In Progress,In Review,Blocked,Done"
gh project field-create $N --owner xchromo --name "Priority" \
  --data-type SINGLE_SELECT --single-select-options "P0,P1,P2,P3"
gh project field-create $N --owner xchromo --name "Effort" \
  --data-type SINGLE_SELECT --single-select-options "XS,S,M,L,XL"
```

- [ ] **Step 5: Configure the two built-in workflows (UI)**

In the Project → Workflows:
1. **Auto-add to project** — enable once per repo, filter `is:issue is:open`, for `xchromo/osn` and `xchromo/osn-tracker`. This is what makes migration cost zero project API calls.
2. **Item added to project** — set `Status` = `Backlog`.

- [ ] **Step 6: Create the four views (UI)**

1. **Board** — layout Board, group by Status.
2. **By product** — layout Table, group by Labels.
3. **Review findings** — layout Table, filter `label:area:security,area:performance,area:compliance`, group by Labels.
4. **Up Next** — layout Board, filter `status:"Up Next","In Progress"`.

- [ ] **Step 7: Write the runbook**

`wiki/runbooks/github-issues-setup.md` records steps 1–6 verbatim, plus: the project number, the tracker repo URL, and the rule that the project stays private. Follow the frontmatter convention used by the other runbooks in that directory (`title`, `description`, `tags`, `related`, `last-reviewed`).

- [ ] **Step 8: Commit**

```bash
git add scripts/todo-to-issues/labels.sh wiki/runbooks/github-issues-setup.md
git commit -m "chore: create the private tracker, labels and OSN Platform project"
```

---

## Task 8: Phase 1 — migrate in-flight work

69 issues. The user asked for incomplete work first; this is that.

**Files:**
- Modify: `.migration/created.json` (generated)

- [ ] **Step 1: Dry-run the phase selection**

```bash
bun -e 'const m = await Bun.file(".migration/manifest.json").json();
const p1 = m.filter(e => e.repo === "public" && (e.sourceFile.startsWith("cire/") ||
  ["Up Next","Landing","OSN Core","Pulse","Cire"].some(s => e.section.startsWith(s))));
console.log(p1.length); console.log([...new Set(p1.map(e => e.epic))].join("\n"))'
```
Expected: `77`, and the epic list covering Up Next, Pulse, OSN Core, Cire, Cire Landing, Landing, plus the six cire shards.

- [ ] **Step 2: Apply**

Run: `bun run scripts/todo-to-issues/main.ts apply 1`
Expected: 85 lines (16 epics + 69 issues), one every 8 seconds — about 11 minutes, then 69 sub-issue links, about 9 minutes more.

If it stops on a secondary-rate-limit error, wait for the next hour and re-run the same command. `.migration/created.json` makes the re-run skip everything already created.

- [ ] **Step 3: Reconcile**

```bash
gh issue list --repo xchromo/osn --limit 200 --json number --jq 'length'
```
Expected: 85 (assuming the repo had no prior open issues; if it did, subtract them).

- [ ] **Step 4: Move the Up Next items in the UI**

Open the Project's Up Next view and set `Status` = `Up Next` on the 10 issues migrated from `## Up Next`. Set `Priority` on them while you are there — this is the only hand-curation in the migration.

- [ ] **Step 5: Commit the resume record**

```bash
git add .migration/created.json
git commit -m "chore: migrate in-flight TODO items to GitHub Issues (phase 1)"
```

---

## Task 9: Phase 2 — migrate planned work

116 issues: Zap, Verified Identity, Platform, Auth Improvements, Future.

- [ ] **Step 1: Apply**

Run: `bun run scripts/todo-to-issues/main.ts apply 2`
Expected: 25 epics + 116 issues + 116 links = 257 mutations. At 8s that is ~35 minutes and it crosses an hour boundary — expect one stop and one re-run.

- [ ] **Step 2: Reconcile**

```bash
gh issue list --repo xchromo/osn --limit 500 --json number --jq 'length'
```
Expected: 226 (85 from phase 1 + 141).

- [ ] **Step 3: Spot-check the sub-issue links**

Open the `Zap` epic on github.com and confirm 39 sub-issues are listed with a progress bar. Confirm no epic exceeds 100 sub-issues.

- [ ] **Step 4: Commit**

```bash
git add .migration/created.json
git commit -m "chore: migrate planned TODO items to GitHub Issues (phase 2)"
```

---

## Task 10: Phase 3 — migrate the backlogs to the private tracker

356 issues. This is the disclosure-sensitive phase.

- [ ] **Step 1: Re-run the gates immediately before applying**

Run: `bun run migrate:verify`
Expected: `manifest clear`. Do not proceed on any violation.

- [ ] **Step 2: Confirm the destination is private**

```bash
gh repo view xchromo/osn-tracker --json isPrivate --jq '.isPrivate'
```
Expected: `true`. If this prints `false`, stop — nothing gets created until it is private.

- [ ] **Step 3: Apply**

Run: `bun run scripts/todo-to-issues/main.ts apply 3`
Expected: 60 epics (Security High/Medium/Low, Performance, Compliance, plus the cire shards) + 356 issues + 356 links = 772 mutations, spread over two hourly windows. Re-run after each stop.

- [ ] **Step 4: Reconcile and confirm nothing leaked**

```bash
gh issue list --repo xchromo/osn-tracker --limit 500 --json number --jq 'length'
gh issue list --repo xchromo/osn --label area:security --json number --jq 'length'
```
Expected: `416` (60 epics + 356 issues) and `0`. The second number being anything but zero is a disclosure incident — close those issues immediately (never delete) and fix the classifier.

- [ ] **Step 5: Commit**

```bash
git add .migration/created.json
git commit -m "chore: migrate review findings to the private tracker (phase 3)"
```

---

## Task 11: Phase 4 — retire the checklists

The markdown is not deleted until the issues exist and reconcile. Narrative wiki pages are untouched.

**Files:**
- Modify: `wiki/TODO.md` (checklists removed, becomes a pointer page)
- Modify: `cire/wiki/TODO.md` (becomes a pointer page)
- Delete: `cire/wiki/todo/*.md` (10 shards)
- Modify: `wiki/changelog/completed-features.md`, `security-fixes.md`, `performance-fixes.md`, `compliance-fixes.md`
- Modify: `wiki/conventions/review-findings.md`

- [ ] **Step 1: Fold the completed items into the changelog**

Extract every `[x]` item and append it to the matching changelog file under a dated heading:

```bash
bun -e 'const md = await Bun.file("wiki/TODO.md").text();
const done = md.split("\n").filter(l => /^- \[x\]/.test(l));
console.log(done.length)'
```
Expected: 233. Route by section — `S-*` to `security-fixes.md`, `P-*` to `performance-fixes.md`, `C-*` to `compliance-fixes.md`, everything else to `completed-features.md`. Append under `## Migrated from TODO.md (2026-08-15)`, converting each `- [x] ` prefix to `- `. Keep the prose verbatim; these are the only surviving record.

- [ ] **Step 2: Replace `wiki/TODO.md` with a pointer page**

Keep the frontmatter, drop every section that held checkboxes, and write:

```markdown
# OSN Project TODO

Tracked work lives in GitHub Issues, not here.

- **Planned work** — [xchromo/osn issues](https://github.com/xchromo/osn/issues)
- **Security, performance and compliance findings** — `xchromo/osn-tracker` (private)
- **Board** — the `OSN Platform` project

Completed items are in [changelog/](changelog/). For how findings are tagged see
[conventions/review-findings.md](conventions/review-findings.md). For the setup itself see
[runbooks/github-issues-setup.md](runbooks/github-issues-setup.md).

(The links above are relative to `wiki/TODO.md`, which is where this block lands.)
```

- [ ] **Step 3: Do the same for cire and delete the shards**

`cire/wiki/TODO.md` becomes the same pointer, filtered to `label:product:cire`. Then:
```bash
git rm cire/wiki/todo/*.md
```

- [ ] **Step 4: Update the review-findings convention**

In `wiki/conventions/review-findings.md`, replace the "Adding to TODO.md" section with "Filing a finding": `gh issue create --repo xchromo/osn-tracker`, the ID leading the title, the severity label, the four-field body unchanged. Keep the rule and restate it for issues:

> - **Never delete** a finding — close the issue instead. The history matters.

Update the `## Related` links: TODO.md is no longer where findings are tracked.

- [ ] **Step 5: Check nothing else points at the deleted files**

```bash
rg -n "wiki/todo/|TODO\.md" --glob '!docs/superpowers/**' --glob '!.migration/**'
```
Fix every hit — `CLAUDE.md` files, `cire/wiki/index.md`, and `contributing.md` are the likely ones.

- [ ] **Step 6: Commit**

```bash
git add -A wiki cire/wiki
git commit -m "docs: retire TODO checklists in favour of GitHub Issues"
```

---

## Task 12: Phase 5 — rewrite the commands

**Files:**
- Modify: `.claude/commands/prep-pr.md` (Step 7 and Step 8)
- Modify: `.claude/commands/new-feat.md` (add an issue step)
- Create: `.github/ISSUE_TEMPLATE/feature.yml`
- Create: `.github/ISSUE_TEMPLATE/review-finding.yml`
- Create: `.github/ISSUE_TEMPLATE/bug.yml`

- [ ] **Step 1: Replace prep-pr Step 7**

Step 7 currently writes findings into `wiki/TODO.md`, checks off completed items, and prunes Up Next. Replace its body with:

```markdown
**Step 7 — File and close issues**

1. **New findings** — for every `S-*` / `P-*` / `C-*` finding the reviews produced that you are *not* fixing on this branch:

   ```bash
   gh issue create --repo xchromo/osn-tracker \
     --title "<FINDING-ID> (<slug>) — <one-line summary>" \
     --label "severity:<critical|high|medium|low|info>" \
     --label "area:<security|performance|compliance>" \
     --label "product:<osn-core|pulse|cire|zap|shared|landing>" \
     --body "$(cat <<'EOF'
   **Issue** — what is wrong or missing
   **Why** — risk and impact
   **Solution** — the concrete fix
   **Rationale** — why this fix is the right one
   EOF
   )"
   ```

   Findings always go to the **private** tracker, never to `xchromo/osn`. Route by kind, not by severity.

2. **Findings you fixed on this branch** — add `Closes #N` to the PR body. Never edit an issue's text to mark it done; the close event is the record.

3. **Planned work discovered** — file it on `xchromo/osn` with `area:feature` and no severity label.

4. **Never delete an issue.** Close it.

5. **Do not touch the narrative wiki's checklists** — there are none left. `wiki/systems/`, `wiki/runbooks/`, `wiki/compliance/` and `wiki/conventions/` are still updated by hand when the change alters what they describe.
```

- [ ] **Step 2: Add the Issues section to prep-pr Step 8**

In the PR body template, after "Decisions & issues", add a mandatory section:

```markdown
## Issues

- Closes #<n> — <finding id or title>
- Opened #<n> — <finding id or title> (deferred)
```

A PR that fixed no findings and opened none still carries the heading with `None.` — the absence should be deliberate, not forgotten.

- [ ] **Step 3: Add the issue step to new-feat**

Insert before the Agent 1A/1B split:

```markdown
**Step 0 — the issue comes first**

If $ARGUMENTS names an issue number, take it: `gh issue view <n> --json title,body`.
Otherwise create one:

```bash
gh issue create --repo xchromo/osn --title "<feature>" \
  --label "product:<...>" --label "area:feature"
```

Derive the branch name from the issue: `feat/<kebab-case-title>`. Move the issue's
Project `Status` to `In Progress`. Report the issue number — `prep-pr` needs it for
the `Closes #N` line.
```

Then change step 2 of Agent 1A and step 2 of Agent 1B to derive the branch from the issue rather than from the description.

- [ ] **Step 4: Write the issue templates**

`.github/ISSUE_TEMPLATE/review-finding.yml` — the four-field format as four required textareas (Issue, Why, Solution, Rationale), plus a required `Finding ID` input and a severity dropdown. Its `labels:` default to `area:security`. Add a top-of-form note: *file review findings on `xchromo/osn-tracker`, not here* — the public template exists so a finding filed in the wrong place is caught by a human before it is submitted.

`feature.yml` — summary, motivation, acceptance criteria; `labels: [area:feature]`.
`bug.yml` — what happened, what was expected, repro steps, environment.

- [ ] **Step 5: Verify the templates render**

```bash
gh api repos/xchromo/osn/contents/.github/ISSUE_TEMPLATE --jq '.[].name'
```
after pushing, or open `https://github.com/xchromo/osn/issues/new/choose`. A YAML error makes the template silently vanish from that page rather than erroring.

- [ ] **Step 6: Run the repo's own gates**

```bash
bun run lint
bun run format
bun run test:migration
```
Expected: clean. No changeset is needed — nothing in a published package changed.

- [ ] **Step 7: Commit**

```bash
git add .claude/commands .github/ISSUE_TEMPLATE
git commit -m "chore: rewrite prep-pr and new-feat around GitHub Issues"
```

---

## Self-Review

**Spec coverage.** Every section maps to a task: two repos → Tasks 2, 7, 10; org Project → Task 7; labels → Tasks 2, 7; epics and sub-issues → Task 6; migration script's six numbered steps → Tasks 1–6; phasing 0–5 → Tasks 7–12; prep-pr rewrite → Task 12; issue templates → Task 12; the spec's five testing gates → Task 5; rollback (delete the markdown last) → Task 11, which runs after Tasks 8–10 reconcile.

**Two spec requirements are deliberately not implemented** and are recorded under "Deviations" above: the `Finding ID` project field, and script-set Status.

**Types.** `Item` → `Classified` → `ManifestEntry` extend one another in `types.ts`; `classify()` returns `Classified`, `buildManifest()` returns `ManifestEntry[]`, `checkManifest()` and `apply()` both consume `ManifestEntry`. `createIssue` returns `{number, id}` where `id` is stringified, and `linkSubIssue` takes that same string. `Gh` is the injection point in both `github.ts` and its test.

**Counts.** 185 public + 356 private = 541. The spec's estimate was 206/344; the parser found fewer public items and more private ones once `# cire/api`-style headings set the section properly and the security backlogs were read whole. Task 4 Step 6 fails loudly if the parser disagrees with 185/356.
