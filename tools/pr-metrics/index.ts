#!/usr/bin/env bun
/**
 * Collect a session-performance card for the current branch and write it to
 * `.claude/metrics/<branch-slug>.json`.
 *
 * The question this exists to answer: where is agent effort going, and which
 * of it was worth spending? A PR that cost 60M tokens is not a problem on its
 * own — a hard task should cost more than an easy one. It is only a problem
 * next to a task that was declared easy before anyone knew what it would cost.
 *
 * That comparison is the whole design, and it constrains the shape of this
 * file in one way worth stating up front: **the card holds one scalar
 * judgement and no others.** `complexity.declared` is set on the issue before
 * work starts. Everything else here — lines changed, files touched, tokens,
 * turns — is recorded raw. There is deliberately no composite "complexity
 * score" computed from the diff, because a single blended number cannot
 * distinguish the two cases that matter most:
 *
 *   - small diff, low declared, huge spend  → waste, the thing we are hunting
 *   - small diff, HIGH declared, huge spend → a hard debug that ended in a
 *                                             one-line fix, which is fine
 *
 * Any formula that folds diff size into a difficulty number collapses those
 * into the same row, and the metric then quietly punishes the hardest
 * legitimate work in the repository. So outliers are a query over raw fields
 * (see `wiki/observability/session-metrics.md`), never a field in here.
 *
 * Data comes from Claude Code's own session transcripts under
 * `~/.claude/projects/<encoded-cwd>/`, which record `gitBranch` on every
 * assistant message. That field is what makes a card possible at all: this
 * repository's rule is one worktree and one branch per task, so branch is a
 * reliable join key from a transcript to a pull request. Subagent spend lives
 * in a sibling `<session-id>/subagents/*.jsonl` directory rather than the main
 * transcript — miss it and a card under-reports by however much was delegated,
 * which on an orchestrated task is most of it.
 */

/** Bump when a field changes meaning or leaves. Readers key off this. */
export const SCHEMA_VERSION = 1;

/**
 * Gaps longer than this are somebody making lunch, not an agent working.
 * `span_seconds` keeps the raw first-to-last figure; `active_seconds` sums
 * per-message gaps with each one capped here, which is the closest this data
 * gets to Claude Code's own `claude_code.active_time.total` OTel metric.
 */
export const IDLE_CAP_SECONDS = 300;

/**
 * USD per million tokens, `[input, output]`. Cache writes bill at 1.25x input
 * (2x for the 1h TTL) and cache reads at 0.1x input.
 *
 * These are list API rates and this repository's work runs on a subscription,
 * so the figure they produce is not a bill. It is a comparable unit of effort
 * across models — which is the only thing a card needs it for. The field is
 * named `usd_equivalent` everywhere for that reason.
 */
export const MODEL_RATES = {
  "claude-opus-5": [5, 25],
  "claude-opus-4-8": [5, 25],
  "claude-opus-4-7": [5, 25],
  "claude-opus-4-6": [5, 25],
  "claude-sonnet-5": [2, 10],
  "claude-sonnet-4-6": [3, 15],
  "claude-haiku-4-5": [1, 5],
  "claude-fable-5": [10, 50],
  "claude-fable-5-1": [10, 50],
} as const satisfies Record<string, readonly [number, number]>;

export type PricedModel = keyof typeof MODEL_RATES;

/**
 * `Object.hasOwn`, never `key in MODEL_RATES` — the house rule in CLAUDE.md,
 * and here it guards a real defect rather than a hypothetical one. Model names
 * arrive from a transcript this script did not write, and `in` walks the
 * prototype chain: `MODEL_RATES["constructor"]` returns `Object`'s constructor,
 * which then destructures to `[undefined, undefined]` and prices the whole card
 * as `NaN`. `hasOwn` sees only the nine real entries.
 */
export function isPricedModel(model: string): model is PricedModel {
  return Object.hasOwn(MODEL_RATES, model);
}

const CACHE_WRITE_5M_MULTIPLIER = 1.25;
const CACHE_WRITE_1H_MULTIPLIER = 2;
const CACHE_READ_MULTIPLIER = 0.1;

export interface TokenTotals {
  input: number;
  output: number;
  thinking: number;
  cache_write_5m: number;
  cache_write_1h: number;
  cache_read: number;
}

export interface Bucket {
  tokens: TokenTotals;
  usd_equivalent: number;
  messages: number;
}

/**
 * The subset of a transcript record this script reads.
 *
 * Every field is optional because these records are external payloads written
 * by a different program at a version this script does not control. A missing
 * field has to mean "absent" rather than throwing, so that one malformed line
 * in a megabyte of transcript costs one message rather than the whole card.
 */
export interface RawUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation?: {
    ephemeral_1h_input_tokens?: number;
    ephemeral_5m_input_tokens?: number;
  };
  output_tokens_details?: { thinking_tokens?: number };
}

/** The tool-call arguments this script looks at; a tool_use carries many more. */
export interface ToolUseInput {
  skill?: string;
  subagent_type?: string;
  file_path?: string;
  command?: string;
}

export interface ContentBlock {
  type?: string;
  name?: string;
  input?: ToolUseInput;
}

export interface SessionRecord {
  type?: string;
  sessionId?: string;
  gitBranch?: string;
  timestamp?: string;
  isSidechain?: boolean;
  isCompactSummary?: boolean;
  effort?: string;
  message?: {
    role?: string;
    model?: string;
    content?: string | ContentBlock[];
    usage?: RawUsage;
  };
  attachment?: { type?: string; prompt?: string };
}

export function emptyTokens(): TokenTotals {
  return {
    input: 0,
    output: 0,
    thinking: 0,
    cache_write_5m: 0,
    cache_write_1h: 0,
    cache_read: 0,
  };
}

function emptyBucket(): Bucket {
  return { tokens: emptyTokens(), usd_equivalent: 0, messages: 0 };
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * Pull the six token counts out of one `usage` object.
 *
 * `cache_creation_input_tokens` is the total and `cache_creation` splits it by
 * TTL. The two bill at different multipliers, so the split is what gets
 * stored; when the breakdown is absent (older transcripts) the whole amount is
 * treated as 5m, which is the cheaper of the two and so under-reports rather
 * than inflates.
 */
export function readUsage(usage: RawUsage | undefined): TokenTotals {
  if (!usage) return emptyTokens();

  const totalCacheWrite = num(usage.cache_creation_input_tokens);
  const oneHour = num(usage.cache_creation?.ephemeral_1h_input_tokens);

  return {
    input: num(usage.input_tokens),
    output: num(usage.output_tokens),
    thinking: num(usage.output_tokens_details?.thinking_tokens),
    cache_write_5m: Math.max(0, totalCacheWrite - oneHour),
    cache_write_1h: oneHour,
    cache_read: num(usage.cache_read_input_tokens),
  };
}

export function addTokens(into: TokenTotals, from: TokenTotals): void {
  into.input += from.input;
  into.output += from.output;
  into.thinking += from.thinking;
  into.cache_write_5m += from.cache_write_5m;
  into.cache_write_1h += from.cache_write_1h;
  into.cache_read += from.cache_read;
}

/**
 * Cost of one message's tokens at its model's rates.
 *
 * An unknown model — one released after this table was written — rates at zero
 * rather than guessing. A card that under-reports a new model is recoverable
 * from the raw token counts, which are always stored; one that invents a rate
 * is not, because nothing downstream can tell the invented figure from a real
 * one. `unpricedModels` on the card names them so the gap is visible.
 */
export function costOf(tokens: TokenTotals, model: string): number {
  if (!isPricedModel(model)) return 0;

  const [inputRate, outputRate] = MODEL_RATES[model];

  return (
    (tokens.input * inputRate +
      tokens.output * outputRate +
      tokens.cache_write_5m * inputRate * CACHE_WRITE_5M_MULTIPLIER +
      tokens.cache_write_1h * inputRate * CACHE_WRITE_1H_MULTIPLIER +
      tokens.cache_read * inputRate * CACHE_READ_MULTIPLIER) /
    1_000_000
  );
}

const EDIT_TOOLS = new Set(["Edit", "Write", "NotebookEdit", "MultiEdit"]);

/**
 * A shell command that writes to a file in the working tree.
 *
 * Counting only `Edit` and `Write` was a real defect, not a gap: this
 * repository's own agent instructions tell agents to make file changes "with
 * sed, heredocs, or short scripts, rather than using the dedicated Read, Edit,
 * or Write tools". In the first 34 cards, 15 pull requests changed real source
 * with **zero** `Edit` calls — so the first-edit boundary never moved and every
 * one of them reported that 100% of its tokens went on exploration. The
 * per-package exploration ranking was then sorted by which branches happened to
 * avoid the Edit tool, which is not a fact about anything.
 *
 * Deliberately conservative — a false positive here moves the boundary too
 * early and under-reports exploration, which is the more misleading direction.
 * `>` and `>>` must name a real path, so `2>&1` and `>/dev/null` do not count.
 * A heredoc feeding an interpreter that writes files from inside the script
 * (`python3 - <<'PY' … open(p,"w") … PY`) is still missed; there is no honest
 * way to see that from the command line alone, and `null` handles it.
 */
export function isFileWritingCommand(command: string): boolean {
  if (/\bsed\s+(-[a-zA-Z]*i|--in-place)\b/.test(command)) return true;
  if (/\btee\s+(?!\/dev\/null)[^\s|;&]+/.test(command)) return true;
  if (/\b(?:mv|cp|install)\s+[^\s|;&]+\s+[^\s|;&]+/.test(command)) return true;

  // A redirect naming a path. `2>&1`, `>&2` and `/dev/null` are excluded, and
  // the target must look like a filename rather than a descriptor.
  return /(?<![0-9&])>>?\s*(?!\/dev\/null\b)(?!&)[\w./~$-]*[\w.-]/.test(command);
}

function isEditingUse(use: ToolUse): boolean {
  if (EDIT_TOOLS.has(use.name)) return true;

  return use.name === "Bash" && typeof use.input.command === "string"
    ? isFileWritingCommand(use.input.command)
    : false;
}

interface ToolUse {
  name: string;
  input: ToolUseInput;
}

function toolUses(record: SessionRecord): ToolUse[] {
  const content = record.message?.content;
  if (!Array.isArray(content)) return [];

  const uses: ToolUse[] = [];
  for (const block of content) {
    if (block !== null && typeof block === "object" && block.type === "tool_use") {
      uses.push({ name: block.name ?? "", input: block.input ?? {} });
    }
  }

  return uses;
}

/**
 * A user record that is a real instruction from the person, not machinery.
 *
 * Transcripts carry a lot of synthetic user turns: tool results, hook output,
 * system reminders, slash-command envelopes. All of those arrive as
 * `role: "user"`. Counting them would make every session look like a
 * conversation and destroy `user_turns` as a measure of how much steering the
 * work needed — which is the one number in the card that measures the prompt
 * rather than the agent. Plain strings that do not open with a tag are the
 * conservative test: it misses a genuine turn that happens to start with `<`
 * and admits none of the machinery.
 */
export function isHumanTurn(record: SessionRecord): boolean {
  return humanTurnText(record) !== null;
}

/**
 * The text of a human instruction, or `null` if this record is not one.
 *
 * Two shapes carry a real prompt, and missing the second one was the original
 * defect here:
 *
 *   - `type: "user"` with string content — a prompt typed at an idle session.
 *   - `type: "attachment"` with `attachment.type === "queued_command"` — a
 *     prompt typed *while the agent was working*.
 *
 * The second shape never appears as a `user` record, and it is precisely what
 * `corrective_turns` exists to count: a message sent mid-flight is by
 * definition a course correction. Reading only `user` records scored every
 * interruption as zero and made the field describe the opposite of what it
 * claims to. Across this repository's own transcripts that was 354 prompts.
 */
export function humanTurnText(record: SessionRecord): string | null {
  if (record.isSidechain) return null;

  if (record.type === "attachment" && record.attachment?.type === "queued_command") {
    const prompt = record.attachment.prompt?.trim();

    return prompt ? prompt : null;
  }

  if (record.type !== "user") return null;

  const content = record.message?.content;
  if (typeof content !== "string") return null;

  const trimmed = content.trim();

  // Tool results, hook output, system reminders and slash-command envelopes all
  // arrive as `role: "user"`. Counting them would make every session look like
  // a conversation and destroy `user_turns` as a measure of steering.
  return trimmed.length > 0 && !trimmed.startsWith("<") ? trimmed : null;
}

export function isCompactionCommand(record: SessionRecord): boolean {
  if (record.isCompactSummary) return true;

  const content = record.message?.content;

  return typeof content === "string" && content.includes("<command-name>/compact</command-name>");
}

export interface SpendSummary {
  usd_equivalent: number;
  tokens: TokenTotals;
  by_model: Record<string, Bucket>;
  by_actor: { main: Bucket; subagent: Bucket };
  effort: Record<string, number>;
  unpriced_models: string[];
}

export function aggregateSpend(records: SessionRecord[]): SpendSummary {
  const total = emptyTokens();
  const byModel: Record<string, Bucket> = {};
  const byActor = { main: emptyBucket(), subagent: emptyBucket() };
  const effort: Record<string, number> = {};
  const unpriced = new Set<string>();
  let usd = 0;

  for (const record of records) {
    if (record.type !== "assistant") continue;

    const model = record.message?.model ?? "unknown";
    const tokens = readUsage(record.message?.usage);
    const cost = costOf(tokens, model);

    if (!isPricedModel(model) && model !== "<synthetic>") unpriced.add(model);

    addTokens(total, tokens);
    usd += cost;

    byModel[model] ??= emptyBucket();
    addTokens(byModel[model].tokens, tokens);
    byModel[model].usd_equivalent += cost;
    byModel[model].messages += 1;

    const actor = record.isSidechain ? byActor.subagent : byActor.main;
    addTokens(actor.tokens, tokens);
    actor.usd_equivalent += cost;
    actor.messages += 1;

    if (record.effort) effort[record.effort] = (effort[record.effort] ?? 0) + 1;
  }

  return {
    usd_equivalent: usd,
    tokens: total,
    by_model: byModel,
    by_actor: byActor,
    effort,
    unpriced_models: [...unpriced].sort(),
  };
}

export interface WindowSummary {
  sessions: number;
  first_ts: string | null;
  last_ts: string | null;
  span_seconds: number;
  active_seconds: number;
  compactions: number;
}

/**
 * Session count, wall span, and active time.
 *
 * Active time is summed per session rather than over the branch as a whole:
 * two sessions a day apart are two short bursts of work, and a single
 * global sort would charge the gap between them to one capped interval.
 */
export function aggregateWindow(records: SessionRecord[]): WindowSummary {
  const bySession = new Map<string, number[]>();
  const all: number[] = [];
  let compactions = 0;

  for (const record of records) {
    if (isCompactionCommand(record)) compactions += 1;
    if (!record.timestamp) continue;

    const at = Date.parse(record.timestamp);
    if (Number.isNaN(at)) continue;

    all.push(at);
    const key = record.sessionId ?? "unknown";
    const stamps = bySession.get(key);
    if (stamps) stamps.push(at);
    else bySession.set(key, [at]);
  }

  if (all.length === 0) {
    return {
      sessions: bySession.size,
      first_ts: null,
      last_ts: null,
      span_seconds: 0,
      active_seconds: 0,
      compactions,
    };
  }

  let active = 0;
  for (const stamps of bySession.values()) {
    stamps.sort((a, b) => a - b);
    for (let i = 1; i < stamps.length; i += 1) {
      active += Math.min((stamps[i] - stamps[i - 1]) / 1000, IDLE_CAP_SECONDS);
    }
  }

  const first = Math.min(...all);
  const last = Math.max(...all);

  return {
    sessions: bySession.size,
    first_ts: new Date(first).toISOString(),
    last_ts: new Date(last).toISOString(),
    span_seconds: Math.round((last - first) / 1000),
    active_seconds: Math.round(active),
    compactions,
  };
}

export interface InteractionSummary {
  user_turns: number;
  corrective_turns: number;
  /** `null` when no session showed an edit the collector could see — unknown,
   *  never "all of it was exploration". */
  tokens_before_first_edit: number | null;
  /** How many sessions contributed to the figure above, so a partial reading
   *  is visible as partial. */
  sessions_with_observed_edit: number;
  tool_calls: Record<string, number>;
  edit_churn: { files_edited_3plus: number; max_edits_one_file: number };
  skills: Record<string, number>;
  subagents: Record<string, number>;
}

/**
 * The half of the card that points at a cause rather than a cost.
 *
 * Two fields here carry most of that weight, one per lever:
 *
 * `tokens_before_first_edit` is what the agent spent working out where the
 * code lives before changing any of it, summed per session so that a second
 * session re-orienting from scratch is counted again rather than hidden behind
 * the first session's answer. Repeatedly high in one area of the repository
 * means that area has no usable map, and the fix is a wiki page or a skill.
 *
 * `corrective_turns` is human turns that arrive after the agent has already
 * started work — course corrections rather than the brief. High means the
 * opening prompt did not carry enough to act on. That is the one number here
 * that measures the person rather than the model.
 */
export function aggregateInteraction(records: SessionRecord[]): InteractionSummary {
  const tools: Record<string, number> = {};
  const skills: Record<string, number> = {};
  const subagents: Record<string, number> = {};
  const editsPerFile = new Map<string, number>();
  const sessionsWithWork = new Set<string>();
  const sessionsPastFirstEdit = new Set<string>();

  // Accumulated per session, not globally, and only banked once that session
  // actually shows an edit. A session that never edited anything the collector
  // could see contributes nothing rather than contributing all of its tokens —
  // "we did not observe the boundary" and "every token was exploration" are
  // very different claims, and only one of them is true.
  const pendingBySession = new Map<string, number>();
  let tokensBeforeFirstEdit = 0;
  let sessionsWithObservedEdit = 0;

  let userTurns = 0;
  let correctiveTurns = 0;

  const ordered = [...records].sort((a, b) => (a.timestamp ?? "").localeCompare(b.timestamp ?? ""));

  // A queued prompt is occasionally echoed as a `user` record once it is
  // dequeued — about 2% of them across this repository's transcripts. Both
  // copies are the same instruction, so the pair is collapsed per session.
  // Only a queued/user duplicate is collapsed, never two `user` records: a
  // person who genuinely types "continue" twice steered twice.
  const queuedTexts = new Map<string, Set<string>>();
  for (const record of ordered) {
    if (record.type !== "attachment") continue;

    const text = humanTurnText(record);
    if (text === null) continue;

    const session = record.sessionId ?? "unknown";
    const seen = queuedTexts.get(session);
    if (seen) seen.add(text);
    else queuedTexts.set(session, new Set([text]));
  }

  for (const record of ordered) {
    const session = record.sessionId ?? "unknown";
    const turnText = humanTurnText(record);

    if (turnText !== null) {
      if (record.type === "user" && queuedTexts.get(session)?.has(turnText)) continue;

      userTurns += 1;
      // Work had already started in this session, so this turn is steering an
      // agent mid-flight rather than opening the task.
      if (sessionsWithWork.has(session)) correctiveTurns += 1;
      continue;
    }

    if (record.type !== "assistant") continue;

    const uses = toolUses(record);
    if (uses.length > 0) sessionsWithWork.add(session);

    if (!record.isSidechain && !sessionsPastFirstEdit.has(session)) {
      const tokens = readUsage(record.message?.usage);
      const spent =
        tokens.input +
        tokens.output +
        tokens.cache_write_5m +
        tokens.cache_write_1h +
        tokens.cache_read;

      pendingBySession.set(session, (pendingBySession.get(session) ?? 0) + spent);
    }

    for (const use of uses) {
      tools[use.name] = (tools[use.name] ?? 0) + 1;

      if (use.name === "Skill") {
        const skill = use.input.skill ?? "unknown";
        skills[skill] = (skills[skill] ?? 0) + 1;
      }

      if (use.name === "Agent") {
        const kind = use.input.subagent_type ?? "general-purpose";
        subagents[kind] = (subagents[kind] ?? 0) + 1;
      }

      if (isEditingUse(use)) {
        if (!record.isSidechain && !sessionsPastFirstEdit.has(session)) {
          sessionsPastFirstEdit.add(session);
          sessionsWithObservedEdit += 1;
          tokensBeforeFirstEdit += pendingBySession.get(session) ?? 0;
        }

        const path = use.input.file_path;
        if (path) editsPerFile.set(path, (editsPerFile.get(path) ?? 0) + 1);
      }
    }
  }

  const counts = [...editsPerFile.values()];

  return {
    user_turns: userTurns,
    corrective_turns: correctiveTurns,
    tokens_before_first_edit: sessionsWithObservedEdit > 0 ? tokensBeforeFirstEdit : null,
    sessions_with_observed_edit: sessionsWithObservedEdit,
    tool_calls: Object.fromEntries(Object.entries(tools).sort((a, b) => b[1] - a[1])),
    edit_churn: {
      files_edited_3plus: counts.filter((n) => n >= 3).length,
      max_edits_one_file: counts.length > 0 ? Math.max(...counts) : 0,
    },
    skills,
    subagents,
  };
}

const WORKSPACE_ROOTS = ["osn", "pulse", "zap", "cire", "shared", "tools"];

export type PathBucket = "generated" | "test" | "docs" | "config" | "source";

/**
 * Sort a changed path into one of five buckets.
 *
 * Order matters and `generated` deliberately wins: `bun.lock` and a Drizzle
 * migration are config- and source-shaped by extension, and counting either as
 * work done would make a lockfile refresh the largest change in the repository.
 * `test` precedes `docs` so a markdown fixture under `tests/` stays a test.
 *
 * Only `source` belongs in a cost-per-line ratio. The rest is context: 800
 * lines of generated migration and 200 lines of wiki are not 300 lines of
 * Effect service, and one undifferentiated total would rank the docs PRs as
 * the most productive work here.
 */
export function classifyPath(path: string): PathBucket {
  if (
    path === "bun.lock" ||
    path.endsWith("/bun.lock") ||
    path.startsWith(".changeset/") ||
    path.includes("/drizzle/") ||
    path.endsWith(".gen.ts") ||
    path.endsWith("SHA256SUMS")
  ) {
    return "generated";
  }

  if (path.startsWith("tests/") || path.includes("/tests/") || path.endsWith(".test.ts")) {
    return "test";
  }

  if (path.startsWith("wiki/") || path.startsWith("docs/") || path.endsWith(".md")) {
    return "docs";
  }

  if (
    path.startsWith(".github/") ||
    path.startsWith(".claude/") ||
    /\.(json|jsonc|toml|ya?ml)$/.test(path)
  ) {
    return "config";
  }

  return "source";
}

export interface LineCount {
  added: number;
  deleted: number;
}

export interface DiffSummary {
  files: Record<PathBucket, number>;
  loc: Record<PathBucket, LineCount>;
  packages: string[];
  touches_migration: boolean;
  commits: number;
}

/**
 * Parse `git diff --numstat`. Binary files report `-` for both counts; they
 * are counted as changed files with zero lines, which is what they are.
 */
export function parseNumstat(numstat: string, commits: number): DiffSummary {
  const buckets: PathBucket[] = ["generated", "test", "docs", "config", "source"];
  const files = Object.fromEntries(buckets.map((b) => [b, 0])) as Record<PathBucket, number>;
  const loc = Object.fromEntries(buckets.map((b) => [b, { added: 0, deleted: 0 }])) as Record<
    PathBucket,
    LineCount
  >;

  const packages = new Set<string>();
  let touchesMigration = false;

  for (const line of numstat.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const [addedRaw, deletedRaw, ...rest] = trimmed.split("\t");
    const path = rest.join("\t");
    if (!path) continue;

    const bucket = classifyPath(path);
    files[bucket] += 1;
    loc[bucket].added += addedRaw === "-" ? 0 : num(Number.parseInt(addedRaw, 10));
    loc[bucket].deleted += deletedRaw === "-" ? 0 : num(Number.parseInt(deletedRaw, 10));

    if (path.includes("/drizzle/") || path.includes("/migrations/")) touchesMigration = true;

    // The workspace globs are `<dir>/*` for the five product directories and
    // for `tools`, so the first two segments name the package. `tools/oxlint`
    // is the one place that resolves to a parent of the real workspace
    // (`tools/oxlint/house`) — still the right grouping for a card.
    const parts = path.split("/");
    if (parts.length >= 2 && WORKSPACE_ROOTS.includes(parts[0])) {
      packages.add(`${parts[0]}/${parts[1]}`);
    }
  }

  return {
    files,
    loc,
    packages: [...packages].sort(),
    touches_migration: touchesMigration,
    commits,
  };
}

/** The five ratings the `complexity:` labels allow. Fibonacci, so that
 * `usd_equivalent ÷ declared` is a real division rather than an ordinal
 * pretending to be a number. */
export const COMPLEXITY_VALUES = [1, 2, 3, 5, 8] as const;

export interface DeclaredComplexity {
  declared: number | null;
  method: "confirmed" | "unconfirmed" | "none";
}

/**
 * Read the declared rating off an issue's labels.
 *
 * The number lives on the issue rather than in the card because it has to be
 * set before work starts — see `wiki/observability/session-metrics.md`. The
 * card only transcribes it.
 *
 * Two labels rather than one: `complexity:unconfirmed` marks a rating no human
 * signed off on, which is most of a backfill. Those stay separable so a query
 * meant to drive a decision can exclude an agent's unreviewed guess. More than
 * one rating label is a labelling mistake, not a value to average — it reads as
 * unrated so the mistake shows up rather than being quietly resolved.
 */
export function declaredFromLabels(labels: string[]): DeclaredComplexity {
  const ratings = labels
    .map((label) => /^complexity:(\d+)$/.exec(label.trim()))
    .filter((match) => match !== null)
    .map((match) => Number.parseInt(match[1], 10))
    .filter((value) => (COMPLEXITY_VALUES as readonly number[]).includes(value));

  if (ratings.length !== 1) return { declared: null, method: "none" };

  const unconfirmed = labels.some((label) => label.trim() === "complexity:unconfirmed");

  return { declared: ratings[0], method: unconfirmed ? "unconfirmed" : "confirmed" };
}

export interface Card {
  schema_version: number;
  pr: {
    number: number | null;
    branch: string;
    base_sha: string | null;
    head_sha: string | null;
    generated_at: string;
    merged_at: string | null;
    phase: "at-open" | "at-merge";
  };
  issue: { number: number | null; type: string | null; labels: string[] };
  complexity: { declared: number | null; method: string };
  window: WindowSummary;
  spend: SpendSummary;
  diff: DiffSummary;
  interaction: InteractionSummary;
}

export interface CardContext {
  branch: string;
  prNumber: number | null;
  issueNumber: number | null;
  issueType: string | null;
  issueLabels: string[];
  declaredComplexity: number | null;
  complexityMethod: string;
  baseSha: string | null;
  headSha: string | null;
  mergedAt: string | null;
  phase: "at-open" | "at-merge";
  generatedAt: string;
}

export function buildCard(records: SessionRecord[], diff: DiffSummary, context: CardContext): Card {
  return {
    schema_version: SCHEMA_VERSION,
    pr: {
      number: context.prNumber,
      branch: context.branch,
      base_sha: context.baseSha,
      head_sha: context.headSha,
      generated_at: context.generatedAt,
      merged_at: context.mergedAt,
      phase: context.phase,
    },
    issue: {
      number: context.issueNumber,
      type: context.issueType,
      labels: context.issueLabels,
    },
    complexity: {
      declared: context.declaredComplexity,
      method: context.complexityMethod,
    },
    window: aggregateWindow(records),
    spend: aggregateSpend(records),
    diff,
    interaction: aggregateInteraction(records),
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** 66_000_000 → "66.0M". Cards run to tens of millions of tokens and a raw
 * digit string at that size is unreadable in a table. */
export function compactTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;

  return String(value);
}

export function humanDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;

  const hours = Math.floor(seconds / 3600);

  return `${hours}h ${Math.round((seconds % 3600) / 60)}m`;
}

function share(part: number, whole: number): string {
  return whole > 0 ? `${Math.round((part / whole) * 100)}%` : "0%";
}

/**
 * The card as a collapsed block for a pull-request body.
 *
 * A `<details>` block rather than a section, and that is a constraint rather
 * than a preference: `prep-pr` permits exactly five `##` headings and checks
 * the count before it finishes, so a sixth would fail a body that is otherwise
 * correct. `<details>` adds no heading.
 *
 * The summary line carries the four figures worth seeing without expanding.
 * "API-equivalent" is spelled out every time because this work runs on a
 * subscription and the number must never be read as a bill.
 */
export function renderDetails(card: Card): string {
  const { spend, diff, interaction, window: session, complexity } = card;
  const tokens = spend.tokens;
  const total =
    tokens.input +
    tokens.output +
    tokens.cache_write_5m +
    tokens.cache_write_1h +
    tokens.cache_read;

  const declared =
    complexity.declared === null
      ? "unrated"
      : `${complexity.declared}${complexity.method === "unconfirmed" ? " (unconfirmed)" : ""}`;

  const source = `+${diff.loc.source.added}/-${diff.loc.source.deleted}`;
  const models = Object.entries(spend.by_model)
    .sort((a, b) => b[1].usd_equivalent - a[1].usd_equivalent)
    .map(([model, bucket]) => `${model} (${share(bucket.usd_equivalent, spend.usd_equivalent)})`)
    .join(", ");

  const rows: [string, string][] = [
    ["Cost (API-equivalent)", `$${spend.usd_equivalent.toFixed(2)}`],
    [
      "Tokens",
      `${compactTokens(total)} — out ${compactTokens(tokens.output)} · cache-w ${compactTokens(
        tokens.cache_write_5m + tokens.cache_write_1h,
      )} · cache-r ${compactTokens(tokens.cache_read)} (${share(tokens.cache_read, total)})`,
    ],
    ["Models", models || "—"],
    ["Active time", `${humanDuration(session.active_seconds)} over ${session.sessions} session(s)`],
    ["Declared complexity", declared],
    [
      "Source diff",
      `${source} across ${diff.files.source} file(s), ${diff.packages.length} package(s)`,
    ],
    ["Turns", `${interaction.user_turns} (${interaction.corrective_turns} corrective)`],
    [
      "Before first edit",
      interaction.tokens_before_first_edit === null
        ? "not observed (no edit seen in the transcript)"
        : `${compactTokens(interaction.tokens_before_first_edit)} (${share(
            interaction.tokens_before_first_edit,
            total,
          )})`,
    ],
    [
      "Subagents",
      Object.keys(interaction.subagents).length === 0
        ? "none"
        : `${Object.entries(interaction.subagents)
            .map(([kind, n]) => `${n}× ${kind}`)
            .join(
              ", ",
            )} (${share(spend.by_actor.subagent.usd_equivalent, spend.usd_equivalent)} of spend)`,
    ],
  ];

  const summary =
    `Session metrics — $${spend.usd_equivalent.toFixed(2)} · ${compactTokens(total)} tok · ` +
    `complexity ${declared} · ${source} source`;

  return [
    `<details><summary>${summary}</summary>`,
    "",
    "| | |",
    "|---|---|",
    ...rows.map(([label, value]) => `| ${label} | ${value} |`),
    "",
    `<sub>Card: \`.claude/metrics/${branchSlug(card.pr.branch)}.json\` · phase \`${card.pr.phase}\` · [schema](../blob/main/wiki/observability/session-metrics.md)</sub>`,
    "</details>",
  ].join("\n");
}

/**
 * `feat/pr-session-metrics` → `feat-pr-session-metrics`.
 *
 * One file per branch, never one appended ledger: several branches are open at
 * once here and every one of them would rewrite the same tail of a shared
 * file, so a ledger conflicts on every concurrent PR. A branch only ever
 * writes its own name.
 */
export function branchSlug(branch: string): string {
  return branch.replace(/[^a-zA-Z0-9._-]/g, "-").replace(/^-+|-+$/g, "") || "unknown";
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function readSessionRecords(sessionsDir: string, branch: string): SessionRecord[] {
  const roots = [`${sessionsDir}/*/*.jsonl`, `${sessionsDir}/*/*/subagents/*.jsonl`];
  const records: SessionRecord[] = [];

  for (const pattern of roots) {
    const found = Bun.spawnSync(["sh", "-c", `ls -1 ${pattern} 2>/dev/null || true`], {
      stdout: "pipe",
    });

    for (const file of found.stdout.toString().split("\n").filter(Boolean)) {
      let text: string;
      try {
        text = require("node:fs").readFileSync(file, "utf8") as string;
      } catch {
        continue;
      }

      for (const line of text.split("\n")) {
        // Cheap reject before the parse: these files run to megabytes and the
        // overwhelming majority of lines belong to other branches.
        if (!line.includes(branch)) continue;

        let record: SessionRecord;
        try {
          record = JSON.parse(line) as SessionRecord;
        } catch {
          continue;
        }

        if (record.gitBranch === branch) records.push(record);
      }
    }
  }

  return records;
}

function git(args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { stdout: "pipe", stderr: "pipe" });

  return result.success ? result.stdout.toString().trim() : "";
}

function flag(name: string): string | null {
  const index = Bun.argv.indexOf(`--${name}`);

  return index >= 0 && Bun.argv[index + 1] ? Bun.argv[index + 1] : null;
}

if (import.meta.main) {
  const branch = flag("branch") ?? git(["rev-parse", "--abbrev-ref", "HEAD"]);

  if (!branch || branch === "HEAD") {
    console.error("❌ pr-metrics: could not resolve a branch name. Pass --branch.");
    process.exit(1);
  }

  if (branch === "main") {
    console.error("❌ pr-metrics: refusing to card `main` — a card describes one task's branch.");
    process.exit(1);
  }

  const sessionsDir = flag("sessions-dir") ?? `${process.env.HOME}/.claude/projects`;
  const base = flag("base") ?? "origin/main";
  const records = readSessionRecords(sessionsDir, branch);

  const numstat = git(["diff", "--numstat", `${base}...HEAD`]);
  const commits = git(["rev-list", "--count", `${base}..HEAD`]);
  const diff = parseNumstat(numstat, Number.parseInt(commits, 10) || 0);

  const issueLabels = (flag("issue-labels") ?? "").split(",").filter(Boolean);

  // The labels are the normal source — `prep-pr` passes whatever the issue
  // carries and the rating comes along with them, so nobody has to retype a
  // number the issue already holds. `--complexity` stays as an override for a
  // branch with no issue, and it is recorded as `manual` so a hand-typed
  // rating never sits in a query beside one an owner confirmed on an issue.
  const fromLabels = declaredFromLabels(issueLabels);
  const override = flag("complexity");

  const card = buildCard(records, diff, {
    branch,
    prNumber: flag("pr") ? Number.parseInt(flag("pr") as string, 10) : null,
    issueNumber: flag("issue") ? Number.parseInt(flag("issue") as string, 10) : null,
    issueType: flag("issue-type"),
    issueLabels,
    declaredComplexity: override ? Number.parseInt(override, 10) : fromLabels.declared,
    complexityMethod: flag("complexity-method") ?? (override ? "manual" : fromLabels.method),
    baseSha: git(["rev-parse", base]) || null,
    headSha: git(["rev-parse", "HEAD"]) || null,
    mergedAt: flag("merged-at"),
    phase: flag("phase") === "at-merge" ? "at-merge" : "at-open",
    generatedAt: new Date().toISOString(),
  });

  // `--format markdown` prints the `<details>` block on stdout and writes
  // nothing, so `prep-pr` can append it to a body without a temporary file and
  // without the warnings below landing in the middle of the markdown.
  if (flag("format") === "markdown") {
    console.log(renderDetails(card));
    process.exit(0);
  }

  const outDir = flag("out-dir") ?? ".claude/metrics";
  const outPath = `${outDir}/${branchSlug(branch)}.json`;
  require("node:fs").mkdirSync(outDir, { recursive: true });
  require("node:fs").writeFileSync(outPath, `${JSON.stringify(card, null, 2)}\n`);

  if (records.length === 0) {
    console.warn(
      `⚠️  pr-metrics: no session records matched branch \`${branch}\` under ${sessionsDir}.`,
    );
    console.warn("   The card still carries the diff; spend and interaction are zero.");
  }

  if (card.spend.unpriced_models.length > 0) {
    console.warn(
      `⚠️  pr-metrics: no rate for ${card.spend.unpriced_models.join(", ")} — cost excludes it.`,
    );
    console.warn("   Add it to MODEL_RATES in tools/pr-metrics/index.ts.");
  }

  console.log(`✅ pr-metrics: wrote ${outPath}`);
  console.log(
    `   $${card.spend.usd_equivalent.toFixed(2)} · ${card.window.sessions} session(s) · ` +
      `+${card.diff.loc.source.added}/-${card.diff.loc.source.deleted} source · ` +
      `${card.interaction.user_turns} turn(s)`,
  );
}
