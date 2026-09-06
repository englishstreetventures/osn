import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
const pluginEntry = join(packageDirectory, "index.ts");

/** One oxlint diagnostic, cut down to the fields these tests assert on. */
type Diagnostic = {
  message: string;
  code: string;
  filename: string;
  labels: { span: { line: number } }[];
};

/**
 * Fixtures, keyed by file name. The rule is purely syntactic, so a fixture only
 * has to parse — nothing here is type-checked or executed. This test enables the
 * rule directly (not through the `cire/**\/*-store.ts` path override in the
 * real oxlintrc.json), since that path-scoping is oxlint's job, not the
 * rule's — the acceptance check in the task exercises the real config instead.
 *
 * A fixture earns its place by pinning a decision (see
 * wiki/conventions/testing-patterns.md). Every fixture below says, in its own
 * comment, whether it is expected to report and why.
 */
const fixtures = {
  // A `peekCachedXxx` function declaration, copied from tasks-store.ts. Its
  // non-subscribing read is deliberate — must not be reported.
  "peek-function-declaration.ts": `
const cache = new Map();
export function peekCachedTasks(weddingId) {
	return cache.get(weddingId)?.tasks() ?? null;
}
`,
  // Same shape, but the function is a const-bound arrow, not a declaration —
  // exercises the VariableDeclarator naming path. Must not be reported.
  "peek-arrow-const.ts": `
const cache = new Map();
export const peekCachedTasks = (weddingId) => cache.get(weddingId)?.tasks() ?? null;
`,
  // A `hasCachedXxx` predicate, copied from tasks-store.ts. Also deliberate —
  // must not be reported.
  "has-cached.ts": `
const cache = new Map();
export function hasCachedTasks(weddingId) {
	return cache.get(weddingId)?.tasks() != null;
}
`,
  // The non-subscribing read sits inside an anonymous callback (\`.map\`)
  // nested inside a peekCached* function — the enclosing NAMED function is
  // still peekCached*, and that function is itself top-level exported, so
  // this must not be reported either.
  "peek-nested-callback.ts": `
const cache = new Map();
export function peekCachedTaskLists(weddingIds) {
	return weddingIds.map((weddingId) => cache.get(weddingId)?.tasks() ?? null);
}
`,
  // The subscribing form, \`entryFor(id).accessor()\` — never flagged, this
  // is the fix the message points readers toward. Must not be reported.
  "subscribing-form.ts": `
const cache = new Map();
function entryFor(weddingId) {
	let entry = cache.get(weddingId);
	if (!entry) {
		entry = { tasks: () => null };
		cache.set(weddingId, entry);
	}
	return entry;
}
export function tasksAccessor(weddingId) {
	return entryFor(weddingId).tasks;
}
`,
  // A map that isn't literally named \`cache\` — the rule matches by name, not
  // structurally, so this must not be reported.
  "different-map-name.ts": `
const otherMap = new Map();
export function readSomething(weddingId) {
	return otherMap.get(weddingId)?.tasks() ?? null;
}
`,
  // The shape the three broken readers actually shipped with — a "Reactive"
  // exported function reading through the non-minting optional chain, copied
  // from tasks-store.ts's \`openTaskCount\`. Must be reported, at the
  // \`cache.get(weddingId)?.tasks()\` call on line 4.
  "broken-reader.ts": `
const cache = new Map();
export function openTaskCount(weddingId) {
	const rows = cache.get(weddingId)?.tasks() ?? null;
	if (rows == null) return null;
	return rows.filter((t) => t.status === "open").length;
}
`,
  // Same bug, but the non-subscribing read sits inside an anonymous callback
  // nested inside a function that is NOT peekCached*/hasCached* — the walk
  // past the anonymous callback must still find \`summarize\` and report, at
  // the \`cache.get(weddingId)?.tasks()\` call on line 4.
  "broken-nested-callback.ts": `
const cache = new Map();
export function summarize(weddingIds) {
	return weddingIds.map((weddingId) => cache.get(weddingId)?.tasks() ?? null);
}
`,
  // Item 1's escape: the read is split across two statements instead of
  // written as one direct chain — \`entry\` is bound by
  // \`const entry = cache.get(...)\` and then read with an optional chain.
  // Identical bug to the direct-chain form (this is the real shape
  // patchCachedEvent's sibling readers would take if broken), and the shape
  // the rule used to miss entirely. Must be reported, at the
  // \`entry?.tasks()\` call on line 6.
  "intermediate-variable-broken.ts": `
const cache = new Map();
export function openTaskCount(weddingId) {
	const entry = cache.get(weddingId);
	return entry?.tasks() ?? null;
}
`,
  // The non-optional intermediate-variable read, guarded by a preceding
  // \`if (!entry) return\` instead of an optional chain — the guard is what
  // stands between a cold cache and a crash, and it bails out before
  // \`tasks\` ever runs, so this is the same non-subscribing bug written
  // without \`?.\`. Must be reported, at the \`entry.tasks()\` call on line 6.
  "guarded-non-optional-broken.ts": `
const cache = new Map();
export function readAfterGuard(weddingId) {
	const entry = cache.get(weddingId);
	if (!entry) return null;
	return entry.tasks();
}
`,
  // patchCachedEvent's real shape: the same guarded intermediate-variable
  // pattern as guarded-non-optional-broken.ts, but the call is a SETTER
  // (takes an argument) rather than a getter. It writes, it doesn't read, so
  // it never needed to subscribe in the first place. Zero-argument arity is
  // what tells the two apart here. Must not be reported.
  "intermediate-variable-guarded-setter.ts": `
const cache = new Map();
export function patchCachedEvent(weddingId, patch) {
	const entry = cache.get(weddingId);
	if (!entry) return;
	entry.setEvents((rows) => (rows == null ? rows : patch(rows)));
}
`,
  // Item 3's first escape: the nearest enclosing NAMED function is
  // \`peekCachedRows\`, but it's a local arrow declared INSIDE
  // \`openTaskCount\` — not a top-level exported function — so the exemption
  // must not reach it. Must be reported, at the
  // \`cache.get(weddingId)?.tasks()\` call on line 5.
  "nested-peek-arrow-broken.ts": `
const cache = new Map();
export function openTaskCount(weddingId) {
	const peekCachedRows = () => cache.get(weddingId)?.tasks();
	return peekCachedRows()?.length ?? null;
}
`,
  // Item 3's second escape: the name matches the anchored exemption regex
  // (\`peekCached\` followed by a capital) and the function IS exported at
  // module top level, so this legitimately reads as one of the two allowed
  // shapes to a purely syntactic, name-based check — even though the
  // "...Reactively" suffix suggests the author actually wanted a subscribing
  // read. Telling those apart would mean reading the function's body against
  // its own name, which this rule doesn't attempt. Known limit, not a bug:
  // must not be reported.
  "peek-cached-reactively-name-heuristic.ts": `
const cache = new Map();
export function peekCachedTasksReactively(weddingId) {
	return cache.get(weddingId)?.tasks() ?? null;
}
`,
  // Known limit: the rule matches the literal identifier \`cache\`, not an
  // alias of it — \`c\` is never traced back to \`cache\`. Catching this would
  // need a small alias-tracking pass the rule doesn't do. Must not be
  // reported.
  "known-limit-aliased-cache.ts": `
const cache = new Map();
export function readViaAlias(weddingId) {
	const c = cache;
	return c.get(weddingId)?.tasks() ?? null;
}
`,
  // Known limit: the rule only matches a non-computed accessor
  // (\`cache.get(id)?.tasks()\`), not a computed one
  // (\`cache.get(id)?.["tasks"]()\`). Special-casing a string-literal computed
  // key without also matching genuinely dynamic ones is a separate piece of
  // work. Must not be reported.
  "known-limit-computed-accessor.ts": `
const cache = new Map();
export function readViaComputedAccessor(weddingId) {
	return cache.get(weddingId)?.["tasks"]() ?? null;
}
`,
} as const;

let fixtureDirectory: string;

/** Run oxlint over the fixture directory with only the house rule enabled. */
function lintFixtures(): Diagnostic[] {
  const result = Bun.spawnSync({
    cmd: [
      "bunx",
      "--bun",
      "oxlint",
      "-c",
      join(fixtureDirectory, "oxlintrc.json"),
      "--format=json",
      ".",
    ],
    cwd: fixtureDirectory,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = result.stdout.toString();
  const parsed: { diagnostics?: Diagnostic[] } = JSON.parse(stdout);
  return parsed.diagnostics ?? [];
}

/** The fixture file names the rule reported, deduplicated and sorted. */
function reportedFiles(diagnostics: Diagnostic[]): string[] {
  return [...new Set(diagnostics.map((d) => d.filename.split("/").at(-1) ?? ""))].toSorted();
}

/** The single diagnostic reported against `filename`, or `undefined`. */
function diagnosticFor(diagnostics: Diagnostic[], filename: string): Diagnostic | undefined {
  return diagnostics.find((d) => d.filename.endsWith(filename));
}

describe("house/no-non-subscribing-store-read", () => {
  let diagnostics: Diagnostic[];

  beforeAll(() => {
    fixtureDirectory = mkdtempSync(join(tmpdir(), "house-store-read-"));
    writeFileSync(
      join(fixtureDirectory, "oxlintrc.json"),
      JSON.stringify({
        plugins: [],
        categories: { correctness: "off" },
        rules: { "house/no-non-subscribing-store-read": "error" },
        jsPlugins: [{ name: "house", specifier: pluginEntry }],
      }),
    );
    for (const [name, source] of Object.entries(fixtures)) {
      writeFileSync(join(fixtureDirectory, name), source);
    }
    diagnostics = lintFixtures();
  });

  afterAll(() => {
    rmSync(fixtureDirectory, { recursive: true, force: true });
  });

  it("reports exactly the broken fixtures, one diagnostic each", () => {
    expect(diagnostics.length).toBe(5);
    expect(reportedFiles(diagnostics)).toEqual([
      "broken-nested-callback.ts",
      "broken-reader.ts",
      "guarded-non-optional-broken.ts",
      "intermediate-variable-broken.ts",
      "nested-peek-arrow-broken.ts",
    ]);
  });

  it("stays silent on every deliberate, exempt, or known-limit fixture", () => {
    const silent = [
      "peek-function-declaration.ts",
      "peek-arrow-const.ts",
      "has-cached.ts",
      "peek-nested-callback.ts",
      "subscribing-form.ts",
      "different-map-name.ts",
      "intermediate-variable-guarded-setter.ts",
      "peek-cached-reactively-name-heuristic.ts",
      "known-limit-aliased-cache.ts",
      "known-limit-computed-accessor.ts",
    ];
    for (const filename of silent) {
      expect(diagnosticFor(diagnostics, filename)).toBeUndefined();
    }
  });

  it("reports the direct-chain broken readers at the read, not the declaration", () => {
    expect(diagnosticFor(diagnostics, "broken-reader.ts")?.labels[0]?.span.line).toBe(4);
    expect(diagnosticFor(diagnostics, "broken-nested-callback.ts")?.labels[0]?.span.line).toBe(4);
  });

  it("reports the intermediate-variable escape (item 1) at the split read", () => {
    expect(
      diagnosticFor(diagnostics, "intermediate-variable-broken.ts")?.labels[0]?.span.line,
    ).toBe(5);
  });

  it("reports the guarded non-optional read at the guarded call", () => {
    expect(diagnosticFor(diagnostics, "guarded-non-optional-broken.ts")?.labels[0]?.span.line).toBe(
      6,
    );
  });

  it("reports the nested-local-function escape (item 3) at the read, not the declaration", () => {
    expect(diagnosticFor(diagnostics, "nested-peek-arrow-broken.ts")?.labels[0]?.span.line).toBe(4);
  });

  it("names the accessor and points at the subscribing entryFor(...) form", () => {
    const message = diagnosticFor(diagnostics, "broken-reader.ts")?.message;
    expect(message).toContain("cache.get(weddingId)?.tasks()");
    expect(message).toContain("entryFor(weddingId).tasks()");
    expect(message).toContain("peekCached*");
    expect(message).toContain("hasCached*");
  });

  it("reports under the plugin's rule id", () => {
    expect(diagnostics.every((d) => d.code === "house(no-non-subscribing-store-read)")).toBe(true);
  });
});
