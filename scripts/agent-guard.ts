#!/usr/bin/env bun
/**
 * PreToolUse guard: refuses a tool call that breaks one of the AGENTS.md
 * standing rules, and says which fix to make instead.
 *
 * `.claude/settings.json` runs main's copy of this file (`git cat-file blob
 * refs/remotes/origin/main:scripts/agent-guard.ts` into a fresh temp
 * directory), never the checkout's, so an edit on a branch changes nothing
 * until it merges. That is also why this file imports nothing but Node
 * built-ins: it runs alone, from a directory holding only itself.
 *
 * It catches slips; it is not enforcement. Every way it can fail lets the call
 * through: unreadable input, a thrown check, a file it cannot read, a git
 * command that fails, a directory it cannot resolve. A broken guard must never
 * stop every tool call in a session.
 *
 * Protocol: the hook input arrives as JSON on stdin. A refusal is one JSON
 * object on stdout (`permissionDecision: "deny"`) and exit 0; an allowed call
 * prints nothing. Tested by scripts/tests/agent-guard.test.ts (the rules) and
 * scripts/tests/agent-guard.cli.test.ts (the command settings.json holds).
 */

import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";

/** The arguments of a tool call the rules read, parsed by `toolArgs`. */
export interface ToolArgs {
  readonly command?: string;
  readonly file_path?: string;
  readonly subagent_type?: string;
  readonly repo?: string;
  /** Every string the call carries, at any depth, for the tracker scan. */
  readonly texts: readonly string[];
}

export interface HookInput {
  readonly tool_name: string;
  readonly tool_input: ToolArgs;
  readonly cwd: string;
}

/** Everything the rules read from outside the input, so tests can stand it in. */
export interface GuardIo {
  /** The branch checked out in `dir`, or null when git cannot tell. */
  readonly branch: (dir: string) => string | null;
  /** A file's text, or null when it cannot be read. */
  readonly read: (path: string) => string | null;
  readonly exists: (path: string) => boolean;
  /** `git rev-parse --git-common-dir` for `dir`, absolute, or null. */
  readonly commonDir: (dir: string) => string | null;
}

// write-pr's own definition of a tracker finding ID (write-pr/SKILL.md).
const TRACKER_ID = /(^|[^A-Za-z0-9])[SPC]-[A-Z][0-9]+/;
const TRACKER_REPO = "englishstreetventures/osn-tracker";
const TEST_FILE = /[._](?:test|spec)\./i;
/** The GitHub MCP writes the guard reads; `.claude/settings.json` matches the same pattern. */
export const GITHUB_WRITE =
  /^mcp__github__(create_|update_|add_|issue_write|push_files|pull_request_review_write|sub_issue_write|delete_file|merge_pull_request)/;

// ---------------------------------------------------------------------------
// Shell parsing

/** One simple command: its words, the text it reads on stdin, what it writes. */
interface Command {
  readonly kind: "command";
  words: string[];
  /** A word is unresolved when it holds an expansion the parser cannot evaluate. */
  unresolved: boolean[];
  stdin: string | null;
  writes: string[];
  /** Command substitutions inside this command's words, run before it. */
  subs: Group[];
  heredoc: boolean;
}

/** Commands run in a subshell: a `( … )` group, `$( … )` or backticks. */
interface Group {
  readonly kind: "group";
  readonly opener: "(" | "$(" | "`" | "top";
  readonly items: (Command | Group)[];
}

const newCommand = (): Command => ({
  kind: "command",
  words: [],
  unresolved: [],
  stdin: null,
  writes: [],
  subs: [],
  heredoc: false,
});

/**
 * Parses a command line into commands and subshell groups. Quotes, escapes,
 * heredocs and nested substitutions are handled; anything else is read as
 * words. It never throws on odd input: an unterminated construct just ends.
 */
export function parse(source: string): Group {
  let i = 0;
  const pendingHeredocs: { delimiter: string; strip: boolean; command: Command }[] = [];

  const readHeredocBodies = () => {
    for (const doc of pendingHeredocs.splice(0)) {
      const lines: string[] = [];
      while (i < source.length) {
        const end = source.indexOf("\n", i);
        const line = end === -1 ? source.slice(i) : source.slice(i, end);
        i = end === -1 ? source.length : end + 1;
        const compared = doc.strip ? line.replace(/^\t+/, "") : line;
        if (compared === doc.delimiter) break;
        lines.push(line);
      }
      doc.command.stdin = `${doc.command.stdin ?? ""}${lines.join("\n")}`;
    }
  };

  /** Reads one word after an operator (a heredoc delimiter or a redirect target). */
  const readBareWord = (): string => {
    while (source[i] === " " || source[i] === "\t") i += 1;
    let word = "";
    while (i < source.length && !/[\s;&|()<>]/.test(source[i] ?? "")) {
      const c = source[i] ?? "";
      if (c === "'" || c === '"') {
        const close = source.indexOf(c, i + 1);
        const end = close === -1 ? source.length : close;
        word += source.slice(i + 1, end);
        i = end + 1;
      } else if (c === "\\") {
        word += source[i + 1] ?? "";
        i += 2;
      } else {
        word += c;
        i += 1;
      }
    }
    return word;
  };

  const parseGroup = (opener: Group["opener"]): Group => {
    const items: (Command | Group)[] = [];
    let command = newCommand();
    let word: string | null = null;
    let wordUnresolved = false;

    const endWord = () => {
      if (word !== null) {
        command.words.push(word);
        command.unresolved.push(wordUnresolved);
      }
      word = null;
      wordUnresolved = false;
    };
    const endCommand = () => {
      endWord();
      if (command.words.length > 0 || command.subs.length > 0) items.push(command);
      command = newCommand();
    };
    const append = (text: string) => {
      word = (word ?? "") + text;
    };

    /** Reads a `$( … )` or backtick substitution into the current command. */
    const substitution = (kind: "$(" | "`") => {
      const group = parseGroup(kind);
      command.subs.push(group);
      append("\u0000");
      wordUnresolved = true;
    };

    while (i < source.length) {
      const c = source[i] ?? "";
      const next = source[i + 1] ?? "";

      if (opener === "`" && c === "`") {
        i += 1;
        break;
      }
      if ((opener === "$(" || opener === "(") && c === ")") {
        i += 1;
        break;
      }

      if (c === "\\") {
        if (next === "\n") {
          i += 2;
          continue;
        }
        append(next);
        i += 2;
        continue;
      }
      if (c === "'") {
        const close = source.indexOf("'", i + 1);
        const end = close === -1 ? source.length : close;
        append(source.slice(i + 1, end));
        i = end + 1;
        continue;
      }
      if (c === '"') {
        i += 1;
        let text = "";
        while (i < source.length && source[i] !== '"') {
          const d = source[i] ?? "";
          if (d === "\\" && /["\\$`\n]/.test(source[i + 1] ?? "")) {
            text += source[i + 1] ?? "";
            i += 2;
          } else if (d === "$" && source[i + 1] === "(" && source[i + 2] !== "(") {
            append(text);
            text = "";
            i += 2;
            substitution("$(");
          } else if (d === "`") {
            append(text);
            text = "";
            i += 1;
            substitution("`");
          } else {
            if (d === "$") wordUnresolved = true;
            text += d;
            i += 1;
          }
        }
        append(text);
        i += 1;
        continue;
      }
      if (c === "$" && next === "(" && source[i + 2] === "(") {
        // Arithmetic: read to the matching `))` as plain text.
        const close = source.indexOf("))", i + 3);
        const end = close === -1 ? source.length : close + 2;
        append(source.slice(i, end));
        i = end;
        continue;
      }
      if (c === "$" && next === "(") {
        i += 2;
        substitution("$(");
        continue;
      }
      if (c === "`") {
        i += 1;
        substitution("`");
        continue;
      }
      if (c === "$") {
        wordUnresolved = true;
        append(c);
        i += 1;
        continue;
      }
      if (c === "~" && word === null) {
        wordUnresolved = true;
        append(c);
        i += 1;
        continue;
      }
      if (c === "#" && word === null) {
        const end = source.indexOf("\n", i);
        i = end === -1 ? source.length : end;
        continue;
      }
      if (c === "\n") {
        endCommand();
        i += 1;
        readHeredocBodies();
        continue;
      }
      if (c === " " || c === "\t") {
        endWord();
        i += 1;
        continue;
      }
      if (c === ";" || c === "&" || c === "|") {
        endCommand();
        i += c === next ? 2 : 1;
        continue;
      }
      if (c === "(") {
        endCommand();
        i += 1;
        items.push(parseGroup("("));
        continue;
      }
      if (c === "<" && next === "<" && source[i + 2] === "<") {
        // A here-string: the word after it is the command's stdin.
        endWord();
        i += 3;
        command.stdin = `${command.stdin ?? ""}${readBareWord()}`;
        continue;
      }
      if (c === "<" && next === "<") {
        endWord();
        i += 2;
        const strip = source[i] === "-";
        if (strip) i += 1;
        pendingHeredocs.push({ delimiter: readBareWord(), strip, command });
        command.heredoc = true;
        continue;
      }
      if (c === ">" || (/[0-9]/.test(c) && next === ">" && word === null)) {
        endWord();
        if (c !== ">") i += 1;
        i += 1;
        if (source[i] === ">") i += 1;
        if (source[i] === "&") {
          // `>&2`, `2>&1`: a descriptor, not a file.
          i += 1;
          readBareWord();
          continue;
        }
        command.writes.push(readBareWord());
        continue;
      }
      if (c === "<") {
        endWord();
        i += 1;
        readBareWord();
        continue;
      }
      append(c);
      i += 1;
    }
    endCommand();
    return { kind: "group", opener, items };
  };

  return parseGroup("top");
}

// ---------------------------------------------------------------------------
// Evaluation

interface State {
  /** The directory the next command runs in, or null when it cannot be known. */
  dir: string | null;
  /** The branch checked out there: a name, "?" for not yet read, null for unknown. */
  branch: string | null | "?";
  /** Files earlier commands in this line write, absolute. */
  readonly written: Set<string>;
}

interface Context {
  readonly io: GuardIo;
  readonly projectDir: string;
}

const isAssignment = (word: string) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(word);

interface Argv {
  readonly words: string[];
  readonly unresolved: boolean[];
}

/** The command's words without leading `VAR=value` assignments. */
function argv(command: Command): Argv {
  let start = 0;
  while (start < command.words.length && isAssignment(command.words[start] ?? "")) start += 1;
  return { words: command.words.slice(start), unresolved: command.unresolved.slice(start) };
}

function branchOf(state: State, ctx: Context): string | null {
  if (state.branch === "?") state.branch = state.dir === null ? null : ctx.io.branch(state.dir);
  return state.branch;
}

/** Walks up from `dir` looking for `bun.lock`. */
function inBunWorkspace(dir: string, io: GuardIo): boolean {
  let current = dir;
  for (;;) {
    if (io.exists(join(current, "bun.lock"))) return true;
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

/** A flag's value: `--flag value`, `--flag=value`, or `-xvalue` for a short flag. */
function flagValues(words: readonly string[], names: readonly string[]): string[] {
  const values: string[] = [];
  for (let k = 0; k < words.length; k += 1) {
    const word = words[k] ?? "";
    for (const name of names) {
      if (word === name && k + 1 < words.length) values.push(words[k + 1] ?? "");
      else if (name.startsWith("--") && word.startsWith(`${name}=`)) {
        values.push(word.slice(name.length + 1));
      }
    }
  }
  return values;
}

/** All text this command reads from its substitutions: their words and stdin. */
function substitutionText(command: Command): string {
  const parts: string[] = [];
  const walk = (item: Command | Group) => {
    if (item.kind === "group") {
      for (const inner of item.items) walk(inner);
      return;
    }
    parts.push(item.words.join(" "));
    if (item.stdin !== null) parts.push(item.stdin);
    for (const sub of item.subs) walk(sub);
  };
  for (const sub of command.subs) walk(sub);
  return parts.join("\n");
}

/** A file argument's text: stdin for `-`, null when it cannot be known. */
function fileText(path: string, command: Command, state: State, ctx: Context): string | null {
  if (path === "-") return command.stdin;
  if (state.dir === null && !isAbsolute(path)) return null;
  const full = isAbsolute(path) ? path : resolve(state.dir ?? "/", path);
  if (state.written.has(full)) return null;
  return ctx.io.read(full);
}

const trackerReason = (where: string) =>
  `${where} names a tracker finding ID. Public text states the constraint instead and names a tracker issue only as a bare \`Closes ${TRACKER_REPO}#N\` (AGENTS.md §Issues).`;

const hasTrackerId = (texts: readonly (string | null)[]) =>
  texts.some((text) => text !== null && TRACKER_ID.test(text));

function gitRule(words: string[], command: Command, state: State, ctx: Context): string | null {
  let k = 1;
  let dir = state.dir;
  while (k < words.length && (words[k] ?? "").startsWith("-")) {
    const option = words[k] ?? "";
    if (option === "-C") {
      const target = words[k + 1] ?? "";
      dir = dir === null && !isAbsolute(target) ? null : resolve(dir ?? "/", target);
      k += 2;
    } else if (option === "-c" || option === "--git-dir" || option === "--work-tree") {
      k += 2;
    } else {
      k += 1;
    }
  }
  const verb = words[k] ?? "";
  const rest = words.slice(k + 1);
  const scoped: State = dir === state.dir ? state : { dir, branch: "?", written: state.written };

  if (verb === "commit" || verb === "push") {
    if (branchOf(scoped, ctx) === "main") {
      return `\`git ${verb}\` on \`main\`. Never commit or push to main: cut a branch with \`/new-feat\` (AGENTS.md §How work runs).`;
    }
  }

  if (verb === "push") {
    const positional = rest.filter((word) => !word.startsWith("-"));
    for (const refspec of positional.slice(1)) {
      const destination = (
        refspec.includes(":") ? refspec.slice(refspec.indexOf(":") + 1) : refspec
      ).replace(/^\+/, "");
      if (destination === "main" || destination === "refs/heads/main") {
        return "`git push` to `main`. Never push to main: push your branch and open a pull request (AGENTS.md §How work runs).";
      }
    }
  }

  if (verb === "commit") {
    const texts: (string | null)[] = [substitutionText(command)];
    for (let m = 0; m < rest.length; m += 1) {
      const word = rest[m] ?? "";
      if (word === "-m" || word === "--message") texts.push(rest[m + 1] ?? "");
      else if (word.startsWith("--message=")) texts.push(word.slice("--message=".length));
      else if (word === "-F" || word === "--file")
        texts.push(fileText(rest[m + 1] ?? "", command, scoped, ctx));
      else if (word.startsWith("--file="))
        texts.push(fileText(word.slice("--file=".length), command, scoped, ctx));
      else if (/^-[a-zA-Z]+$/.test(word) && word.includes("m")) {
        const after = word.slice(word.indexOf("m") + 1);
        texts.push(after === "" ? (rest[m + 1] ?? "") : after);
      }
    }
    if (hasTrackerId(texts)) return trackerReason("This commit message");
  }

  if (verb === "switch" || verb === "checkout") {
    if (!rest.includes("--")) {
      const created = flagValues(rest, ["-c", "-C", "-b", "-B", "--create"]);
      const target = created[0] ?? rest.find((word) => !word.startsWith("-"));
      if (target !== undefined) state.branch = target === "main" ? "main" : null;
    }
  } else if (verb === "rebase") {
    const positional = rest.filter((word) => !word.startsWith("-"));
    if (positional.length >= 2) state.branch = positional[1] === "main" ? "main" : null;
  }
  return null;
}

function ghRule(words: string[], command: Command, state: State, ctx: Context): string | null {
  const repo = flagValues(words, ["-R", "--repo"])[0];
  if (repo === TRACKER_REPO) return null;
  const area = words[1] ?? "";
  const verb = words[2] ?? "";
  const texts: (string | null)[] = [substitutionText(command)];

  if (area === "api") {
    const path = words.slice(2).find((word) => !word.startsWith("-") && word.includes("/"));
    if (path !== undefined && path.replace(/^\//, "").startsWith(`repos/${TRACKER_REPO}/`))
      return null;
    for (const field of flagValues(words, ["-f", "--raw-field"]))
      texts.push(field.slice(field.indexOf("=") + 1));
    for (const pair of flagValues(words, ["-F", "--field"])) {
      const value = pair.slice(pair.indexOf("=") + 1);
      texts.push(value.startsWith("@") ? fileText(value.slice(1), command, state, ctx) : value);
    }
    for (const input of flagValues(words, ["--input"]))
      texts.push(fileText(input, command, state, ctx));
  } else if (
    (area === "pr" || area === "issue") &&
    ["create", "edit", "comment", "review", "merge", "close", "reopen"].includes(verb)
  ) {
    texts.push(...flagValues(words, ["-t", "--title", "-b", "--body", "--subject"]));
    if (verb === "close" || verb === "reopen")
      texts.push(...flagValues(words, ["-c", "--comment"]));
    for (const file of flagValues(words, ["-F", "--body-file"]))
      texts.push(fileText(file, command, state, ctx));
  } else {
    return null;
  }
  return hasTrackerId(texts) ? trackerReason(`This \`gh ${area}\` text`) : null;
}

function installRule(words: string[], state: State, ctx: Context): string | null {
  const verb = words[1] ?? "";
  if (words[0] !== "bun" || !["install", "i", "update", "add"].includes(verb)) return null;
  if (state.dir === null || !inBunWorkspace(state.dir, ctx.io)) return null;
  const flags = words.slice(2);
  if (verb === "install" || verb === "i") {
    if (flags.includes("--frozen-lockfile") || flags.includes("-g") || flags.includes("--global"))
      return null;
    return "a bare `bun install` drops other platforms' lockfile entries. Use `bun install --frozen-lockfile`; to change a dependency, use `bun add <pkg> --cwd <dir>` (AGENTS.md §Standing rules, Installs).";
  }
  if (verb === "update") {
    return "`bun update` re-resolves the whole lockfile. Bump each dependency with `bun add '<pkg>@<version>' --cwd <dir>` (AGENTS.md §Standing rules, Installs).";
  }
  if (verb === "add" && flags.some((flag) => flag === "--filter" || flag.startsWith("--filter="))) {
    return "add a dependency with `bun add <pkg> --cwd <dir>`, not `--filter` (AGENTS.md §Standing rules, Installs).";
  }
  return null;
}

/** Whether any command in the group, at any depth, carries a heredoc. */
function hasHeredoc(group: Group): boolean {
  return group.items.some((item) =>
    item.kind === "group" ? hasHeredoc(item) : item.heredoc || item.subs.some(hasHeredoc),
  );
}

function evaluate(group: Group, state: State, ctx: Context): string | null {
  for (const item of group.items) {
    if (item.kind === "group") {
      const reason = evaluate(item, { ...state, written: new Set(state.written) }, ctx);
      if (reason !== null) return reason;
      continue;
    }
    for (const sub of item.subs) {
      if (hasHeredoc(sub)) {
        return "a heredoc inside `$(…)`. Write the text to a file and pass the file (`git commit -F <file>`, `--body-file <file>`) (AGENTS.md §Commands).";
      }
      const reason = evaluate(sub, { ...state, written: new Set(state.written) }, ctx);
      if (reason !== null) return reason;
    }

    const { words, unresolved } = argv(item);
    const reason =
      installRule(words, state, ctx) ??
      (words[0] === "git" ? gitRule(words, item, state, ctx) : null) ??
      (words[0] === "gh" ? ghRule(words, item, state, ctx) : null);
    if (reason !== null) return reason;

    if (words[0] === "cd") {
      const target = words[1];
      if (target === undefined || target === "-" || unresolved[1] === true || state.dir === null) {
        state.dir =
          target !== undefined && isAbsolute(target) && unresolved[1] !== true ? target : null;
      } else {
        state.dir = resolve(state.dir, target);
      }
      state.branch = "?";
    }
    for (const file of item.writes) {
      if (isAbsolute(file)) state.written.add(file);
      else if (state.dir !== null) state.written.add(resolve(state.dir, file));
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Tools

function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value !== null && typeof value === "object") return Object.values(value).flatMap(strings);
  return [];
}

/** Parses a hook's `tool_input` into the arguments the rules read. */
export function toolArgs(raw: unknown): ToolArgs {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return { texts: [] };
  const entries = new Map(Object.entries(raw));
  const text = (key: string) => {
    const value = entries.get(key);
    return typeof value === "string" ? value : undefined;
  };
  return {
    command: text("command"),
    file_path: text("file_path"),
    subagent_type: text("subagent_type"),
    repo: text("repo"),
    texts: strings(raw),
  };
}

function testLocationRule(path: string, ctx: Context): string | null {
  if (!isAbsolute(path) || !TEST_FILE.test(basename(path))) return null;
  const parts = path.split(sep);
  const srcAt = parts.lastIndexOf("src");
  if (srcAt <= 0) return null;
  let found = false;
  for (let k = srcAt; k > 0; k -= 1) {
    if (
      parts[k] === "src" &&
      ctx.io.exists(join(parts.slice(0, k).join(sep) || sep, "package.json"))
    ) {
      found = true;
      break;
    }
  }
  if (!found) return null;

  let existing = dirname(path);
  while (!ctx.io.exists(existing) && dirname(existing) !== existing) existing = dirname(existing);
  const ours = ctx.io.commonDir(ctx.projectDir);
  if (ours === null || ctx.io.commonDir(existing) !== ours) return null;
  return "a test file under `src/`. Tests live in `tests/` at the package root, mirroring `src/` (AGENTS.md §Standing rules, Tests).";
}

/** The reason to refuse this tool call, or null to let it through. */
export function decide(input: HookInput, io: GuardIo, projectDir: string): string | null {
  const ctx: Context = { io, projectDir };
  const tool = input.tool_input;

  if (input.tool_name === "Bash") {
    if (tool.command === undefined) return null;
    return evaluate(parse(tool.command), { dir: input.cwd, branch: "?", written: new Set() }, ctx);
  }
  if (input.tool_name === "Write" || input.tool_name === "Edit") {
    return tool.file_path === undefined ? null : testLocationRule(tool.file_path, ctx);
  }
  if (input.tool_name === "Agent") {
    return tool.subagent_type === undefined || tool.subagent_type === ""
      ? "an Agent call with no `subagent_type` runs `general-purpose` at this session's model and effort. Name the definition the `pick-agent` skill gives (AGENTS.md §How work runs)."
      : null;
  }
  if (GITHUB_WRITE.test(input.tool_name)) {
    if (tool.repo === "osn-tracker") return null;
    return hasTrackerId(tool.texts) ? trackerReason("This GitHub write") : null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// The hook

// Loaded on first use: most calls never read a file or run git.
const fs = () => process.getBuiltinModule("node:fs");

function git(dir: string, args: readonly string[]): string | null {
  const result = process
    .getBuiltinModule("node:child_process")
    .spawnSync("git", ["-C", dir, ...args], { encoding: "utf8", timeout: 5000 });
  return result.status === 0 ? result.stdout.trim() : null;
}

export const realIo: GuardIo = {
  branch: (dir) => git(dir, ["branch", "--show-current"]),
  read: (path) => {
    try {
      return fs().readFileSync(path, "utf8");
    } catch {
      return null;
    }
  },
  exists: (path) => fs().existsSync(path),
  commonDir: (dir) => {
    const common = git(dir, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    return common === null ? null : resolve(common);
  },
};

async function main(): Promise<void> {
  try {
    const raw: unknown = JSON.parse(await Bun.stdin.text());
    if (raw === null || typeof raw !== "object") return;
    const entries = new Map(Object.entries(raw));
    const toolName = entries.get("tool_name");
    const cwd = entries.get("cwd");
    if (typeof toolName !== "string" || typeof cwd !== "string") return;
    const hook: HookInput = {
      tool_name: toolName,
      tool_input: toolArgs(entries.get("tool_input")),
      cwd,
    };
    const reason = decide(hook, realIo, Bun.env.CLAUDE_PROJECT_DIR ?? hook.cwd);
    if (reason === null) return;
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: `agent-guard: ${reason}`,
        },
      }),
    );
  } catch {
    // Fail open: a guard that throws lets the call through.
  }
}

if (import.meta.main) await main();
