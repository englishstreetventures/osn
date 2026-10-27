#!/usr/bin/env bun
/**
 * Collect a session-performance card for the current branch and write it to
 * `.claude/metrics/<branch-slug>.json`, or `<branch-slug>-<pr>.json` when an
 * earlier pull request already used the branch name.
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
 * (see `wiki/conventions/session-metrics.md`), never a field in here.
 *
 * Data comes from Claude Code's own session transcripts under
 * `~/.claude/projects/<encoded-cwd>/`, which record `gitBranch` on every
 * assistant message. That field is what makes a card possible at all: this
 * repository's rule is one worktree and one branch per task, so branch is a
 * reliable join key from a transcript to a pull request while no branch name is
 * used twice. `new-feat` checks a name is unused before cutting it. Where a name
 * was used twice anyway, the merges split its records (`recordWindow`), and the
 * CLI never writes over a card that names another pull request.
 *
 * Subagent spend lives in a sibling `<session-id>/subagents/*.jsonl` directory
 * rather than the main transcript — miss it and a card under-reports by however
 * much was delegated, which on an orchestrated task is most of it. Agents a
 * Workflow run starts write one level deeper, under
 * `subagents/workflows/<run-id>/agent-*.jsonl`.
 *
 * `SCHEMA_VERSION` is bumped whenever a field changes meaning or leaves.
 * Readers key off this.
 */

import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync } from "node:fs";
import { posix } from "node:path";

import { compactTokens, humanDuration } from "./format.ts";

/** 4: `interaction.corrective_turns` counts only the prompts a person sent while
 * the agent was still working; before 4 it counted every human turn after the
 * session's first tool call, and readers treat an older card's count as
 * unknown. 3: `complexity.declared` is the sum of the ratings of every issue in
 * this repository the pull request closes, and `complexity.issues` counts them.
 * A card before version 3 has one issue's rating in `declared`. */
export const SCHEMA_VERSION = 4;

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
  "claude-opus-5-5": [4, 20],
  "claude-opus-5": [5, 25],
  "claude-opus-4-8": [5, 25],
  "claude-opus-4-7": [5, 25],
  "claude-opus-4-6": [5, 25],
  "claude-sonnet-5-5": [2, 10],
  "claude-sonnet-5": [2, 10],
  "claude-sonnet-4-6": [3, 15],
  "claude-haiku-5-5": [0.1, 0.5],
  "claude-haiku-4-5": [1, 5],
  "claude-fable-5": [10, 50],
  "claude-fable-5-1": [10, 50],
} as const satisfies Record<string, readonly [number, number]>;

export type PricedModel = keyof typeof MODEL_RATES;

/** A transcript names a model either bare (`claude-opus-5`) or with the
 * snapshot date appended (`claude-haiku-4-5-20251001`). Both are the same model
 * at the same rates, so the date comes off before the table is consulted. */
const MODEL_SNAPSHOT_SUFFIX = /-\d{8}$/;

/**
 * The rate-table key for a model name, or `null` when the table has no entry.
 *
 * `Object.hasOwn`, never `key in MODEL_RATES` — the house rule in CLAUDE.md,
 * and here it guards a real defect rather than a hypothetical one. Model names
 * arrive from a transcript this script did not write, and `in` walks the
 * prototype chain: `MODEL_RATES["constructor"]` returns `Object`'s constructor,
 * which then destructures to `[undefined, undefined]` and prices the whole card
 * as `NaN`. `hasOwn` sees only the table's own entries.
 */
export function rateKeyFor(model: string): PricedModel | null {
  const bare = model.replace(MODEL_SNAPSHOT_SUFFIX, "");

  return Object.hasOwn(MODEL_RATES, bare) ? (bare as PricedModel) : null;
}

export function isPricedModel(model: string): boolean {
  return rateKeyFor(model) !== null;
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
  /** The dispatch prompt. Carries the `TASK-BRANCH:` marker that
   * `resolveDispatchBranch` reads. */
  prompt?: string;
}

export interface ContentBlock {
  type?: string;
  name?: string;
  /** Present on `tool_use` blocks; pairs with a subagent's `meta.toolUseId`. */
  id?: string;
  input?: ToolUseInput;
}

export interface SessionRecord {
  type?: string;
  sessionId?: string;
  gitBranch?: string;
  /** Stable per API call. The dedupe key: one conversation is sometimes
   * written into two session files, and both copies carry this. */
  requestId?: string;
  uuid?: string;
  timestamp?: string;
  isSidechain?: boolean;
  /** Set on records the harness injects into the conversation, never on a typed prompt. */
  isMeta?: boolean;
  isCompactSummary?: boolean;
  effort?: string;
  /** How this session was started. `cli` is a person at a terminal; an `sdk-*`
   * value is a session some program drove, and the prompts in one were written
   * by that program rather than typed. Absent on transcripts written before the
   * field existed. */
  entrypoint?: string;
  message?: {
    role?: string;
    model?: string;
    content?: string | ContentBlock[];
    usage?: RawUsage;
  };
  attachment?: {
    type?: string;
    prompt?: string;
    /** On a `queued_command`: `prompt` for typed text, `task-notification`
     * for a background task's report. Absent on older transcripts. */
    commandMode?: string;
    /** On a `queued_command`: who sent it. `human` is a person;
     * `task-notification`, `peer` and `coordinator` are the harness or another
     * agent. Absent on older transcripts. */
    origin?: { kind?: string };
    /** Set by the harness on a queued prompt a person typed. */
    humanTurn?: boolean;
  };
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
  const key = rateKeyFor(model);

  if (key === null) return 0;

  const [inputRate, outputRate] = MODEL_RATES[key];

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
 * Two shapes carry a real prompt:
 *
 *   - `type: "user"` with string content — a prompt typed at an idle session.
 *   - `type: "attachment"` with `attachment.type === "queued_command"` — a
 *     prompt typed *while the agent was working*.
 *
 * The second shape never appears as a `user` record, and it is the whole of
 * what `corrective_turns` counts. Background task reports, subagent hand-backs
 * and harness notices arrive in it too, so a queued record is a person's only
 * when {@link queuedByPerson} says the harness labelled it so.
 *
 * Both shapes are then filtered the same way, by {@link humanText} for a
 * machine record wearing a prompt's clothes and by {@link isMachineDriven} for
 * a whole session a program started. A turn survives only if a person could
 * have typed it.
 */
export function humanTurnText(record: SessionRecord): string | null {
  if (record.isSidechain) return null;
  if (isMachineDriven(record)) return null;

  if (record.type === "attachment" && record.attachment?.type === "queued_command") {
    return queuedByPerson(record.attachment) ? humanText(record.attachment.prompt) : null;
  }

  if (record.type !== "user") return null;
  // Hook feedback ("Stop hook feedback: …") and a subagent's hand-back
  // ("Another Claude session sent a message: …") arrive as plain-text user
  // records that open with no tag, so only this flag tells them from a person.
  if (record.isMeta) return null;

  const content = record.message?.content;

  return typeof content === "string" ? humanText(content) : null;
}

/**
 * A prompt, or `null` if it is machinery wearing a prompt's clothes.
 *
 * Tool results, hook output, system reminders, slash-command envelopes,
 * subagent hand-backs and task notifications all reach the transcript in a
 * record a person could have written, and every one of them opens with a tag.
 * Both shapes `humanTurnText` reads need this: a queued `<agent-message>` or
 * `<task-notification>` let through would count as an interruption on
 * `corrective_turns`.
 *
 * The bias is not random. Those records arrive in proportion to how many
 * background subagents a session runs, which is what `orchestrate` and
 * `prep-pr` tell it to do.
 */
function humanText(raw: string | undefined): string | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith("<")) return null;

  // A subagent hand-back or task notification can also arrive as a plain
  // `user` record that opens with prose before its block. Only the block's
  // position decides it, so a person who quotes the tag mid-sentence still
  // counts.
  if (MACHINE_PREFIX.test(trimmed)) return null;

  return trimmed;
}

const MACHINE_PREFIX =
  /^(?:Another Claude session sent a message:\s*)?<(?:agent-message|task-notification)\b/;

/** The `origin.kind` values a queued record is known to carry. Only `human` is a person. */
const KNOWN_QUEUE_ORIGINS = new Set(["human", "task-notification", "peer", "coordinator"]);

/**
 * Whether the harness labelled a queued record as one a person typed.
 *
 * An allow-list: where the record names its sender, only `human` (or the
 * harness's own `humanTurn` mark) is a person, so a sender added later is left
 * out rather than counted — and {@link unknownQueuedOrigins} names it, so the
 * CLI can say so. A transcript older than the label falls back on
 * `commandMode`, where only `prompt` is typed text, and one with neither keeps
 * the tag test alone.
 */
function queuedByPerson(attachment: NonNullable<SessionRecord["attachment"]>): boolean {
  if (attachment.humanTurn === true) return true;
  if (attachment.origin) return attachment.origin.kind === "human";

  return attachment.commandMode === undefined || attachment.commandMode === "prompt";
}

/**
 * The senders of main-thread queued records that {@link queuedByPerson}
 * dropped only because it did not know them, each named once.
 *
 * Those records count nowhere, so a harness that starts labelling a person's
 * prompt with a new kind would make every card read no interruptions. A
 * non-empty answer is the CLI's cue to warn.
 */
export function unknownQueuedOrigins(records: SessionRecord[]): string[] {
  const kinds = new Set<string>();

  for (const record of records) {
    const attachment = record.attachment;
    if (record.isSidechain || attachment?.type !== "queued_command") continue;
    if (attachment.humanTurn === true || !attachment.origin) continue;

    const kind = attachment.origin.kind ?? "(none)";
    if (!KNOWN_QUEUE_ORIGINS.has(kind)) kinds.add(kind);
  }

  return [...kinds].toSorted();
}

/**
 * Whether a program, rather than a person, drove this session.
 *
 * `~/.claude/projects` keys transcripts by working directory, so a tool that
 * runs its own headless session against a worktree writes into the same
 * directory as the person working there. Its opening instruction is an ordinary
 * `user` record — not a sidechain, no tag to reject it by — so it counted as a
 * human turn on that branch's card. Three such sessions sit in one branch's
 * directory here, each an automated security review.
 *
 * `entrypoint` is what separates them: `cli` is a terminal, `sdk-py` and
 * `sdk-cli` are programs. Absent means a transcript older than the field, and
 * an absent value keeps the previous behaviour rather than guessing — this
 * check only ever removes a false positive.
 */
function isMachineDriven(record: SessionRecord): boolean {
  return record.entrypoint?.startsWith("sdk") ?? false;
}

export function isCompactionCommand(record: SessionRecord): boolean {
  if (record.isCompactSummary) return true;

  const content = record.message?.content;

  return typeof content === "string" && content.includes("<command-name>/compact</command-name>");
}

/**
 * Commands built into the CLI rather than skills this repository wrote.
 *
 * They dominate the `<command-name>` records — `/compact` alone outnumbers
 * every skill invocation in the transcripts combined — so counting them as
 * skills would bury the signal under session housekeeping. `/compact` is
 * already counted separately as `window.compactions`, where it means something.
 */
const BUILTIN_COMMANDS = new Set([
  "add-dir",
  "agents",
  "clear",
  "compact",
  "config",
  "context",
  "cost",
  "doctor",
  "exit",
  "export",
  "help",
  "init",
  "login",
  "logout",
  "mcp",
  "memory",
  "model",
  "plugin",
  "pr-comments",
  "release-notes",
  "resume",
  "review",
  "status",
  "terminal-setup",
  "vim",
]);

const COMMAND_NAME = /<command-name>\/?([^<]+)<\/command-name>/g;

/**
 * Skills invoked as `/name` rather than through the `Skill` tool.
 *
 * Both routes are real invocations and both belong in the histogram, so a
 * skill used once each way counts twice — unlike a queued prompt echoed as a
 * user record, which is one instruction seen twice and is collapsed.
 *
 * Worth knowing before reading the output: this fixes an undercount, not the
 * headline. Across every transcript in this repository the `<command-name>`
 * records are overwhelmingly built-ins — `/compact` fifteen times, `/config`
 * and `/clear` five each — and `/prep-pr` never appears among them at all.
 * Skill usage really is as low as the cards said it was.
 */
export function skillCommandsIn(record: SessionRecord): string[] {
  const content = record.message?.content;
  if (typeof content !== "string") return [];

  const found: string[] = [];
  for (const match of content.matchAll(COMMAND_NAME)) {
    const name = match[1].trim();
    if (name && !BUILTIN_COMMANDS.has(name)) found.push(name);
  }

  return found;
}

/**
 * Whether this record is the first of its API response to be seen, recording
 * it as seen if so.
 *
 * `message.usage` on a split response is the whole response's usage, repeated
 * verbatim on every record that carries a block of it. Summing it per record
 * would multiply a response's cost by the number of blocks it was split
 * across. Every reader of `message.usage` needs this guard; the tool counts
 * next to it do not, because those are per record and each block holds its own.
 *
 * A record with no `requestId` is always counted. Two of them from one
 * response would double-count, which is the lesser of the two errors and the
 * one this tool has always preferred.
 */
function firstOfResponse(record: SessionRecord, seen: Set<string>): boolean {
  const id = record.requestId;
  if (typeof id !== "string") return true;
  if (seen.has(id)) return false;

  seen.add(id);

  return true;
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
  const countedResponses = new Set<string>();
  let usd = 0;

  for (const record of records) {
    if (record.type !== "assistant") continue;
    // A later block of a response the loop has already priced. It repeats that
    // response's usage, so counting it again would inflate both the cost and
    // the message count — `messages` counts responses, not records.
    if (!firstOfResponse(record, countedResponses)) continue;

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
  /** Absent on cards written before the field existed. */
  requests?: RequestSummary;
}

/**
 * Model calls, and the context each one carried.
 *
 * Cache reads are most of what a session costs, and each call re-reads the
 * whole context, so cost grows with calls times context. `with_one_tool`
 * against `with_tools` says how often a call did one thing when it could have
 * done several in parallel — the cheapest lever on the call count.
 */
export interface RequestSummary {
  main: number;
  subagent: number;
  with_tools: number;
  with_one_tool: number;
  /** Input plus cache read plus cache write, per call. Nearest-rank. */
  context_median: number;
  context_p90: number;
}

/** Nearest-rank percentile of an ascending list; 0 for an empty one. */
function nearestRank(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;

  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];
}

/**
 * One entry per model response. A response is split over several records that
 * share a `requestId`, each carrying the same usage and some of the tool
 * calls, so records are grouped before anything is counted. `<synthetic>`
 * records are the harness's own, not a call, and would pull the median context
 * toward zero.
 */
export function aggregateRequests(records: SessionRecord[]): RequestSummary {
  const calls = new Map<string, { sidechain: boolean; tools: number; context: number }>();
  let unkeyed = 0;

  for (const record of records) {
    if (record.type !== "assistant" || record.message?.model === "<synthetic>") continue;

    const key = typeof record.requestId === "string" ? record.requestId : `\u0000${unkeyed++}`;
    const tools = toolUses(record).length;
    const call = calls.get(key);

    if (call) {
      call.tools += tools;
      continue;
    }

    const usage = readUsage(record.message?.usage);
    calls.set(key, {
      sidechain: record.isSidechain === true,
      tools,
      context: usage.input + usage.cache_read + usage.cache_write_5m + usage.cache_write_1h,
    });
  }

  const summary: RequestSummary = {
    main: 0,
    subagent: 0,
    with_tools: 0,
    with_one_tool: 0,
    context_median: 0,
    context_p90: 0,
  };
  const contexts: number[] = [];

  for (const call of calls.values()) {
    if (call.sidechain) summary.subagent += 1;
    else summary.main += 1;
    if (call.tools > 0) summary.with_tools += 1;
    if (call.tools === 1) summary.with_one_tool += 1;
    contexts.push(call.context);
  }

  const sorted = contexts.toSorted((a, b) => a - b);
  summary.context_median = nearestRank(sorted, 0.5);
  summary.context_p90 = nearestRank(sorted, 0.9);

  return summary;
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
 * `corrective_turns` is the prompts a person sent while the agent was still
 * working — interruptions, read from the queued records {@link humanTurnText}
 * accepts. A turn sent after the agent stopped (a new task, an answer to its
 * question, "continue") is not one, however late in the session. Two limits:
 * an interruption is often a status note or added scope rather than a
 * correction, so read the prompts before calling any of it a brief finding;
 * and while a session waits on background subagents its main agent is idle,
 * so a redirect sent then is an idle turn and is not counted.
 */
export function aggregateInteraction(records: SessionRecord[]): InteractionSummary {
  const tools: Record<string, number> = {};
  const skills: Record<string, number> = {};
  const subagents: Record<string, number> = {};
  const editsPerFile = new Map<string, number>();
  const sessionsPastFirstEdit = new Set<string>();

  // Accumulated per session, not globally, and only banked once that session
  // actually shows an edit. A session that never edited anything the collector
  // could see contributes nothing rather than contributing all of its tokens —
  // "we did not observe the boundary" and "every token was exploration" are
  // very different claims, and only one of them is true.
  const pendingBySession = new Map<string, number>();
  const countedResponses = new Set<string>();
  let tokensBeforeFirstEdit = 0;
  let sessionsWithObservedEdit = 0;

  let userTurns = 0;
  let correctiveTurns = 0;

  const ordered = [...records].sort((a, b) => (a.timestamp ?? "").localeCompare(b.timestamp ?? ""));

  // A queued prompt is sometimes echoed as a `user` record once it is
  // dequeued. Both copies are one instruction, so a `user` record is dropped
  // when it is the next human record in its session after a queued prompt with
  // the same text. Never two `user` records: a person who types "continue"
  // twice steered twice.
  const lastQueued = new Map<string, string>();

  for (const record of ordered) {
    const session = record.sessionId ?? "unknown";
    const turnText = humanTurnText(record);

    if (turnText !== null) {
      const echoed = record.type === "user" && lastQueued.get(session) === turnText;
      lastQueued.delete(session);
      if (echoed) continue;

      userTurns += 1;
      // Queued means the agent was mid-turn when it arrived: an interruption.
      if (record.type === "attachment") {
        correctiveTurns += 1;
        lastQueued.set(session, turnText);
      }
      continue;
    }

    // A slash-invoked skill lands here rather than above: the record opens with
    // `<command-name>`, so `humanTurnText` rejects it as machinery. It is both
    // — an envelope, and evidence that a skill ran.
    for (const name of skillCommandsIn(record)) {
      skills[name] = (skills[name] ?? 0) + 1;
    }

    if (record.type !== "assistant") continue;

    const uses = toolUses(record);

    // The same guard `aggregateSpend` uses, and for the same reason: this sum
    // reads `message.usage`, which a split response repeats on every block.
    // The tool counting below is per record and needs no guard.
    if (
      firstOfResponse(record, countedResponses) &&
      !sessionsPastFirstEdit.has(session) &&
      !record.isSidechain
    ) {
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
    requests: aggregateRequests(records),
  };
}

const WORKSPACE_ROOTS = ["osn", "pulse", "zap", "cire", "shared", "tools", "musubi"];

/**
 * The path a `--numstat` line names after its change. A rename arrives as
 * `dir/{old => new}/file` or, at the top level, `old => new`; the new side is
 * the one that exists once the change lands.
 */
export function renamedTo(path: string): string {
  const braced = path.replace(/\{[^{}]*? => ([^{}]*?)\}/g, "$1");
  if (braced !== path) return braced.replace(/\/{2,}/g, "/");

  const arrow = path.indexOf(" => ");

  return arrow === -1 ? path : path.slice(arrow + 4);
}

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
    const rawPath = rest.join("\t");
    if (!rawPath) continue;

    const path = renamedTo(rawPath);
    const bucket = classifyPath(path);
    files[bucket] += 1;
    loc[bucket].added += addedRaw === "-" ? 0 : num(Number.parseInt(addedRaw, 10));
    loc[bucket].deleted += deletedRaw === "-" ? 0 : num(Number.parseInt(deletedRaw, 10));

    if (path.includes("/drizzle/") || path.includes("/migrations/")) touchesMigration = true;

    // The workspace globs are `<dir>/*` for the product directories, `tools`
    // and `musubi`, so the first two segments name the package. A file
    // directly inside one of those directories (`zap/README.md`) is not in a
    // package, so it needs a third segment before it counts.
    // `tools/oxlint` is the one place that resolves to a parent of the real
    // workspace (`tools/oxlint/house`) — still the right grouping for a card.
    const parts = path.split("/");
    if (parts.length >= 3 && WORKSPACE_ROOTS.includes(parts[0])) {
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
 * set before work starts — see `wiki/conventions/session-metrics.md`. The
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

/** A linked issue as `gh pr list --json closingIssuesReferences` returns it.
 * The repository is the load-bearing part: it decides whether the labels may
 * be read at all. `id` is the GraphQL node id, which `backfill` fetches labels
 * by. */
export interface IssueReference {
  id?: string;
  number: number;
  repository: { name: string; owner: { login: string } };
}

/** How `complexity.declared` was arrived at. `part-of` is a pull request that
 * only advances its issue: that issue's rating describes more work than the
 * branch did, so none is recorded. */
export type ComplexityMethod =
  | "confirmed"
  | "unconfirmed"
  | "none"
  | "not-fetched"
  | "lookup-failed"
  | "part-of";

/**
 * Whether the review findings on a branch led to a change, counted the way an
 * author's next push is read: did the flagged line change after the review?
 * A tests finding is fixed by a new test rather than at the line it cites, so
 * it also counts when a commit after the review added lines to a test file in
 * the cited file's package that imports the cited file.
 *
 * Counts only, and only for `T-` and `D-` findings. The card is committed to a
 * public repository, and `S-`, `P-` and `C-` findings live in the private
 * tracker — a count of those left unchanged would describe an unpatched defect
 * in public. No ID, lens, severity or path is recorded for any finding.
 *
 * The control is a line 30 to 40 lines away in the same file, tested the same
 * way: the rate at which lines change anyway. It has no test half, so
 * `acted_on_paired - acted_on_paired_by_test` against `control_changed` is the
 * like-for-like comparison; `acted_on` includes findings with no room for a
 * control.
 */
export interface ReviewSummary {
  reports: number;
  findings: number;
  located: number;
  acted_on: number;
  paired: number;
  acted_on_paired: number;
  control_changed: number;
  /** Of `acted_on`, the tests findings whose window did not change and that
   * count only because a test landed. Absent on a block from a collector that
   * does not count a landed test, which counts every finding by its window
   * alone — whatever the card's `schema_version`, since a later run keeps the
   * block it finds. */
  acted_on_by_test?: number;
  /** The same, of `acted_on_paired`. */
  acted_on_paired_by_test?: number;
}

/** The review reports whose findings a public card may count. The security
 * and performance reports hold only tracker kinds, so they are never opened. */
export const DEFAULT_REVIEW_REPORTS = ["TEST-REVIEW.md", "DOCS-REVIEW.md"];

/** Finding kinds that may be counted on a public card. */
const PUBLIC_FINDING_KINDS = new Set(["T", "D"]);

const FINDING_LABEL = /^\*\*([A-Z])-[A-Z]\d+\*\*/;
const LOCATION = /([A-Za-z0-9_@./-]+\.[A-Za-z0-9]+):(\d+)/g;

/** A fix often edits a neighbouring line rather than the one cited; the
 * control uses the same window, so the choice cancels out of the comparison. */
export const FINDING_WINDOW = 3;
const CONTROL_OFFSET = 35;

/** A counted finding: its kind letter (`T` or `D`) and its `**Issue:**` line,
 * or `null` where it has none. */
export interface ParsedFinding {
  kind: string;
  issue: string | null;
}

/**
 * Each counted finding, in report order.
 *
 * A finding runs from its bold label to the next label or the next `## `
 * heading. The sections after the findings (`## Coverage`, `## Files audited`)
 * cite `path:line` freely and are no finding's location.
 */
export function parseFindings(text: string): ParsedFinding[] {
  const findings: ParsedFinding[] = [];
  let open = false;

  for (const line of text.split("\n")) {
    const label = FINDING_LABEL.exec(line);
    if (label) {
      open = PUBLIC_FINDING_KINDS.has(label[1]);
      if (open) findings.push({ kind: label[1], issue: null });
      continue;
    }

    if (line.startsWith("## ")) {
      open = false;
      continue;
    }

    const last = findings[findings.length - 1];
    if (open && last?.issue === null && line.startsWith("**Issue:**")) last.issue = line;
  }

  return findings;
}

/** Every `path:line` an Issue line names, in order, with a leading repository
 * root stripped so an absolute path matches the tree. */
export function locationsIn(issue: string, root: string): { path: string; line: number }[] {
  const prefix = `${root.replace(/\/+$/, "")}/`;

  return [...issue.matchAll(LOCATION)].map((match) => {
    let path = match[1];
    if (path.startsWith(prefix)) path = path.slice(prefix.length);
    else if (path.startsWith("./")) path = path.slice(2);

    return { path, line: Number.parseInt(match[2], 10) };
  });
}

/** Old-side line ranges from `git diff -U0`. A count git omits is 1; a count
 * of 0 is an insertion after line `a`, which touches `a`. */
export function changedRanges(diff: string): [number, number][] {
  const ranges: [number, number][] = [];

  for (const match of diff.matchAll(/^@@ -(\d+)(?:,(\d+))? /gm)) {
    const start = Number.parseInt(match[1], 10);
    const count = match[2] === undefined ? 1 : Number.parseInt(match[2], 10);
    ranges.push(count === 0 ? [start, start] : [start, start + count - 1]);
  }

  return ranges;
}

export function windowTouched(ranges: [number, number][], line: number): boolean {
  const low = line - FINDING_WINDOW;
  const high = line + FINDING_WINDOW;

  return ranges.some(([start, end]) => start <= high && end >= low);
}

/** The control line for a finding, or `null` where the file has no room. */
export function controlLine(line: number, length: number): number | null {
  if (line + CONTROL_OFFSET + FINDING_WINDOW <= length) return line + CONTROL_OFFSET;
  if (line - CONTROL_OFFSET - FINDING_WINDOW >= 1) return line - CONTROL_OFFSET;

  return null;
}

/** `queries.sql` declares this shape for DuckDB, field by field; a change here
 * is a change there, and `tests/queries-schema.test.ts` fails until both agree. */
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
  /** `issues`: how many issues' ratings `declared` adds up. Absent before version 3
   * cards, whose `declared` is one issue's rating. */
  complexity: { declared: number | null; method: string; issues?: number };
  window: WindowSummary;
  spend: SpendSummary;
  diff: DiffSummary;
  interaction: InteractionSummary;
  /** `null` when no review report was read; absent on older cards. */
  review?: ReviewSummary | null;
}

export interface CardContext {
  branch: string;
  prNumber: number | null;
  issueNumber: number | null;
  issueType: string | null;
  issueLabels: string[];
  declaredComplexity: number | null;
  complexityMethod: string;
  /** How many issues' ratings `declaredComplexity` adds up. Defaults to one
   * when a rating is given and none otherwise. */
  complexityIssues?: number;
  baseSha: string | null;
  headSha: string | null;
  mergedAt: string | null;
  phase: "at-open" | "at-merge";
  generatedAt: string;
  review?: ReviewSummary | null;
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
      issues: context.complexityIssues ?? (context.declaredComplexity === null ? 0 : 1),
    },
    window: aggregateWindow(records),
    spend: aggregateSpend(records),
    diff,
    interaction: aggregateInteraction(records),
    review: context.review ?? null,
  };
}

/**
 * Whether a freshly built card says anything the one on disk does not.
 *
 * `generated_at` records when a run happened, not a fact about the pull
 * request, so on settled work it is the one field a re-run changes. Stamping it
 * unconditionally made the tool non-idempotent in git terms: a backfill over 25
 * pull requests rewrote 15 cards with a one-line timestamp diff and no data
 * change. Comparing the new card against the old timestamp substituted in
 * separates the two, so an unchanged card is left alone and the date on it goes
 * on meaning the run that last learned something.
 *
 * `buildCard` fixes key order and both sides come from it, so comparing the
 * serialised form is sound here. A hand-edited card with the same fields in a
 * different order reads as changed and is rewritten — the safe way round.
 */
export function sameApartFromGeneratedAt(existing: Card, next: Card): boolean {
  const rebased: Card = { ...next, pr: { ...next.pr, generated_at: existing.pr.generated_at } };

  return JSON.stringify(existing) === JSON.stringify(rebased);
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export { compactTokens, humanDuration } from "./format.ts";

function share(part: number, whole: number): string {
  return whole > 0 ? `${Math.round((part / whole) * 100)}%` : "0%";
}

/**
 * The card as a collapsed block for a pull-request body.
 *
 * A `<details>` block rather than a section, and that is a constraint rather
 * than a preference: `prep-pr` permits a fixed set of `##` headings and checks
 * the count before it finishes, so one more would fail a body that is otherwise
 * correct. `<details>` adds no heading.
 *
 * The summary line carries the four figures worth seeing without expanding.
 * "API-equivalent" is spelled out every time because this work runs on a
 * subscription and the number must never be read as a bill.
 */
export function renderDetails(card: Card, file = `${branchSlug(card.pr.branch)}.json`): string {
  const { spend, diff, interaction, window: session, complexity } = card;
  const tokens = spend.tokens;
  const total =
    tokens.input +
    tokens.output +
    tokens.cache_write_5m +
    tokens.cache_write_1h +
    tokens.cache_read;

  const notes = [
    (complexity.issues ?? 1) > 1 ? `sum of ${complexity.issues} issues` : null,
    complexity.method === "unconfirmed" ? "unconfirmed" : null,
  ].filter((note) => note !== null);
  const declared =
    complexity.declared === null
      ? "unrated"
      : `${complexity.declared}${notes.length > 0 ? ` (${notes.join("; ")})` : ""}`;

  // `interaction.subagents` counts the `Agent` calls this card's own sessions
  // made. A subagent dispatched from a session outside them still spent from
  // this branch, so an empty count says nothing about whether delegation
  // happened: only the spend does.
  const delegated = spend.by_actor.subagent;
  const subagentShare = share(delegated.usd_equivalent, spend.usd_equivalent);
  const subagents =
    Object.keys(interaction.subagents).length > 0
      ? `${Object.entries(interaction.subagents)
          .map(([kind, n]) => `${n}× ${kind}`)
          .join(", ")} (${subagentShare} of spend)`
      : delegated.messages > 0 || delegated.usd_equivalent > 0
        ? `no dispatch seen; ${subagentShare} of spend is subagent work`
        : "none";

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
    ["Turns", `${interaction.user_turns} (${interaction.corrective_turns} sent mid-turn)`],
    [
      "Before first edit",
      interaction.tokens_before_first_edit === null
        ? "not observed (no edit seen in the transcript)"
        : `${compactTokens(interaction.tokens_before_first_edit)} (${share(
            interaction.tokens_before_first_edit,
            total,
          )})`,
    ],
    ["Subagents", subagents],
  ];

  if (interaction.requests !== undefined) {
    const calls = interaction.requests;
    rows.push([
      "Model calls",
      `${calls.main + calls.subagent} · ${calls.with_tools > 0 ? share(calls.with_one_tool, calls.with_tools) : "—"} of those using tools used one · median context ${compactTokens(calls.context_median)}`,
    ]);
  }

  if (card.review) {
    const { paired, acted_on_paired, control_changed, acted_on_paired_by_test } = card.review;
    const byTest = acted_on_paired_by_test ? ` (${acted_on_paired_by_test} by a new test)` : "";
    rows.push([
      "Review (tests and docs lenses)",
      `${acted_on_paired} of ${paired} paired findings acted on${byTest} · control ${control_changed} of ${paired}`,
    ]);
  }

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
    `<sub>Card: \`.claude/metrics/${file}\` · phase \`${card.pr.phase}\` · [schema](../blob/main/wiki/conventions/session-metrics.md)</sub>`,
    "</details>",
  ].join("\n");
}

/**
 * The repository root, so `.claude/metrics` means the same directory whichever
 * way these commands are invoked.
 *
 * This is not a nicety. The documented form is
 * `bun run --cwd tools/pr-metrics report`, and `--cwd` sets the process
 * working directory — so a default of `.claude/metrics` resolved against the
 * cwd pointed at `tools/pr-metrics/.claude/metrics`, which never exists.
 * `report` exited 1 on the exact command in its own README. `card` was worse:
 * it silently *created* that directory inside the package, and the
 * `SessionEnd` hook ends in `|| true`, so every card the hook ever wrote went
 * there and nobody saw it fail.
 *
 * Falling back to the cwd keeps the tests working outside a checkout, where
 * every path is passed explicitly anyway.
 */
let memoisedRepoRoot: string | null = null;

export function repoRoot(): string {
  // Memoised for the process. The unattended `SessionEnd` fallback reaches here
  // through `defaultMetricsDir` before its guard, and a `git rev-parse` costs
  // about 8 ms against a guard that costs one file read — so the spawn, not the
  // work, was the fallback's bill. Nothing here re-reads a repository that
  // could have moved inside one invocation.
  if (memoisedRepoRoot !== null) return memoisedRepoRoot;

  const result = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  memoisedRepoRoot = result.success ? result.stdout.toString().trim() : ".";

  return memoisedRepoRoot;
}

/** Where cards live, resolved against the repository rather than the cwd. */
export function defaultMetricsDir(): string {
  return `${repoRoot()}/.claude/metrics`;
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

/**
 * The card already on disk at `path`, or `null` where there is nothing a reader
 * could use — no file, malformed JSON, or JSON that is not card-shaped.
 *
 * The shape check is the part that matters. `JSON.parse` succeeds on
 * `{"schema_version": 1}`, and a cast cannot make that a `Card`:
 * `sameApartFromGeneratedAt` then reads `existing.pr.generated_at` off
 * `undefined` and the collector dies with a `TypeError`, having written
 * nothing. A `SessionEnd` hook killed at its timeout leaves exactly such a
 * file, so the case is reachable rather than hypothetical.
 *
 * The CLI reads the file once, through here, and every check uses that read:
 * `--if-absent` has to treat as absent whatever the writer would replace, or
 * the fallback ends up defending a file nobody can read.
 */
function readCardFile(path: string): Card | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(require("node:fs").readFileSync(path, "utf8") as string);
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null) return null;
  if (!("pr" in parsed) || !("spend" in parsed) || !("interaction" in parsed)) return null;
  if (typeof parsed.pr !== "object" || parsed.pr === null) return null;

  return parsed as Card;
}

/**
 * The pull request that owns the card on disk, when this run must not replace
 * it; `null` when the write may go ahead.
 *
 * A card names one pull request. Transcripts are joined to a card by branch
 * name alone, so a run on a branch name an earlier pull request used would
 * write both pieces of work into one card, over the earlier one's committed
 * record. A run with no pull request of its own — a failed `gh` lookup, or the
 * `SessionEnd` fallback before one exists — cannot show the card is its own,
 * so it is refused too. A card that names no pull request is the fallback's
 * identity-less one, and is there to be replaced.
 */
export function otherPullRequest(onDisk: Card | null, prNumber: number | null): number | null {
  const owner: unknown = onDisk?.pr.number;

  return typeof owner === "number" && owner !== prNumber ? owner : null;
}

/**
 * The file a card goes to. The first pull request on a branch name takes
 * `<slug>.json`; each later one on the same name takes `<slug>-<pr>.json`, so
 * the earlier card keeps its path and its committed record.
 */
export function cardFileName(branch: string, prNumber: number, first: boolean): string {
  return first ? `${branchSlug(branch)}.json` : `${branchSlug(branch)}-${prNumber}.json`;
}

export interface BranchCard {
  file: string;
  card: Card;
}

/**
 * Every readable card on disk for this exact branch name: `<slug>.json` and
 * each `<slug>-<n>.json`. A card whose `pr.branch` is another name is a slug
 * neighbour's — `feat/x-12` flattens to `feat-x-12` too — and is left out.
 */
export function branchCards(outDir: string, branch: string): BranchCard[] {
  const slug = branchSlug(branch);
  const pattern = new RegExp(`^${slug.replaceAll(".", "\\.")}(-\\d+)?\\.json$`);

  let names: string[];
  try {
    names = readdirSync(outDir);
  } catch {
    return [];
  }

  return names
    .filter((name) => pattern.test(name))
    .toSorted()
    .flatMap((file) => {
      const card = readCardFile(`${outDir}/${file}`);

      return card !== null && card.pr.branch === branch ? [{ file, card }] : [];
    });
}

/** Another pull request on the same branch name, as far as its place in time
 * is known. */
export interface BranchPull {
  number: number;
  mergedAt: string | null;
  /** GitHub's state where it was asked; `null` when nobody asked or the
   * answer did not land. */
  state: "MERGED" | "OPEN" | "CLOSED" | null;
}

/** The span of time whose records belong to one pull request: after the merge
 * before it, up to its own merge when a later one follows. `null` bounds are
 * open. */
export type RecordWindow =
  | { kind: "window"; after: string | null; until: string | null }
  | { kind: "unplaceable"; pull: number | null; reason: "closed" | "unknown" };

/**
 * Where one pull request's records start and stop when its branch name carried
 * other pull requests too.
 *
 * Transcripts are joined to a card by branch name alone, so on a reused name
 * the only thing that separates two pull requests' sessions is time. Each
 * merge is the boundary: a pull request takes the records after the merge
 * before it, and up to its own merge when another merged after it. With no
 * other pull request the window is open both ways and every record counts, as
 * on any branch whose name was used once.
 *
 * `self.mergedAt` null means not merged yet, so after every merge. Another pull
 * request that is `OPEN` is placed the same way. One that closed without
 * merging, or whose merge time is unknown, has no place on the line, and the
 * caller must not guess one. Nor does this pull request when its own merge time
 * is set but is not a date: `pull` is then `null`.
 */
export function recordWindow(
  self: { mergedAt: string | null },
  others: readonly BranchPull[],
): RecordWindow {
  if (others.length === 0) return { kind: "window", after: null, until: null };

  const at = (mergedAt: string | null) =>
    mergedAt === null ? Number.POSITIVE_INFINITY : Date.parse(mergedAt);

  for (const other of others) {
    if (other.mergedAt === null && other.state === "OPEN") continue;
    if (other.mergedAt === null || Number.isNaN(at(other.mergedAt))) {
      return {
        kind: "unplaceable",
        pull: other.number,
        reason: other.state === "CLOSED" ? "closed" : "unknown",
      };
    }
  }

  const selfAt = at(self.mergedAt);
  if (Number.isNaN(selfAt)) return { kind: "unplaceable", pull: null, reason: "unknown" };
  const merged = others.filter((o) => o.mergedAt !== null) as (BranchPull & { mergedAt: string })[];
  const before = merged.filter((o) => at(o.mergedAt) < selfAt);
  const after =
    before.length === 0
      ? null
      : before.reduce((a, b) => (at(a.mergedAt) >= at(b.mergedAt) ? a : b));
  const laterExists = Number.isFinite(selfAt) && others.some((o) => at(o.mergedAt) > selfAt);

  return {
    kind: "window",
    after: after?.mergedAt ?? null,
    until: laterExists ? self.mergedAt : null,
  };
}

/**
 * The records inside a window. An open window returns every record untouched.
 * Otherwise a record counts only when its timestamp parses and falls after
 * `after` and no later than `until`; one with no timestamp cannot be placed and
 * is left out. Compared as instants, never as strings: GitHub writes
 * `…:00Z` and transcripts write `…:00.000Z`, which sort apart for one moment.
 *
 * A session that runs across a boundary is cut at it, so each side's
 * interaction figures for that session come from a fragment of it.
 */
export function recordsInWindow(
  records: SessionRecord[],
  window: { after: string | null; until: string | null },
): SessionRecord[] {
  if (window.after === null && window.until === null) return records;

  const after = window.after === null ? Number.NEGATIVE_INFINITY : Date.parse(window.after);
  const until = window.until === null ? Number.POSITIVE_INFINITY : Date.parse(window.until);

  return records.filter((record) => {
    const t = Date.parse(record.timestamp ?? "");

    return !Number.isNaN(t) && t > after && t <= until;
  });
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

/** The marker `orchestrate` puts at the top of every dispatch prompt.
 *
 * `m` because the marker is not required to be the very first line — a
 * dispatch may lead with a worktree instruction — only to be alone on its own. */
const TASK_BRANCH_MARKER = /^TASK-BRANCH:[ \t]*(\S+)[ \t]*$/m;

/** The marker as a Workflow harness hands it on: the harness indents every
 * line of the task a script computed, so leading spaces or tabs are allowed.
 * Read only from that task (`workflowTaskBranch`); everywhere else the marker
 * is a line an agent wrote, and stays at column 0. */
const INDENTED_TASK_BRANCH_MARKER = /^[ \t]*TASK-BRANCH:[ \t]*(\S+)[ \t]*$/m;

/** How far into a prompt the marker is honoured.
 *
 * A dispatch prompt routinely quotes text this repository did not author —
 * issue bodies, review comments, fetched pages — and a planted
 * `TASK-BRANCH: something-else` line would otherwise re-point a subagent's whole
 * spend onto another branch's card, which is then committed publicly. The skill
 * asks for the marker on the first line; a small window allows a leading
 * worktree instruction without honouring anything quoted further down. */
const MARKER_WINDOW_LINES = 3;

/** A ref this repository could actually have. Rejects `..`, a leading dash and
 * anything outside the characters a branch name uses, so a malformed or hostile
 * capture names no card at all rather than an unexpected one. */
const PLAUSIBLE_REF = /^[A-Za-z0-9][\w.\-/]*$/;

function markerBranch(prompt: string, marker = TASK_BRANCH_MARKER): string | null {
  const head = prompt.split("\n", MARKER_WINDOW_LINES).join("\n");
  const captured = marker.exec(head)?.[1];
  if (!captured || captured.includes("..") || !PLAUSIBLE_REF.test(captured)) return null;

  return captured;
}

/**
 * The branch a subagent was dispatched to work on, or `null`.
 *
 * A *subagent's* own `gitBranch` cannot answer this: it is fixed to whatever
 * its parent's was at the moment of dispatch and never re-derived afterward,
 * even under `isolation: "worktree"`, so a subagent working in a task
 * worktree records the branch its parent started on. Across this machine's
 * transcripts that is 85.8% of subagent spend stamped `HEAD`. (A top-level
 * session's own `gitBranch`, by contrast, is recomputed per record from its
 * live cwd — see `resolveSessionBranch` below for the one shape where that
 * stays `main` throughout anyway: a session that plans and dispatches
 * without ever `cd`-ing itself.)
 *
 * The pairing is already on disk: every `agent-<id>.jsonl` an `Agent` tool
 * call starts has a sibling `agent-<id>.meta.json` carrying that call's
 * `toolUseId`, and that id appears in the parent transcript on the `tool_use`
 * block whose `input.prompt` is the dispatch.
 *
 * An agent a Workflow run starts has no such call to join to: a script starts
 * it, and its transcript sits under `subagents/workflows/<run-id>/`. There the
 * marker is read from the agent's own transcript instead — see
 * `workflowTaskBranch`.
 */
const resolvedBranches = new Map<string, string | null>();

export function resolveDispatchBranch(
  subagentFile: string,
  seen = new Set<string>(),
): string | null {
  // Resolution is a pure function of the tree, and both readers plus the CLI's
  // warning path resolve the same files; without this the later walks repeat
  // the first in full.
  const memo = resolvedBranches.get(subagentFile);
  if (memo !== undefined) return memo;

  const branch = resolveUncached(subagentFile, seen);
  resolvedBranches.set(subagentFile, branch);

  return branch;
}

function resolveUncached(subagentFile: string, seen: Set<string>): string | null {
  // A malformed tree could point a parent back at its child; a chain this long
  // is not a real dispatch either way.
  if (seen.has(subagentFile) || seen.size > 8) return null;
  seen.add(subagentFile);

  // Decided by where the file sits, whatever its sidecar holds: the parent
  // search below looks in the session file and the agent's siblings, and a
  // workflow agent's task is in neither.
  if (WORKFLOW_AGENT_FILE.test(subagentFile)) return workflowTaskBranch(subagentFile);

  const meta = readSubagentMeta(subagentFile.replace(/\.jsonl$/, ".meta.json"));
  const toolUseId = meta?.toolUseId;
  if (!toolUseId) return null;

  for (const parent of parentCandidates(subagentFile, meta)) {
    const prompt = findDispatchPrompt(parent, toolUseId);
    if (prompt === null) continue;

    const marked = markerBranch(prompt);
    if (marked) return marked;

    // No marker on this dispatch. If another subagent wrote it, that agent was
    // itself dispatched to a branch, and this one inherits it: the skills that
    // dispatch at depth 2 do not emit the marker and cannot all be edited. If
    // the dispatcher is the top-level session file, fall back to the single
    // branch it cut for itself, if any — the ordinary new-feat/stress-plan/
    // prep-pr shape, and the reason an unmarked dispatch from that kind of
    // session need not stay unattributed.
    return parent.includes("/subagents/")
      ? resolveDispatchBranch(parent, seen)
      : resolveSessionBranch(parent);
  }

  return null;
}

/** Where a Workflow run's agents write: `<session>/subagents/workflows/<run-id>/`. */
const WORKFLOW_AGENT_FILE = /\/subagents\/workflows\/[^/]+\/[^/]+\.jsonl$/;

/** The line a Workflow harness writes above the task a script computed for one
 * agent, as the first line of that task's own user record. */
const WORKFLOW_TASK_HEADER = "[Workflow harness — computed task]";

/** How much of a workflow agent's transcript is read for its task. The task is
 * its second record, and some 250 KB of attachments come before its first reply. */
const WORKFLOW_HEAD_BYTES = 1024 * 1024;

/**
 * The branch a Workflow run's agent was started for, or `null`.
 *
 * The harness opens the agent's transcript with its relay of the user request
 * that started the run, then the task the script computed for this agent. Each
 * is a user record whose first line is the harness's own header, and every line
 * the harness relays below it is indented by two spaces. The marker is read
 * from the task alone, inside the usual window, and nowhere else:
 *
 * - the relay is the same text for every agent of a run that may drive several
 *   branches, and it quotes whatever the user pasted;
 * - text the harness or a hook adds is not the task;
 * - anything after the agent's first reply — tool results, later prompts — is
 *   text nobody here wrote.
 *
 * The header is safe to key on because the harness indents what it relays, so
 * relayed text cannot begin a record with it. A harness that renamed it would
 * stop attribution, and `unattributedSubagentFiles` would count every such agent.
 */
function workflowTaskBranch(file: string): string | null {
  const head = readHead(file, WORKFLOW_HEAD_BYTES);
  if (head === null) return null;

  const lines = head.text.split("\n");
  // A partial read can end mid-record.
  if (!head.whole) lines.pop();

  for (const line of lines) {
    let record: SessionRecord;
    try {
      record = JSON.parse(line) as SessionRecord;
    } catch {
      continue;
    }

    if (record.type === "assistant") return null;

    const content = record.message?.content;
    if (
      record.type === "user" &&
      typeof content === "string" &&
      content.startsWith(WORKFLOW_TASK_HEADER)
    ) {
      return markerBranch(content, INDENTED_TASK_BRANCH_MARKER);
    }
  }

  return null;
}

/** The sidecar Claude Code writes beside every subagent transcript. */
export interface SubagentMeta {
  agentType?: string;
  description?: string;
  model?: string;
  parentAgentId?: string;
  spawnDepth?: number;
  /** The `Agent` tool call that spawned this subagent. The join to the parent. */
  toolUseId?: string;
}

function readSubagentMeta(file: string): SubagentMeta | null {
  try {
    return JSON.parse(readFileSync(file, "utf8") as string) as SubagentMeta;
  } catch {
    return null;
  }
}

/**
 * Where the `tool_use` that spawned this subagent might live: the session
 * transcript first, then every sibling subagent transcript.
 *
 * The siblings are not optional. 79 of this machine's 363 subagent files are
 * `spawnDepth: 2` — dispatched by another subagent — and every one of those
 * parents is a sibling rather than the session file.
 */
function parentCandidates(subagentFile: string, meta: SubagentMeta | null): string[] {
  const subagentsDir = subagentFile.replace(/\/[^/]+$/, "");
  const session = `${subagentFile.replace(/\/subagents\/[^/]+$/, "")}.jsonl`;

  // The sidecar names the dispatching agent outright on every nested subagent —
  // 79 of 79 depth-2 sidecars on this machine carry `parentAgentId`, and the
  // file it names exists in all 79 — so the sibling scan is a fallback, not the
  // mechanism. Scanning first was O(n²): the largest directory here holds 127
  // subagent transcripts and every nested child re-read all of them.
  const named = meta?.parentAgentId ? [`${subagentsDir}/agent-${meta.parentAgentId}.jsonl`] : [];

  let siblings: string[] = [];
  try {
    siblings = readdirSync(subagentsDir)
      .filter((name) => name.endsWith(".jsonl"))
      .map((name) => `${subagentsDir}/${name}`)
      .filter((file) => file !== subagentFile);
  } catch {
    siblings = [];
  }

  return [...named, session, ...siblings];
}

/** Branch names captured from the exact commands `new-feat` Step 1 runs:
 * local `git worktree add <dir> -b <branch> …`, or remote
 * `git checkout -B <branch>`.
 *
 * Matches only that argument order and spelling — not git's other documented
 * order (`worktree add -b <branch> <dir>`) and not `git switch -c` — because
 * that is what the two skills actually run; this is a signal reader for a
 * known shape, not a general git-command parser. Read only through
 * `matchAll` (never `.exec`/`.test`), so the module-level `g` flag's
 * `lastIndex` is never left stateful for a later call: `matchAll` iterates a
 * copy of the regex. */
const BRANCH_CUT_COMMAND = /(?:worktree\s+add\s+\S+\s+-b|checkout\s+-B)\s+(\S+)/g;

/** A captured branch name worth keeping: passes the same plausibility check
 * `markerBranch` applies to the `TASK-BRANCH:` marker, and is not `main` or
 * `HEAD` — `git checkout -B main` should never count as "cutting a task
 * branch". */
function plausibleCutBranch(candidate: string): boolean {
  return (
    candidate !== "main" &&
    candidate !== "HEAD" &&
    !candidate.includes("..") &&
    PLAUSIBLE_REF.test(candidate)
  );
}

/** One transcript file's `tool_use` blocks, scanned once: every dispatch
 * prompt by `tool_use` id, every branch name a `Bash` block's command cut via
 * {@link BRANCH_CUT_COMMAND}, and the branch of every worktree the session
 * made with the `EnterWorktree` tool. */
interface FileScan {
  prompts: Map<string, string>;
  cutBranches: Set<string>;
  enteredBranches: Set<string>;
}

/** The record Claude Code writes when a session enters a worktree. It is
 * written only when the move succeeds, and it names the branch git gave the
 * worktree. `enteredExisting` is `true` when the session stepped into a
 * worktree that was already there; a worktree the session made has no such
 * field and names the commit it was made from. */
interface WorktreeStateRecord {
  type?: string;
  worktreeSession?: { worktreeBranch?: unknown; enteredExisting?: unknown } | null;
}

/**
 * A branch name taken from a `worktree-state` record. Git wrote it, not an
 * agent, so it is held to git's rules rather than {@link PLAUSIBLE_REF}'s
 * narrower ones: `EnterWorktree` turns a worktree name `feat/x` into the branch
 * `worktree-feat+x`, and `+` is legal in a ref.
 */
function plausibleEnteredBranch(candidate: unknown): candidate is string {
  return (
    typeof candidate === "string" &&
    candidate !== "" &&
    !/\s/.test(candidate) &&
    !candidate.includes("..") &&
    !isAmbiguousBranch(candidate)
  );
}

/** Built once per file. A session file is the parent of many subagents — one
 * 9.4 MB file here was read 203 times before this cache, and the largest
 * transcript is 72 MB — so a per-call read was quadratic in subagents per
 * session, and the `split("\n")` array was re-allocated on each one.
 * `resolveSessionBranch` shares this same scan rather than reading the file
 * a second time for its own pass over the same `tool_use` blocks. */
const fileScans = new Map<string, FileScan>();

function scanFile(file: string): FileScan {
  const memo = fileScans.get(file);
  if (memo !== undefined) return memo;

  const scan: FileScan = { prompts: new Map(), cutBranches: new Set(), enteredBranches: new Set() };
  fileScans.set(file, scan);

  let text: string;
  try {
    text = readFileSync(file, "utf8") as string;
  } catch {
    return scan;
  }

  for (const line of text.split("\n")) {
    // Most lines carry no dispatch, no shell command and no worktree move, and
    // these files reach tens of megabytes, so reject before the parse.
    const toolUse = line.includes('"tool_use"');
    if (!toolUse && !line.includes('"worktree-state"')) continue;

    let record: SessionRecord & WorktreeStateRecord;
    try {
      record = JSON.parse(line) as SessionRecord & WorktreeStateRecord;
    } catch {
      continue;
    }

    if (record.type === "worktree-state") {
      // Only a worktree this session made. One it stepped into was cut for
      // other work, and what the session did before the move — a review, a
      // triage, another task — has nothing to do with that branch.
      if (record.worktreeSession?.enteredExisting === true) continue;
      const entered = record.worktreeSession?.worktreeBranch;
      if (plausibleEnteredBranch(entered)) scan.enteredBranches.add(entered);
      continue;
    }

    const content = record.message?.content;
    if (!Array.isArray(content)) continue;

    for (const block of content) {
      // `content` holds plain strings as well as blocks, so narrow before
      // reading a field — the same guard `toolUses` uses.
      if (block === null || typeof block !== "object" || block.type !== "tool_use") continue;

      if (block.id && typeof block.input?.prompt === "string") {
        scan.prompts.set(block.id, block.input.prompt);
      }

      if (block.name === "Bash" && typeof block.input?.command === "string") {
        for (const match of block.input.command.matchAll(BRANCH_CUT_COMMAND)) {
          const candidate = match[1];
          if (candidate && plausibleCutBranch(candidate)) scan.cutBranches.add(candidate);
        }
      }
    }
  }

  return scan;
}

/** The `input.prompt` of the `tool_use` block with this id, or `null`. */
function findDispatchPrompt(file: string, toolUseId: string): string | null {
  return scanFile(file).prompts.get(toolUseId) ?? null;
}

const sessionBranches = new Map<string, string | null>();

/**
 * The single task branch a main-thread (non-subagent) session cut for
 * itself, or `null`.
 *
 * A session that plans and dispatches without ever `cd`-ing itself — the
 * ordinary `new-feat`/`stress-plan`/`prep-pr` shape — never shows a worktree
 * `cwd`, so that signal is not in the data; scanning `record.cwd` against
 * `git worktree list` would find nothing. What the transcript does contain is
 * the command that cut the worktree in the first place. Returns `null`,
 * deliberately, when more than one distinct branch was cut this way — an
 * `orchestrate` session driving several tasks in one sitting — rather than
 * guessing which task the session's own reasoning belongs to. At exactly one
 * task (including an `orchestrate` session driving only one) the session's
 * own overhead is attributed to it, which is correct: there is nothing to
 * split unfairly when there is only one task.
 *
 * A session that ran no such command but made a worktree with the
 * `EnterWorktree` tool and moved into it resolves to that worktree's branch,
 * by the same one-branch rule. Its records before the move — the request and
 * the work that led to the branch — are stamped `HEAD` or `main` and otherwise
 * land on no card. A worktree the session only entered, one that was already
 * there, counts for nothing: it was cut for other work. A branch cut with git
 * outranks one made by `EnterWorktree`: a session that makes a scratch
 * worktree and then cuts the task branch keeps the task branch.
 */
export function resolveSessionBranch(file: string): string | null {
  const memo = sessionBranches.get(file);
  if (memo !== undefined) return memo;

  const { cutBranches, enteredBranches } = scanFile(file);
  const evidence = cutBranches.size > 0 ? cutBranches : enteredBranches;
  const resolved = evidence.size === 1 ? ([...evidence][0] ?? null) : null;
  sessionBranches.set(file, resolved);

  return resolved;
}

/**
 * How Claude Code names a project directory: the session's working directory
 * with `/` and `.` both flattened to `-`.
 */
export function encodeProjectDir(path: string): string {
  return path.replaceAll(/[/.]/g, "-");
}

/** Every worktree of this repository, plus the common git dir that a
 * bare-repo-root session records. Used to decide which project directories
 * under `~/.claude/projects` belong to this checkout. */
export function repoProjectPaths(): string[] {
  const paths = new Set<string>();

  const worktrees = Bun.spawnSync(["git", "worktree", "list", "--porcelain"], { stdout: "pipe" });
  for (const line of worktrees.stdout.toString().split("\n")) {
    if (line.startsWith("worktree ")) paths.add(line.slice("worktree ".length).trim());
  }

  const common = Bun.spawnSync(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"], {
    stdout: "pipe",
  });
  const dir = common.stdout.toString().trim();
  // A bare repo's common dir IS the root every worktree hangs off, and an
  // orchestrator session runs there. A normal clone's is `<root>/.git`.
  if (dir) paths.add(dir.replace(/\/\.git$/, ""));

  return [...paths].filter(Boolean);
}

/** Options both readers share. */
export interface ReadOptions {
  /** Absolute paths this repository owns. When given, a subagent transcript is
   * admitted on the strength of its `TASK-BRANCH:` marker only if it sits under
   * one of them.
   *
   * `~/.claude/projects` holds every project on the machine, and a card is
   * committed to a public repository, carrying `interaction.tool_calls`,
   * `skills` and `subagents` keyed verbatim from the transcript — MCP server
   * and private skill names among them. A marker is an attribution hint an
   * agent wrote, not a proof of provenance, so it is never sufficient on its
   * own. */
  repoPaths?: string[];
}

/** One or more `~/.claude/projects`-shaped directories. */
export type SessionsRoots = string | string[];

/**
 * Where Claude Code keeps transcripts. It writes them under
 * `$CLAUDE_CONFIG_DIR/projects` when that variable is set, so a session started
 * with a second config directory lands there and not in `~/.claude/projects`.
 * Both are read when both exist: the older one holds the earlier sessions, and
 * the branch filter decides which records belong to the card.
 */
export function defaultSessionsRoots(
  env: Record<string, string | undefined> = process.env,
): string[] {
  const roots: string[] = [];
  const configured = env.CLAUDE_CONFIG_DIR?.replace(/\/+$/, "");
  if (configured) roots.push(`${configured}/projects`);

  // With no HOME there is no home directory to read. Without this guard the
  // root would be the literal string "undefined/.claude/projects".
  if (env.HOME) {
    const home = `${env.HOME}/.claude/projects`;
    if (!roots.includes(home)) roots.push(home);
  }

  return roots;
}

/** Every transcript file under one or more `~/.claude/projects`-shaped directories. */
function transcriptFiles(
  sessionsDir: SessionsRoots,
  repoPaths?: string[],
): { file: string; isSubagent: boolean; ownedByRepo: boolean }[] {
  const prefixes = repoPaths?.map(encodeProjectDir);
  const files: { file: string; isSubagent: boolean; ownedByRepo: boolean }[] = [];

  for (const root of [sessionsDir].flat()) {
    // A root that does not exist holds no transcripts. Scanning it would throw.
    if (!existsSync(root)) continue;

    const patterns: [string, boolean][] = [
      ["*/*.jsonl", false],
      ["*/*/subagents/*.jsonl", true],
      // Agents a Workflow run starts write one level deeper, under
      // `subagents/workflows/<run-id>/`. They are subagent spend all the same.
      // The run's `journal.jsonl` beside them is its log, not a transcript: it
      // holds no spend and no branch, and counted it would only add a file to
      // the unattributed warning.
      ["*/*/subagents/workflows/*/agent-*.jsonl", true],
    ];

    // Globbed in-process rather than through `sh -c`: the root comes from an
    // environment variable, and a path with a space or a metacharacter in it
    // would otherwise split the pattern and drop transcripts without a word.
    for (const [pattern, isSubagent] of patterns) {
      const matches = [
        ...new Bun.Glob(pattern).scanSync({ cwd: root, absolute: true, followSymlinks: true }),
      ].toSorted();

      for (const file of matches) {
        files.push({ file, isSubagent, ownedByRepo: ownedByRepo(root, file, prefixes) });
      }
    }
  }

  return files;
}

/** The first line of a file, without reading the rest of it. The 366 subagent
 * transcripts here total 200 MB and only their first line is wanted. */
function firstLine(file: string): string | null {
  const head = readHead(file, 64 * 1024);
  if (head === null) return null;

  const newline = head.text.indexOf("\n");

  return newline === -1 ? head.text : head.text.slice(0, newline);
}

/** A file's first `bytes` bytes as text, and whether they are all of it. */
function readHead(file: string, bytes: number): { text: string; whole: boolean } | null {
  let fd: number | null = null;
  try {
    fd = openSync(file, "r");
    const buffer = Buffer.alloc(bytes);
    const read = readSync(fd, buffer, 0, bytes, 0);

    return { text: buffer.toString("utf8", 0, read), whole: read < bytes };
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/** Whether a transcript's project directory belongs to this repository. With
 * no prefixes given, nothing is scoped and every file counts as owned. */
function ownedByRepo(root: string, file: string, prefixes: string[] | undefined): boolean {
  if (!prefixes || prefixes.length === 0) return true;

  const project = file.slice(root.length + 1).split("/")[0] ?? "";

  return prefixes.some((prefix) => project === prefix || project.startsWith(`${prefix}-`));
}

/**
 * The record's own uuid, which is what a cross-file duplicate repeats.
 *
 * This keys the *record* dedupe, and it deliberately does not fall back to
 * `requestId`. One API response reaches the transcript as several records — a
 * thinking block, a text block, one per `tool_use` — all sharing a
 * `requestId`, so keying on that kept the first block of every response and
 * threw the rest away. On one branch here that dropped 167 of 973 records,
 * including all three `Agent` dispatches and 101 of 161 `Bash` calls, and the
 * card then stated the session used no subagents.
 *
 * The two phenomena separate cleanly: duplicate records repeat a `uuid`,
 * duplicate *usage* repeats a `requestId`. So records dedupe here and usage
 * deduped where it is read — `firstOfResponse`, in the two aggregators.
 *
 * A record with no uuid is always kept: dropping it would be worse than
 * counting it twice, and the usage guard stops the one cost that would follow.
 */
function dedupeKey(record: SessionRecord): string | null {
  return record.uuid ?? null;
}

/**
 * Whether a record's own `gitBranch` is too weak to trust on its own —
 * absent, `"main"`, or the bare-repo root's `"HEAD"` — and so eligible for a
 * file's `resolveSessionBranch` fallback to fill in.
 *
 * Both readers below apply this exact same test before falling back, on
 * purpose: two readers with different rules produced a backfilled card and a
 * live card that disagreed about the same branch once already (see
 * `recordsByBranch`'s doc comment), and this is the same trap in miniature —
 * `recordsByBranch`'s cheap pre-parse reject on `'"gitBranch"'` would
 * otherwise drop a record with no `gitBranch` key at all before the fallback
 * ever saw it, while `readRecordsForBranch` would keep it.
 */
function isAmbiguousBranch(branch: string | undefined): boolean {
  return !branch || branch === "main" || branch === "HEAD";
}

/**
 * Whether a file's session fallback may claim this record: its branch is too
 * weak to trust, and it belongs to a session. Claude Code also writes
 * bookkeeping into a session file — file-history records among them — with a
 * timestamp but no session id; claimed, each would count as a session of its
 * own on the card.
 */
function fallbackClaims(record: SessionRecord): boolean {
  return isAmbiguousBranch(record.gitBranch) && typeof record.sessionId === "string";
}

/**
 * Subagent transcripts that carry no marker and whose own `gitBranch` is not a
 * task branch — so their spend lands on no card at all.
 *
 * Nothing enforces the marker; it is a line a skill instructs an agent to
 * write. This is what makes a forgotten one visible on the next card instead
 * of silently reproducing the under-reporting the marker exists to fix.
 */
export function unattributedSubagentFiles(
  sessionsDir: SessionsRoots,
  options: ReadOptions = {},
): number {
  let count = 0;

  for (const { file, isSubagent, ownedByRepo } of transcriptFiles(sessionsDir, options.repoPaths)) {
    if (!isSubagent || !ownedByRepo) continue;
    if (resolveDispatchBranch(file) !== null) continue;

    const head = firstLine(file);
    if (head === null) continue;

    let record: SessionRecord;
    try {
      record = JSON.parse(head) as SessionRecord;
    } catch {
      continue;
    }

    if (!record.gitBranch || record.gitBranch === "main" || record.gitBranch === "HEAD") count++;
  }

  return count;
}

/**
 * Every task branch a transcript mentions, with its records. One pass, for
 * `backfill`, which cards many branches at once and would otherwise re-read
 * hundreds of megabytes per branch.
 *
 * Shares `readRecordsForBranch`'s rules — marker resolution and `requestId`
 * dedupe — because two readers with different rules produced a backfilled card
 * and a live card that disagreed about the same branch.
 */
export function recordsByBranch(
  sessionsDir: SessionsRoots,
  options: ReadOptions = {},
): Map<string, SessionRecord[]> {
  const byBranch = new Map<string, SessionRecord[]>();
  const seen = new Set<string>();

  for (const { file, isSubagent, ownedByRepo } of transcriptFiles(sessionsDir, options.repoPaths)) {
    const resolved = isSubagent && ownedByRepo ? resolveDispatchBranch(file) : null;
    const sessionBranch = !isSubagent && ownedByRepo ? resolveSessionBranch(file) : null;

    let text: string;
    try {
      text = readFileSync(file, "utf8") as string;
    } catch {
      continue;
    }

    for (const line of text.split("\n")) {
      // Disabled whenever this file has a session-branch fallback: a record
      // with no `gitBranch` key at all is still `isAmbiguousBranch` and still
      // eligible for it, so this reject must never remove that record before
      // the fallback below gets to see it — the same requirement
      // `readRecordsForBranch` applies to its own pre-parse reject.
      if (resolved === null && sessionBranch === null && !line.includes('"gitBranch"')) continue;

      let record: SessionRecord;
      try {
        record = JSON.parse(line) as SessionRecord;
      } catch {
        continue;
      }

      const branch =
        resolved ?? (sessionBranch && fallbackClaims(record) ? sessionBranch : record.gitBranch);
      // `main` and the bare-repo `HEAD` are not task branches, and `card`
      // refuses both.
      if (!branch || branch === "main" || branch === "HEAD") continue;

      const key = dedupeKey(record);
      if (key !== null) {
        if (seen.has(key)) continue;
        seen.add(key);
      }

      const existing = byBranch.get(branch);
      if (existing) existing.push(record);
      else byBranch.set(branch, [record]);
    }
  }

  return byBranch;
}

/**
 * The records belonging to one branch.
 *
 * Two things beyond a `gitBranch` match. A subagent file's branch comes from
 * `resolveDispatchBranch` when the dispatch carried a marker — `gitBranch`
 * there is the *parent session's* and is wrong by construction. And a record
 * present in two session files is returned once; Claude Code sometimes writes
 * one conversation into two files, and both copies are real.
 */
export function readRecordsForBranch(
  sessionsDir: SessionsRoots,
  branch: string,
  options: ReadOptions = {},
): SessionRecord[] {
  const records: SessionRecord[] = [];
  const seen = new Set<string>();

  for (const { file, isSubagent, ownedByRepo } of transcriptFiles(sessionsDir, options.repoPaths)) {
    // One resolve per file, before any line is read. When it answers, it
    // answers for every record in the file — and it also decides whether the
    // per-line reject below can be used at all.
    // A marker admits a file only from a project directory this repository
    // owns; see `ReadOptions.repoPaths`.
    const resolved = isSubagent && ownedByRepo ? resolveDispatchBranch(file) : null;
    if (resolved !== null && resolved !== branch) continue;

    // A main-thread file's own fallback, from the single branch it cut for
    // itself (`resolveSessionBranch`). Unlike `resolved` above, a mismatch
    // here does not skip the whole file: it only ever adds records whose own
    // `gitBranch` is too weak to trust (`isAmbiguousBranch`), never removes
    // one that already carries a real, different branch.
    const sessionBranch = !isSubagent && ownedByRepo ? resolveSessionBranch(file) : null;
    const sessionFallbackApplies = sessionBranch === branch;

    let text: string;
    try {
      text = readFileSync(file, "utf8") as string;
    } catch {
      continue;
    }

    for (const line of text.split("\n")) {
      // These files run to tens of megabytes and most lines belong to other
      // branches, so reject before the parse. It cannot be used on a resolved
      // file, or when the session fallback could apply: both admit records
      // whose raw line never mentions `branch` at all — a resolved file's
      // lines are stamped with the parent's branch, and a session-fallback
      // record is stamped `main`/`HEAD`.
      if (resolved === null && !sessionFallbackApplies && !line.includes(branch)) continue;

      let record: SessionRecord;
      try {
        record = JSON.parse(line) as SessionRecord;
      } catch {
        continue;
      }

      if (resolved === null) {
        const matches =
          record.gitBranch === branch || (sessionFallbackApplies && fallbackClaims(record));
        if (!matches) continue;
      }

      const key = dedupeKey(record);
      if (key !== null) {
        if (seen.has(key)) continue;
        seen.add(key);
      }

      records.push(record);
    }
  }

  return records;
}

/** Memoised because the unattended fallback pays for every spawn it makes and
 * nothing here re-runs git for a changed working tree inside one invocation: a
 * `git rev-parse` costs about 8 ms, and the fallback made two of them before
 * reaching a guard that costs one file read. Keyed on the whole argument list,
 * so no two different questions share an answer. */
const gitAnswers = new Map<string, string>();

function git(args: string[]): string {
  const key = args.join("\u0000");
  const memo = gitAnswers.get(key);
  if (memo !== undefined) return memo;

  const result = Bun.spawnSync(["git", ...args], { stdout: "pipe", stderr: "pipe" });
  const out = result.success ? result.stdout.toString().trim() : "";
  gitAnswers.set(key, out);

  return out;
}

/**
 * A git call's exit code and stdout, run at the repository root.
 *
 * Separate from `git()` because the questions here are answered by the exit
 * code — `cat-file -e` prints nothing either way — and `git()` maps every
 * failure to "" and memoises it. `-C <root>` because `retro` runs this script
 * from `tools/pr-metrics`, where a pathspec would resolve inside the package.
 */
interface GitAnswer {
  ok: boolean;
  out: string;
}

function gitStatus(root: string, args: string[]): GitAnswer {
  const result = Bun.spawnSync(["git", "-C", root, ...args], { stdout: "pipe", stderr: "pipe" });

  return { ok: result.success, out: result.success ? result.stdout.toString() : "" };
}

/**
 * Read the review reports and count, for each counted finding, whether its line
 * changed after the review ran — or, for a tests finding, whether a test for
 * its file landed after it (`testedPaths`). `null` when no report could be
 * placed.
 *
 * The baseline — the commit the review read — is the newest commit on this
 * branch whose **author** time is no later than the report's mtime. Author
 * time, because a rebase between the review and this run resets every
 * committer time. On this branch only (first parent, after the merge base),
 * because a report left by another branch, or older than this branch's first
 * commit, describes code this branch never had; such a report is not read.
 */
export function summariseReviews(
  root: string,
  base: string,
  files: string[],
): ReviewSummary | null {
  const fs = require("node:fs") as typeof import("node:fs");

  const reports: { text: string; written: number }[] = [];
  for (const file of files) {
    try {
      const text = fs.readFileSync(file, "utf8");
      reports.push({ text, written: Math.floor(fs.statSync(file).mtimeMs / 1000) });
    } catch {
      // Absent: that review did not run, or its worktree has gone.
    }
  }
  // No report, no git: the common case on a branch nobody has reviewed yet.
  if (reports.length === 0) return null;

  const commits = gitStatus(root, ["log", "--first-parent", "--format=%H %at %ct", `${base}..HEAD`])
    .out.split("\n")
    .filter(Boolean)
    .map((line) => {
      const [sha, at, ct] = line.split(" ");

      return { sha, at: Number.parseInt(at, 10), ct: Number.parseInt(ct, 10) };
    });

  const summary: ReviewSummary = {
    reports: 0,
    findings: 0,
    located: 0,
    acted_on: 0,
    paired: 0,
    acted_on_paired: 0,
    control_changed: 0,
    acted_on_by_test: 0,
    acted_on_paired_by_test: 0,
  };

  for (const { text, written } of reports) {
    const baseline = commits.find((commit) => commit.at <= written);
    if (baseline === undefined) continue;
    // The newest commit, written before the review but committed after it:
    // the reviewed commit was amended or squashed, and any fix went into it.
    // Nothing after it is left to diff, so the report cannot be read — a zero
    // here would claim the fixes did not happen.
    if (baseline === commits[0] && baseline.ct > written) continue;

    summary.reports += 1;

    const findings = parseFindings(text);
    const candidates = findings.map(({ issue }) =>
      issue === null ? [] : locationsIn(issue, root),
    );
    const lengths = lineCounts(
      root,
      baseline.sha,
      candidates.flat().map(({ path }) => path),
    );

    const located = candidates.map((options) =>
      options.find(({ path, line }) => {
        const length = lengths.get(path);

        return length !== undefined && line >= 1 && line <= length;
      }),
    );
    const ranges = changedRangesByPath(
      root,
      baseline.sha,
      located.flatMap((location) => (location ? [location.path] : [])),
    );
    // Only a tests finding whose window did not change can count by its test.
    const tested = testedPaths(
      root,
      baseline.sha,
      located.flatMap((location, i) =>
        location &&
        findings[i].kind === "T" &&
        !windowTouched(ranges.get(location.path) ?? [], location.line)
          ? [location.path]
          : [],
      ),
    );

    summary.findings += findings.length;

    for (const [i, location] of located.entries()) {
      if (location === undefined) continue;

      summary.located += 1;
      const changed = ranges.get(location.path) ?? [];
      const lineChanged = windowTouched(changed, location.line);
      const byTest = !lineChanged && findings[i].kind === "T" && tested.has(location.path);
      if (lineChanged || byTest) summary.acted_on += 1;
      if (byTest) summary.acted_on_by_test = (summary.acted_on_by_test ?? 0) + 1;

      const control = controlLine(location.line, lengths.get(location.path) ?? 0);
      if (control === null) continue;

      summary.paired += 1;
      if (lineChanged || byTest) summary.acted_on_paired += 1;
      if (byTest) summary.acted_on_paired_by_test = (summary.acted_on_paired_by_test ?? 0) + 1;
      if (windowTouched(changed, control)) summary.control_changed += 1;
    }
  }

  return summary.reports > 0 ? summary : null;
}

/** Each path's blob at `sha`, from one `cat-file --batch`. A path absent there
 * or naming no blob has no entry, and neither does one holding a newline (the
 * input is one path per line) or starting `../`: git reads that against the
 * working directory, and one that leaves the repository ends the whole batch. */
function blobsAt(root: string, sha: string, paths: string[]): Map<string, Uint8Array> {
  const unique = [...new Set(paths)].filter(
    (path) => !path.includes("\n") && path !== ".." && !path.startsWith("../"),
  );
  const blobs = new Map<string, Uint8Array>();
  if (unique.length === 0) return blobs;

  const result = Bun.spawnSync(["git", "-C", root, "cat-file", "--batch"], {
    stdin: Buffer.from(unique.map((path) => `${sha}:${path}\n`).join("")),
    stdout: "pipe",
    stderr: "pipe",
  });
  if (!result.success) return blobs;

  // Each answer is `<oid> <type> <size>\n<size bytes>\n`, or `<input> missing\n`
  // with no body. A path can hold spaces, so a missing answer is told by its
  // ending, not by how many words it has.
  const out = result.stdout;
  let at = 0;
  for (const path of unique) {
    const end = out.indexOf(10, at);
    if (end < 0) break;

    const header = out.subarray(at, end).toString();
    at = end + 1;
    if (header.endsWith(" missing")) continue;

    const [, type, sizeText] = header.split(" ");
    const size = Number.parseInt(sizeText, 10);
    if (!Number.isInteger(size)) break;

    if (type === "blob") blobs.set(path, out.subarray(at, at + size));
    at += size + 1;
  }

  return blobs;
}

/** Each path's line count at `sha`; a path absent there has no entry. */
function lineCounts(root: string, sha: string, paths: string[]): Map<string, number> {
  const counts = new Map<string, number>();

  for (const [path, body] of blobsAt(root, sha, paths)) {
    let lines = 0;
    for (const byte of body) if (byte === 10) lines += 1;
    if (body.length > 0 && body[body.length - 1] !== 10) lines += 1;
    counts.set(path, lines);
  }

  return counts;
}

/**
 * A relative specifier in a form that loads a module: `from`, a bare or
 * dynamic `import`, `require`, `importActual`, a mock (`vi.mock`, `doMock`,
 * `mock.module`) or `new URL(…, import.meta.url)`. A path in a plain string is
 * not one. The whitespace after the keyword and the whitespace inside the
 * optional `(` are separate runs, so a keyword followed by whitespace and no
 * quote fails in time linear in the run, not quadratic.
 */
const MODULE_REFERENCE =
  /(?:\bfrom|\bimport|\brequire|\bimportActual|[mM]ock|\bmodule|\bURL)\s*(?:\(\s*)?["'](\.{1,2}\/[^"'\n]*)["']/g;

const CODE_EXTENSION = /\.[cm]?[jt]sx?$/;

/** What a path is imported as: no trailing `/`, no code extension, and a
 * directory's `index` named by the directory. */
function moduleId(path: string): string {
  const bare = path.replace(/\/+$/, "").replace(CODE_EXTENSION, "");

  return bare.endsWith("/index") ? bare.slice(0, -"/index".length) : bare;
}

/**
 * Each path's package: the deepest directory above it that holds a
 * `package.json` or a `tests/` directory at HEAD, or the repository root (`""`)
 * where none does. A `tests/` directory counts because `scripts/` keeps its
 * tests there with no `package.json`; HEAD, because the fix for an untested
 * file can be the commit that creates `tests/`.
 */
function packageRoots(root: string, paths: string[]): Map<string, string> {
  const ancestors = (path: string): string[] => {
    const parts = path.split("/").slice(0, -1);

    return parts.map((_, i) => parts.slice(0, parts.length - i).join("/"));
  };

  const markers = [
    ...new Set(paths.flatMap(ancestors).flatMap((dir) => [`${dir}/package.json`, `${dir}/tests`])),
  ];
  const present = new Set<string>();
  if (markers.length > 0) {
    const result = Bun.spawnSync(["git", "-C", root, "cat-file", "--batch-check"], {
      stdin: Buffer.from(markers.map((marker) => `HEAD:${marker}\n`).join("")),
      stdout: "pipe",
      stderr: "pipe",
    });
    // One line per input, in order: `<oid> <type> <size>`, or `<input> missing`.
    const answers = result.success ? result.stdout.toString().split("\n") : [];
    markers.forEach((marker, i) => {
      if (answers[i] !== undefined && !answers[i].endsWith(" missing") && answers[i] !== "") {
        present.add(marker.slice(0, marker.lastIndexOf("/")));
      }
    });
  }

  return new Map(
    paths.map((path) => [path, ancestors(path).find((dir) => present.has(dir)) ?? ""]),
  );
}

/**
 * The cited paths a test landed for after the review: a commit since `sha`
 * added lines to a file under the same package's `tests/`, and that file, as
 * it stands at HEAD, imports the cited path by a relative specifier. An import
 * by package name is not resolved.
 */
function testedPaths(root: string, sha: string, paths: string[]): Set<string> {
  const tested = new Set<string>();
  if (paths.length === 0) return tested;

  const packages = packageRoots(root, paths);
  const testDirs = [...new Set(packages.values())].map((pkg) =>
    pkg === "" ? "tests/" : `${pkg}/tests/`,
  );

  // `-z` so a path git would quote arrives verbatim: `<added>\t<deleted>\t<path>\0`.
  const numstat = gitStatus(root, [
    "diff",
    "--numstat",
    "-z",
    "--no-renames",
    sha,
    "HEAD",
    "--",
    ...testDirs.map((dir) => `:(top)${dir}`),
  ]);
  const grown = numstat.out.split("\0").flatMap((entry) => {
    const [added, , ...rest] = entry.split("\t");
    const count = Number(added);

    return rest.length > 0 && Number.isInteger(count) && count > 0 ? [rest.join("\t")] : [];
  });

  const references = new Set<string>();
  for (const [file, body] of blobsAt(root, "HEAD", grown)) {
    // The package whose tests/ holds the file; the deepest one when nested.
    const owner = testDirs.reduce<string | undefined>(
      (best, dir) =>
        file.startsWith(dir) && (best === undefined || dir.length > best.length) ? dir : best,
      undefined,
    );
    if (owner === undefined) continue;

    const text = new TextDecoder().decode(body);
    for (const match of text.matchAll(MODULE_REFERENCE)) {
      const resolved = posix.normalize(posix.join(posix.dirname(file), match[1]));
      references.add(`${owner}\0${moduleId(resolved)}`);
    }
  }

  for (const path of paths) {
    const pkg = packages.get(path) ?? "";
    const dir = pkg === "" ? "tests/" : `${pkg}/tests/`;
    if (references.has(`${dir}\0${moduleId(path)}`)) tested.add(path);
  }

  return tested;
}

/** Old-side changed ranges per path between `sha` and HEAD, from one diff. */
function changedRangesByPath(
  root: string,
  sha: string,
  paths: string[],
): Map<string, [number, number][]> {
  const unique = [...new Set(paths)];
  const ranges = new Map<string, [number, number][]>();
  if (unique.length === 0) return ranges;

  const diff = gitStatus(root, [
    "diff",
    "-U0",
    "--no-renames",
    sha,
    "HEAD",
    "--",
    ...unique.map((path) => `:(top)${path}`),
  ]);

  // Every path here existed at `sha`, so each file's section names it on its
  // `--- a/` line, deleted files included.
  for (const section of diff.out.split(/^diff --git /m)) {
    const old = /^--- a\/(.+)$/m.exec(section);
    if (old) ranges.set(old[1], changedRanges(section));
  }

  return ranges;
}

/** One `gh` invocation's stdout, or `null` where `gh` is missing, unauthenticated
 * or simply had nothing to say. Never throws: every caller here is a best-effort
 * lookup on a path that must still produce a card without it. */
function gh(args: string[]): string | null {
  try {
    const result = Bun.spawnSync(["gh", ...args], { stdout: "pipe", stderr: "pipe" });
    if (!result.success) return null;
    const out = result.stdout.toString().trim();

    return out === "" ? null : out;
  } catch {
    return null;
  }
}

/** A pull request's state and merge time from `gh`, or both `null` where the
 * call fails or answers with something else. */
function mergeState(number: number): Pick<BranchPull, "mergedAt" | "state"> {
  const raw = gh(["pr", "view", String(number), "--json", "state,mergedAt"]);
  if (raw === null) return { mergedAt: null, state: null };

  try {
    const parsed = JSON.parse(raw) as { state?: unknown; mergedAt?: unknown };
    const state =
      parsed.state === "MERGED" || parsed.state === "OPEN" || parsed.state === "CLOSED"
        ? parsed.state
        : null;
    const mergedAt =
      typeof parsed.mergedAt === "string" && parsed.mergedAt !== "" ? parsed.mergedAt : null;

    return { mergedAt, state };
  } catch {
    return { mergedAt: null, state: null };
  }
}

/** A repository's `nameWithOwner`, the only shape trusted from `gh` or a flag. */
const NAME_WITH_OWNER = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;

/**
 * This repository's canonical `owner/name`: what `gh repo view` answers for
 * `typed`, or for the checkout when `typed` is null. `gh` follows a renamed
 * owner and returns GitHub's own case, so a comparison against the answer
 * holds under any rename or casing of the name a caller typed.
 *
 * Where `gh` cannot answer, or answers something that is not an `owner/name`
 * pair, the typed name stands in (compared ignoring case by
 * {@link sameRepository}), and with no typed name there is no repository and
 * nothing is fetched. Silent on failure: callers decide what a missing answer
 * means for them.
 */
export function resolveRepo(typed: string | null = null): string | null {
  const answer = gh([
    "repo",
    "view",
    ...(typed === null ? [] : [typed]),
    "--json",
    "nameWithOwner",
    "--jq",
    ".nameWithOwner",
  ]);
  if (answer !== null && NAME_WITH_OWNER.test(answer)) return answer;

  return typed !== null && NAME_WITH_OWNER.test(typed) ? typed : null;
}

/** Whether a linked issue lives in `repo`. GitHub names are case-insensitive. */
export function sameRepository(ref: IssueReference, repo: string): boolean {
  return (
    `${ref.repository.owner.login}/${ref.repository.name}`.toLowerCase() === repo.toLowerCase()
  );
}

/** What `--resolve-issue` recovers: the pull request for a branch, the issue
 * the branch was cut for, and the declared complexity of what it closes. */
interface ResolvedIdentity {
  prNumber: number | null;
  issueNumber: number | null;
  labels: string[];
  method: ComplexityMethod;
  declared: number | null;
  issues: number;
}

/** One issue's label names, or `null` when the call did not land. JSON rather
 * than a joined string, so an issue with no labels reads as an empty list and
 * not as a failed call. */
function fetchIssueLabels(issue: number, repo: string): string[] | null {
  const raw = gh(["issue", "view", String(issue), "--repo", repo, "--json", "labels"]);
  if (raw === null) return null;

  try {
    const parsed = JSON.parse(raw) as { labels?: { name?: unknown }[] };
    if (!Array.isArray(parsed.labels)) return null;

    return parsed.labels.map((label) => label.name).filter((name) => typeof name === "string");
  } catch {
    return null;
  }
}

/**
 * Recover a branch's pull request, issue and rating from `gh`, for a run that
 * was given none of them.
 *
 * The `SessionEnd` fallback in `.claude/settings.json` has no way to know them:
 * it fires as a session closes, often before a pull request exists at all, and
 * then records nothing. `retro` runs it once the pull request is open.
 *
 * The rules are `wiki/conventions/session-metrics.md` §Which issue a card
 * names: {@link selectIssues} names the issue, {@link decideComplexity} sums
 * the ratings. **Labels are read only from an issue in this same repository.**
 * Most of this repository's pull requests close a finding in the private
 * `englishstreetventures/osn-tracker`, whose `severity:`/`area:` labels must
 * never reach a card committed to a public one, so such an issue is never asked
 * about. `backfill.ts` draws the same outcomes from the same functions.
 *
 * `explicitIssue` is `--issue`: it names the issue and nothing else, so the
 * rating is still the sum of what the pull request closes. The card is public,
 * so it is refused when it is the number of another repository's issue the
 * pull request links and no issue of this repository's with that number is
 * linked too: the card then names no issue. With no pull request there is
 * nothing to check it against, and it stands as given.
 */
function resolveIdentity(branch: string, explicitIssue: number | null): ResolvedIdentity {
  const miss: ResolvedIdentity = {
    prNumber: null,
    issueNumber: explicitIssue,
    labels: [],
    method: "none",
    declared: null,
    issues: 0,
  };

  const repo = resolveRepo();
  const listed = gh([
    "pr",
    "list",
    "--head",
    branch,
    "--state",
    "all",
    "--limit",
    "1",
    "--json",
    "number,body,closingIssuesReferences",
  ]);
  if (listed === null) return miss;

  let pulls: { number: number; body: string | null; closingIssuesReferences: IssueReference[] }[];
  try {
    pulls = JSON.parse(listed) as typeof pulls;
  } catch {
    return miss;
  }

  const pull = pulls[0];
  if (pull === undefined) return miss;

  // NEW-FEAT.md is this checkout's scratch file, so it speaks for the branch
  // only when this checkout has that branch out.
  const onBranch = git(["rev-parse", "--abbrev-ref", "HEAD"]) === branch;
  const plan = onBranch ? readTextFile(`${repoRoot()}/NEW-FEAT.md`) : null;

  const selection = selectIssues({
    body: pull.body ?? "",
    refs: pull.closingIssuesReferences ?? [],
    repo,
    preferred: plan === null ? null : newFeatIssue(plan, branch, repo),
    closedFromBody: true,
  });

  const refs = pull.closingIssuesReferences ?? [];
  const body = bodyIssueLinks(pull.body ?? "", repo);
  const elsewhere = new Set([
    ...body.foreignCloses,
    ...body.foreignPartOf,
    ...refs.filter((ref) => repo === null || !sameRepository(ref, repo)).map((ref) => ref.number),
  ]);
  const here = new Set([...selection.closed, ...selection.partOf]);
  const refused =
    explicitIssue !== null && elsewhere.has(explicitIssue) && !here.has(explicitIssue);
  if (refused) {
    process.stderr.write(
      `⚠️  pr-metrics: --issue ${explicitIssue} is the number of another repository's issue that pull request #${pull.number} links, and a card is public, so the card names no issue.\n`,
    );
  }
  const issueNumber = refused ? null : (explicitIssue ?? selection.issue);

  if (issueNumber === null && selection.candidates.length > 1) {
    process.stderr.write(
      `⚠️  pr-metrics: pull request #${pull.number} closes ${selection.candidates.map((n) => `#${n}`).join(", ")} and nothing says which one the branch was cut for, so the card names none. Its rating is still their sum. Pass --issue to name one.\n`,
    );
  }

  const identity = { ...miss, prNumber: pull.number, issueNumber };
  if (repo === null) return { ...identity, method: "not-fetched" };

  const labels = new Map<number, string[] | null>();
  for (const issue of selection.closed) labels.set(issue, fetchIssueLabels(issue, repo));

  const decision = decideComplexity(selection, labels);
  if (decision.unrated.length > 0) {
    process.stderr.write(
      `⚠️  pr-metrics: ${decision.unrated.map((n) => `#${n}`).join(", ")} carries no complexity: rating, so the sum of what pull request #${pull.number} closes is unknown and the card records none.\n`,
    );
  }

  return {
    ...identity,
    labels: issueNumber === null ? [] : (labels.get(issueNumber) ?? []),
    method: decision.method,
    declared: decision.declared,
    issues: decision.issues,
  };
}

/** A file's text, or `null` when it cannot be read. */
function readTextFile(path: string): string | null {
  try {
    return readFileSync(path, "utf8") as string;
  } catch {
    return null;
  }
}

/**
 * The branch a stacked branch was cut from, as `wiki/conventions/stacked-prs.md`
 * tells a worktree to record it (`git config branch.<name>.gh-merge-base`), or
 * `null` for an unstacked branch. The parent is read from `origin` when the
 * remote has it, so the diff runs against what the pull request will merge into.
 */
export function parentBranch(branch: string): string | null {
  const parent = git(["config", "--get", `branch.${branch}.gh-merge-base`]);
  // A branch name cannot start with `-`. Passed to `git diff`, such a value
  // would be read as an option, so it is refused rather than used.
  if (!parent || parent.startsWith("-")) return null;

  return git(["rev-parse", "--verify", "--quiet", `origin/${parent}`])
    ? `origin/${parent}`
    : parent;
}

/**
 * A pull-request body with the parts GitHub reads no closing keyword in taken
 * out: fenced code blocks, inline code spans, HTML comments and table rows.
 *
 * Every step is a forward scan with `indexOf`, never a backtracking pattern, so
 * a body of unclosed `<!--` or lone backticks costs time in proportion to its
 * length. An unclosed comment runs to the end of the body, as it does in HTML.
 */
function proseOnly(body: string): string {
  let uncommented = "";
  for (let at = 0; ;) {
    const open = body.indexOf("<!--", at);
    if (open === -1) {
      uncommented += body.slice(at);
      break;
    }
    uncommented += body.slice(at, open);
    const close = body.indexOf("-->", open + 4);
    if (close === -1) break;
    at = close + 3;
  }

  const kept: string[] = [];
  let fence: string | null = null;

  for (const line of uncommented.split("\n")) {
    const trimmed = line.trimStart();
    const marker = trimmed.startsWith("```") ? "```" : trimmed.startsWith("~~~") ? "~~~" : null;
    if (fence !== null) {
      if (marker === fence) fence = null;
      continue;
    }
    if (marker !== null) {
      fence = marker;
      continue;
    }
    if (trimmed.startsWith("|")) continue;

    kept.push(withoutCodeSpans(line));
  }

  return kept.join("\n");
}

/** One line with its inline code spans removed. A run of backticks opens a span
 * that the next run of the same length closes; a run with no partner is
 * literal text. A length searched for and not found is not searched for again,
 * which keeps a line of lone backticks linear. */
function withoutCodeSpans(line: string): string {
  if (!line.includes("`")) return line;

  let out = "";
  let at = 0;
  const unmatched = new Set<number>();

  while (at < line.length) {
    const open = line.indexOf("`", at);
    if (open === -1) {
      out += line.slice(at);
      break;
    }
    let end = open;
    while (line[end] === "`") end += 1;
    const run = end - open;
    out += line.slice(at, open);

    const close = unmatched.has(run) ? -1 : findRun(line, run, end);
    if (close === -1) {
      unmatched.add(run);
      out += line.slice(open, end);
      at = end;
    } else {
      at = close + run;
    }
  }

  return out;
}

/** Where the next run of exactly `length` backticks starts, from `from`. */
function findRun(line: string, length: number, from: number): number {
  const ticks = "`".repeat(length);
  for (let at = line.indexOf(ticks, from); at !== -1; at = line.indexOf(ticks, at + 1)) {
    const before = at > 0 && line[at - 1] === "`";
    const after = line[at + length] === "`";
    if (!before && !after) return at;
    // Skip the whole longer run rather than every offset inside it.
    let end = at;
    while (line[end] === "`") end += 1;
    at = end - 1;
  }

  return -1;
}

/**
 * The issues a pull-request body links with a closing or `Part of` keyword, in
 * body order, from its prose only (see {@link proseOnly}).
 *
 * A bare `#N` is this repository's issue. A qualified `owner/name#N` is this
 * repository's when it names `repo`, and otherwise another repository's: its
 * number goes to `foreignCloses` or `foreignPartOf`, never to `closes` or
 * `partOf`. With no `repo`, every qualified reference is foreign.
 */
export interface BodyIssueLinks {
  /** This repository's issues the pull request closes on merge. */
  closes: number[];
  /** Issues it only advances: a `Part of` line, for partial work. */
  partOf: number[];
  /** Another repository's issues it closes. */
  foreignCloses: number[];
  /** Another repository's issues it only advances. */
  foreignPartOf: number[];
}

export function bodyIssueLinks(body: string, repo: string | null = null): BodyIssueLinks {
  // The alternatives have no overlapping quantifiers, so a long run of spaces
  // after a keyword cannot backtrack quadratically on a crafted pull-request body.
  const matches = proseOnly(body).matchAll(
    /\b(close[sd]?|fix(?:e[sd])?|resolve[sd]?|part\s+of)(?::\s*|\s+)([A-Za-z0-9-]+\/[A-Za-z0-9._-]+)?#(\d+)\b/gi,
  );
  const closes = new Set<number>();
  const partOf = new Set<number>();
  const foreignCloses = new Set<number>();
  const foreignPartOf = new Set<number>();

  for (const [, keyword = "", qualifier, digits = ""] of matches) {
    const number = Number(digits);
    const here =
      qualifier === undefined || (repo !== null && qualifier.toLowerCase() === repo.toLowerCase());
    const advances = /^part/i.test(keyword);

    if (!here) {
      (advances ? foreignPartOf : foreignCloses).add(number);
      continue;
    }
    if (advances) partOf.add(number);
    else closes.add(number);
  }

  return {
    closes: [...closes],
    partOf: [...partOf],
    foreignCloses: [...foreignCloses],
    foreignPartOf: [...foreignPartOf],
  };
}

/** What a pull request links, and which of its issues is the branch's own. */
export interface IssueSelection {
  /** The issue the branch was cut for, or `null` when nothing says. */
  issue: number | null;
  /** Issues in this repository the pull request closes, each once. */
  closed: number[];
  /** Issues in this repository it only advances. */
  partOf: number[];
  /** It also closes an issue in another repository. */
  foreign: boolean;
  /** When `issue` is null: the issues it could have been, for the warning. */
  candidates: number[];
}

/**
 * Name the branch's own issue and the set it closes, from the pull request's
 * body and GitHub's `closingIssuesReferences`.
 *
 * The issue, first that applies: `preferred` (the branch's `NEW-FEAT.md`)
 * when the pull request links it; the first `Closes` line of the body; the
 * first `Part of` line; the one reference GitHub lists. Never a position in
 * GitHub's list: it is ordered by issue number, not by what the branch was cut
 * for. `preferred` only chooses among the pull request's own links — a scratch
 * file never introduces an issue the pull request does not name.
 *
 * The closed set: an open pull request (`closedFromBody`) is credited with its
 * body's `Closes` lines as well as GitHub's references, since a stacked pull
 * request has none of the latter until it is retargeted. A merged one is
 * credited with GitHub's references alone — they are what the merge closed.
 */
export function selectIssues(input: {
  body: string;
  refs: IssueReference[];
  repo: string | null;
  preferred?: number | null;
  closedFromBody: boolean;
}): IssueSelection {
  const { body, refs, repo, preferred = null, closedFromBody } = input;
  const links = bodyIssueLinks(body, repo);
  const here = repo === null ? [] : refs.filter((ref) => sameRepository(ref, repo));
  const referenced = [...new Set(here.map((ref) => ref.number))];

  const closed = [...new Set([...(closedFromBody ? links.closes : []), ...referenced])];
  const partOf = links.partOf.filter((number) => !closed.includes(number));
  const foreign = links.foreignCloses.length > 0 || here.length < refs.length;
  const linked = new Set([...closed, ...partOf, ...links.closes]);

  const issue =
    (preferred !== null && linked.has(preferred) ? preferred : null) ??
    links.closes[0] ??
    links.partOf[0] ??
    (referenced.length === 1 ? (referenced[0] ?? null) : null);

  return {
    issue,
    closed,
    partOf,
    foreign,
    candidates: issue === null && referenced.length > 1 ? referenced : [],
  };
}

/** The denominator a card records, and the closed issues that had no rating. */
export interface ComplexityDecision {
  declared: number | null;
  method: ComplexityMethod;
  issues: number;
  unrated: number[];
}

/**
 * The declared complexity of what a pull request does: the sum of the ratings
 * of every issue in this repository it closes.
 *
 * Summed, because a branch that closes three issues did three issues' work,
 * and dividing its spend by one of their ratings makes it read three times as
 * expensive as it was. The sum is `confirmed` only when every part is. It is
 * unknown — never partial — when one closed issue has no rating or its labels
 * could not be read: a partial sum understates the work the same way one
 * issue's rating does.
 *
 * A pull request that closes nothing here but advances an issue (`Part of`)
 * records `part-of`: that issue's rating describes more than the branch did.
 * One that closes only another repository's issue records `not-fetched`; that
 * issue is never asked about.
 */
export function decideComplexity(
  selection: IssueSelection,
  labels: Map<number, string[] | null>,
): ComplexityDecision {
  const unknown = (method: ComplexityMethod, unrated: number[] = []): ComplexityDecision => ({
    declared: null,
    method,
    issues: 0,
    unrated,
  });

  if (selection.closed.length > 0) {
    const found = selection.closed.map((issue) => labels.get(issue) ?? null);
    if (found.some((names) => names === null)) return unknown("lookup-failed");

    const ratings = found.map((names) => declaredFromLabels(names ?? []));
    const unrated = selection.closed.filter((_, i) => ratings[i]?.declared === null);
    if (unrated.length > 0) return unknown("none", unrated);

    return {
      declared: ratings.reduce((sum, rating) => sum + (rating.declared ?? 0), 0),
      method: ratings.some((rating) => rating.method === "unconfirmed")
        ? "unconfirmed"
        : "confirmed",
      issues: ratings.length,
      unrated: [],
    };
  }

  if (selection.partOf.length > 0) return unknown("part-of");
  if (selection.foreign) return unknown("not-fetched");

  return unknown("none");
}

/** The longest stretch of `NEW-FEAT.md` read for its header lines. */
const NEW_FEAT_HEADER_LINES = 30;

/**
 * The issue a branch's `NEW-FEAT.md` names, or `null`.
 *
 * `new-feat` writes the file at the root of the checkout and opens it with the
 * branch name and an `Issue:` line. It is untracked scratch, so it survives a
 * branch switch in a reused checkout: the file speaks for `branch` only when
 * its first lines name that branch as a whole word. The issue is the first
 * reference on the first line labelled `Issue` or `Issues` (followed by `:` or,
 * in a table, `|`). A bare `#N`, `<repo>#N` or an issues URL of `repo` is this
 * repository's, and a Markdown link counts by its target, not its text; any
 * other repository's reference — the private tracker's above all — ends the
 * search with no number, so a tracker number is never read as a public issue.
 */
export function newFeatIssue(text: string, branch: string, repo: string | null): number | null {
  const header = text.split("\n", NEW_FEAT_HEADER_LINES);
  const namesBranch = header.some((line) => {
    for (let at = line.indexOf(branch); at !== -1; at = line.indexOf(branch, at + 1)) {
      const before = line[at - 1] ?? "";
      const after = line[at + branch.length] ?? "";
      if (!/[\w./-]/.test(before) && !/[\w./-]/.test(after)) return true;
    }

    return false;
  });
  if (!namesBranch) return null;

  const labelled = header.find((line) => /^\s*(?:[-*]\s+|\|\s*)?\**Issues?\**\s*[:|]/i.test(line));
  if (labelled === undefined) return null;

  // A Markdown link's target decides which repository it names, whatever its
  // text says: `[#712](…/osn-tracker/issues/712)` is the tracker's issue.
  const value = labelled
    .replace(/^\s*(?:[-*]\s+|\|\s*)?\**Issues?\**\s*[:|]/i, "")
    .replaceAll(/\[[^\]\n]*\]\(([^)\s]*)\)/g, " $1 ");
  const reference =
    /(?:https?:\/\/github\.com\/([A-Za-z0-9-]+\/[A-Za-z0-9._-]+)\/issues\/(\d+))|(?:([A-Za-z0-9-]+\/[A-Za-z0-9._-]+)#(\d+))|(?:(?<![\w/.-])#(\d+))/.exec(
      value,
    );
  if (reference === null) return null;

  const [, urlRepo, urlNumber, refRepo, refNumber, bareNumber] = reference;
  if (bareNumber !== undefined) return Number(bareNumber);

  const named = urlRepo ?? refRepo ?? "";
  const number = urlNumber ?? refNumber ?? "";

  return repo !== null && named.toLowerCase() === repo.toLowerCase() ? Number(number) : null;
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

  // `--if-absent` exists for one caller: the unattended `SessionEnd` fallback in
  // `.claude/settings.json`. That run carries no `--pr`, `--issue` or
  // `--issue-labels`, so the card it builds is identity-less — and writing it
  // over the one `retro` committed would strip the pull request, the issue and
  // the `complexity.declared` every session-metrics query divides spend by,
  // silently, into a working tree nobody is watching at session end. So the
  // fallback writes a card for a branch that has none and never touches one
  // that exists. `retro` owns the identity-bearing write and always overwrites.
  const outDir = flag("out-dir") ?? defaultMetricsDir();
  const slugPath = `${outDir}/${branchSlug(branch)}.json`;

  // One read serves the `--if-absent` check. `branchSlug` turns `/` and
  // anything else outside `[A-Za-z0-9._-]` into `-`, so `feat/a-b` and
  // `feat-a-b` land on one file, and `.claude/metrics/` is tracked, so every
  // worktree already holds every merged branch's card. `ownCard` is the card
  // only when it is this branch's: without that, `--if-absent` would read a
  // colliding neighbour as this branch's card and leave that other branch's
  // spend and `tool_calls` standing as this one's public record — silently,
  // since the hook discards its output. On a reused branch name the earlier
  // pull request's card is this branch's too, so the fallback leaves it alone
  // and `retro` writes the later one.
  const slugCard = readCardFile(slugPath);
  const ownCard = slugCard !== null && slugCard.pr.branch === branch ? slugCard : null;

  // Checked here rather than beside the write below so the fallback costs one
  // read and not a transcript scan — `SessionEnd` hooks run on a timeout.
  // `--format markdown` writes nothing at all, so it is never what is skipped.
  //
  // What counts as present is a card that parses, not a file that exists. The
  // un-flagged path below rewrites an unreadable card rather than preserving
  // it, and this has to agree: a hook killed at its timeout mid-write leaves a
  // truncated file, and a guard keyed on existence alone would then protect
  // that forever, with nothing but a human running `retro` to repair it.
  const skipExisting =
    Bun.argv.includes("--if-absent") && flag("format") !== "markdown" && ownCard !== null;

  if (skipExisting) {
    console.log(`pr-metrics: ${slugPath} already exists — leaving it alone (--if-absent).`);
    process.exit(0);
  }

  const issueLabels = (flag("issue-labels") ?? "").split(",").filter(Boolean);

  // The labels are the normal source — `retro` passes whatever the issue
  // carries and the rating comes along with them, so nobody has to retype a
  // number the issue already holds. `--complexity` stays as an override for a
  // branch with no issue, and it is recorded as `manual` so a hand-typed
  // rating never sits in a query beside one an owner confirmed on an issue.
  const fromLabels = declaredFromLabels(issueLabels);
  const override = flag("complexity");

  // `--resolve-issue` is the unattended fallback's other half. Explicit flags
  // always win: a caller that named the pull request, the issue or the labels
  // knows more than `gh` does, and only the gaps it left are filled in.
  // `--issue` names the issue and nothing else, so the lookup still runs for
  // the pull request and the sum of what it closes; `--issue-labels` supplies
  // the rating itself and turns the lookup off.
  const explicitIssue = flag("issue") ? Number.parseInt(flag("issue") as string, 10) : null;
  const resolved =
    Bun.argv.includes("--resolve-issue") && issueLabels.length === 0
      ? resolveIdentity(branch, explicitIssue)
      : null;

  const prNumber = flag("pr")
    ? Number.parseInt(flag("pr") as string, 10)
    : (resolved?.prNumber ?? null);

  // A branch name an earlier pull request used: its card keeps `<slug>.json`,
  // and this one goes to `<slug>-<pr>.json`. A run that names no pull request
  // cannot name that file, and a slug neighbour's card (another branch name)
  // is not a reuse; both fall to the refusal below.
  const reused =
    prNumber !== null &&
    ownCard !== null &&
    typeof ownCard.pr.number === "number" &&
    ownCard.pr.number !== prNumber;
  const outPath = reused ? `${outDir}/${cardFileName(branch, prNumber, false)}` : slugPath;
  const onDisk = reused ? readCardFile(outPath) : slugCard;
  const existing = onDisk !== null && onDisk.pr.branch === branch ? onDisk : null;

  // Checked before a single transcript is read, since a refused run would
  // discard the scan, and before the markdown render as well as the write:
  // `retro` appends that render to the pull-request body, and it is built from
  // the same transcripts the card would be. Against `onDisk`, not `existing`,
  // because a slug neighbour's card is another pull request's record too.
  const owner = otherPullRequest(onDisk, prNumber);

  if (owner !== null) {
    const thisRun = prNumber === null ? "names no pull request" : `is for #${prNumber}`;
    process.stderr.write(
      [
        `❌ pr-metrics: ${outPath} is the card for pull request #${owner}, and this run ${thisRun}.`,
        "   Transcripts are joined to a card by branch name alone, so this card would carry",
        `   #${owner}'s sessions as well. Nothing was written.`,
        "   - `gh` named the wrong pull request, or none: pass --pr <n>.",
        "   - Another branch name flattens to the same file: report it.",
        `   - Both pull requests are one piece of work: delete ${outPath} and run again.`,
        "",
      ].join("\n"),
    );
    process.exit(1);
  }

  // The other pull requests on this branch name decide which records are this
  // one's. Only a `--resolve-issue` run asks `gh`, as for the identity above.
  const resolveMerges = Bun.argv.includes("--resolve-issue");
  const others: BranchPull[] = branchCards(outDir, branch)
    .filter(({ card: c }) => typeof c.pr.number === "number" && c.pr.number !== prNumber)
    .map(({ card: c }): BranchPull => {
      const number = c.pr.number as number;
      if (typeof c.pr.merged_at === "string") {
        return { number, mergedAt: c.pr.merged_at, state: "MERGED" };
      }

      const asked = resolveMerges ? mergeState(number) : null;

      return { number, mergedAt: asked?.mergedAt ?? null, state: asked?.state ?? null };
    });

  let selfMergedAt = flag("merged-at") ?? existing?.pr.merged_at ?? null;
  if (selfMergedAt === null && others.length > 0 && resolveMerges && prNumber !== null) {
    selfMergedAt = mergeState(prNumber).mergedAt;
  }

  const window = recordWindow({ mergedAt: selfMergedAt }, others);

  if (window.kind === "unplaceable" && window.pull === null) {
    process.stderr.write(
      [
        `❌ pr-metrics: this run's own merge time, ${JSON.stringify(selfMergedAt)}, is not a date, so`,
        "   it cannot be placed beside the other pull requests on this branch name.",
        "   Nothing was written. Pass --merged-at as an ISO 8601 time.",
        "",
      ].join("\n"),
    );
    process.exit(1);
  }

  if (window.kind === "unplaceable") {
    const otherFile = branchCards(outDir, branch).find((c) => c.card.pr.number === window.pull);
    const why =
      window.reason === "closed"
        ? [
            `   #${window.pull} closed without merging, so no merge separates its sessions from this run's.`,
            `   - Both pull requests are one piece of work: delete ${outDir}/${otherFile?.file ?? `${branchSlug(branch)}.json`} and run again.`,
          ]
        : [
            `   #${window.pull}'s merge time is unknown: its card has no merged_at${
              resolveMerges ? " and `gh` did not answer" : ""
            }.`,
            resolveMerges
              ? "   - Run again once `gh` can reach GitHub."
              : "   - Run again with --resolve-issue, so `gh` can supply it.",
          ];
    process.stderr.write(
      [
        `❌ pr-metrics: branch \`${branch}\` also carried pull request #${window.pull}, and this run`,
        "   cannot tell which of the branch's sessions are whose. Nothing was written.",
        ...why,
        "",
      ].join("\n"),
    );
    process.exit(1);
  }

  const sessionsDir: SessionsRoots = flag("sessions-dir") ?? defaultSessionsRoots();
  const base = flag("base") ?? parentBranch(branch) ?? "origin/main";
  const records = recordsInWindow(
    readRecordsForBranch(sessionsDir, branch, { repoPaths: repoProjectPaths() }),
    window,
  );

  const numstat = git(["diff", "--numstat", `${base}...HEAD`]);
  const commits = git(["rev-list", "--count", `${base}..HEAD`]);
  const diff = parseNumstat(numstat, Number.parseInt(commits, 10) || 0);

  // The reports are gitignored scratch, gone once the worktree is, so the
  // first run that reads them is the record: a later refresh finds none, or a
  // report rewritten since, and must not replace that record. Only a run that
  // names its reports explicitly does.
  //
  // The `--if-absent` fallback never reads them. It fires when a session ends,
  // which can fall between the reviews and the commits that fix what they
  // found; counted then, every finding reads as not acted on, and the rule
  // above would keep that figure. `retro` runs after the fixes.
  const namedReports = flag("review-reports");
  const root = repoRoot();
  const reportFiles = (namedReports?.split(",").filter(Boolean) ?? DEFAULT_REVIEW_REPORTS).map(
    (file) => (file.startsWith("/") ? file : `${root}/${file}`),
  );
  const review =
    namedReports === null && existing?.review != null
      ? existing.review
      : Bun.argv.includes("--if-absent")
        ? null
        : summariseReviews(root, base, reportFiles);

  const card = buildCard(records, diff, {
    branch,
    prNumber,
    issueNumber: resolved === null ? explicitIssue : resolved.issueNumber,
    issueType: flag("issue-type"),
    issueLabels: resolved === null ? issueLabels : resolved.labels,
    declaredComplexity: override
      ? Number.parseInt(override, 10)
      : (resolved?.declared ?? fromLabels.declared),
    complexityMethod:
      flag("complexity-method") ?? (override ? "manual" : (resolved?.method ?? fromLabels.method)),
    complexityIssues: override ? 0 : (resolved?.issues ?? (fromLabels.declared === null ? 0 : 1)),
    baseSha: git(["rev-parse", base]) || null,
    headSha: git(["rev-parse", "HEAD"]) || null,
    mergedAt: selfMergedAt,
    phase: flag("phase") === "at-merge" ? "at-merge" : "at-open",
    generatedAt: new Date().toISOString(),
    review,
  });

  // `--format markdown` prints the `<details>` block on stdout and writes
  // nothing, so `retro` can append it to a pull-request body without a
  // temporary file and without the warnings below landing in the markdown.
  if (flag("format") === "markdown") {
    console.log(renderDetails(card, outPath.slice(outDir.length + 1)));
    process.exit(0);
  }

  // A re-run on the same branch is common — `retro` writes the card, then the
  // review adds a commit and it is written again. Where nothing but the
  // timestamp moved, leave the file as it stands.
  if (existing === null || !sameApartFromGeneratedAt(existing, card)) {
    require("node:fs").mkdirSync(outDir, { recursive: true });
    require("node:fs").writeFileSync(outPath, `${JSON.stringify(card, null, 2)}\n`);
  }

  if (records.length === 0) {
    console.warn(
      `⚠️  pr-metrics: no session records matched branch \`${branch}\` under ${[sessionsDir].flat().join(" or ")}.`,
    );
    console.warn("   The card still carries the diff; spend and interaction are zero.");
  }

  // Checked unconditionally, not only when `records.length === 0`:
  // `resolveSessionBranch` now gives a `main/` session that cut exactly one
  // branch some records of its own (its main-thread spend), so this file no
  // longer implies the marker warning would never fire. A `stress-plan` or
  // `prep-pr` dispatch that still forgets `TASK-BRANCH:` must keep warning
  // regardless of whether the rest of the session's spend made it onto the
  // card.
  const unattributed = unattributedSubagentFiles(sessionsDir, { repoPaths: repoProjectPaths() });
  if (unattributed > 0) {
    console.warn(
      `⚠️  pr-metrics: ${unattributed} subagent transcript(s) carry no TASK-BRANCH marker and sit`,
    );
    console.warn("   under a `main`/`HEAD` session, so their spend lands on no card. See");
    console.warn("   wiki/conventions/session-metrics.md §Attributing subagent spend.");
  }

  const unknownOrigins = unknownQueuedOrigins(records);
  if (unknownOrigins.length > 0) {
    process.stderr.write(
      `⚠️  pr-metrics: queued record(s) from an unknown sender (${unknownOrigins.join(", ")}) count as no turn.\n` +
        "   If a person typed them, add the kind to queuedByPerson in tools/pr-metrics/index.ts.\n",
    );
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
