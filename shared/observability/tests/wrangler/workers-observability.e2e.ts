// Workers traces and Workers Logs from the shared observability layer, on real
// workerd: `wrangler dev` under Node on the fixture Worker in
// fixtures/workers-observability, read back through wrangler's local explorer
// (`POST /cdn-cgi/local/explorer/api/local/observability/query`, read-only SQL
// over the spans and logs the dev server captured). It is the only test of
// the Workers `tracing` API and the Workers Logs console path; every other test
// of them runs under Bun with a stand-in.
//
// The fixture runs at osn-api's compatibility date and flags
// (osn/api/wrangler.toml, top level), which `wrangler dev` runs locally and a
// production tier would run with traces on. The dev stacks add
// `legacy_module_registry`, which chooses how Alchemy's bundle is linked, not
// async context or tracing.
//
// Named `.e2e.ts` so neither vitest (`tests/**/*.test.ts`) nor a bare
// `bun test` picks it up; `bun run test:wrangler` runs it, and CI runs that in
// its Build & Test job, which has Node and the install. It fails, never skips,
// when either is missing. It ends by writing what the two requests recorded to
// test-artifacts/observability-workers.json, ids, times and ports removed, so a
// rerun writes the same file.

import { afterAll, describe, expect, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const PACKAGE = join(import.meta.dir, "..", "..");
const ROOT = join(PACKAGE, "..", "..");
const FIXTURE = join(import.meta.dir, "fixtures", "workers-observability", "worker.ts");
const ARTIFACT = join(ROOT, "test-artifacts", "observability-workers.json");
const WRANGLER = join(
  dirname(Bun.resolveSync("wrangler/package.json", PACKAGE)),
  "bin",
  "wrangler.js",
);
const PII = "ada@example.com";
const FORGED_TRACE_ID = "0af7651916cd43dd8448eb211c80319c";
const READY_TIMEOUT_MS = 90_000;
const ROWS_TIMEOUT_MS = 15_000;

const osnWrangler = Bun.TOML.parse(
  await Bun.file(join(ROOT, "osn", "api", "wrangler.toml")).text(),
) as { compatibility_date: string; compatibility_flags: string[] };

interface SpanRow {
  readonly trace_id: string;
  readonly span_id: string;
  readonly parent_id: string | null;
  readonly name: string;
  readonly outcome: string;
  readonly error: string | null;
  readonly attributes: Record<string, unknown>;
}

interface LogRow {
  readonly trace_id: string;
  readonly level: string;
  readonly message: unknown;
}

const stops: (() => void)[] = [];
afterAll(() => {
  for (const stop of stops.toReversed()) stop();
});

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => resolvePort(port));
    });
  });
}

/** The parent environment minus the variables that put wrangler in agent mode. */
function childEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (key === "CLAUDECODE" || key === "AI_AGENT" || key.startsWith("CLAUDE_CODE")) continue;
    env[key] = value;
  }
  return { ...env, CI: "true", WRANGLER_SEND_METRICS: "false" };
}

/** Starts `wrangler dev` on the fixture and resolves with its origin once it is ready. */
async function startDevServer(): Promise<string> {
  const scratch = mkdtempSync(join(tmpdir(), "observability-workers-e2e-"));
  stops.push(() => rmSync(scratch, { recursive: true, force: true }));
  const config = join(scratch, "wrangler.toml");
  const flags = osnWrangler.compatibility_flags.map((flag) => JSON.stringify(flag)).join(", ");
  writeFileSync(
    config,
    [
      `name = "observability-e2e"`,
      `main = ${JSON.stringify(FIXTURE)}`,
      `compatibility_date = ${JSON.stringify(osnWrangler.compatibility_date)}`,
      `compatibility_flags = [${flags}]`,
      ``,
      `[observability]`,
      `enabled = true`,
      `head_sampling_rate = 1`,
      ``,
      `[observability.traces]`,
      `enabled = true`,
      `head_sampling_rate = 1`,
      ``,
    ].join("\n"),
  );
  mkdirSync(join(scratch, "state"));
  const port = await freePort();
  const inspectorPort = await freePort();

  const proc: ChildProcess = spawn(
    "node",
    [
      WRANGLER,
      "dev",
      "--config",
      config,
      "--ip",
      "127.0.0.1",
      "--port",
      String(port),
      "--inspector-port",
      String(inspectorPort),
      "--persist-to",
      join(scratch, "state"),
    ],
    { cwd: scratch, env: childEnv(), detached: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "";
  let exited = false;
  proc.stdout?.on("data", (chunk: Buffer) => (output += chunk.toString()));
  proc.stderr?.on("data", (chunk: Buffer) => (output += chunk.toString()));
  proc.on("exit", () => (exited = true));
  proc.on("error", () => (exited = true));
  stops.push(() => {
    if (proc.pid === undefined) return;
    try {
      process.kill(-proc.pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  });

  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (!output.includes("Ready on")) {
    if (exited) throw new Error(`wrangler dev exited before it was ready:\n${output}`);
    if (Date.now() > deadline) throw new Error(`wrangler dev not ready:\n${output}`);
    await Bun.sleep(200);
  }
  return `http://127.0.0.1:${port}`;
}

async function query<Row>(origin: string, sql: string): Promise<Row[]> {
  const res = await fetch(`${origin}/cdn-cgi/local/explorer/api/local/observability/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sql }),
  });
  if (res.status !== 200) throw new Error(`explorer answered ${res.status}: ${await res.text()}`);
  const body = (await res.json()) as {
    result: { columns: string[]; rows: unknown[][] };
  };
  return body.result.rows.map(
    (row) => Object.fromEntries(body.result.columns.map((c, i) => [c, row[i]])) as Row,
  );
}

const parse = (value: unknown): unknown => {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
};

/** Spans the fixture's Effect program records per request: outer, child, failing, background. */
const EXPECTED_EFFECT_SPANS = { a: 4, b: 4 } as const;

describe("Workers traces and logs from the shared observability layer", () => {
  test("records Effect spans and redacted structured logs in each request's own trace", async () => {
    const origin = await startDevServer();

    const [a, b] = await Promise.all([
      fetch(`${origin}/?role=a`, {
        headers: { traceparent: `00-${FORGED_TRACE_ID}-b7ad6b7169203331-01` },
      }),
      fetch(`${origin}/?role=b`),
    ]);
    type Body = { overlapped: boolean; asyncResource: boolean };
    const read = async (res: Response): Promise<Body> => {
      const text = await res.text();
      if (res.status !== 200)
        throw new Error(`fixture answered ${res.status}: ${text.slice(0, 2000)}`);
      return JSON.parse(text) as Body;
    };
    const bodies = { a: await read(a), b: await read(b) };

    // Rows are written after the responses; poll for every one this test expects.
    let spans: SpanRow[] = [];
    let logs: LogRow[] = [];
    let handlers: Record<"a" | "b", SpanRow | undefined> = { a: undefined, b: undefined };
    const deadline = Date.now() + ROWS_TIMEOUT_MS;
    for (;;) {
      const all = (
        await query<Omit<SpanRow, "attributes"> & { attributes: unknown }>(
          origin,
          "SELECT trace_id, span_id, parent_id, name, outcome, error, json(attributes) AS attributes FROM spans",
        )
      ).map((row): SpanRow => ({
        trace_id: row.trace_id,
        span_id: row.span_id,
        parent_id: row.parent_id,
        name: row.name,
        outcome: row.outcome,
        error: row.error,
        attributes: (parse(row.attributes) ?? {}) as Record<string, unknown>,
      }));
      handlers = {
        a: all.find(
          (s) => s.parent_id === null && String(s.attributes["url.full"]).endsWith("role=a"),
        ),
        b: all.find(
          (s) => s.parent_id === null && String(s.attributes["url.full"]).endsWith("role=b"),
        ),
      };
      const traces = new Set([handlers.a?.trace_id, handlers.b?.trace_id]);
      spans = all.filter((s) => traces.has(s.trace_id));
      logs = (await query<LogRow>(origin, "SELECT trace_id, level, message FROM logs")).filter(
        (l) => traces.has(l.trace_id),
      );
      const effectSpans = (role: "a" | "b") =>
        spans.filter((s) => s.name.startsWith(`e2e.${role}.`)).length;
      const done =
        handlers.a !== undefined &&
        handlers.b !== undefined &&
        effectSpans("a") === EXPECTED_EFFECT_SPANS.a &&
        effectSpans("b") === EXPECTED_EFFECT_SPANS.b &&
        logs.filter((l) => l.level === "error").length >= 2;
      if (done) break;
      if (Date.now() > deadline) {
        throw new Error(`rows never arrived: ${JSON.stringify({ spans, logs }, null, 2)}`);
      }
      await Bun.sleep(250);
    }

    // Before anything is normalised away: no column of any row the dev server
    // holds names the PII. Every column, the JSON attribute column as text.
    const raw = {
      spans: await query<Record<string, unknown>>(
        origin,
        "SELECT *, json(attributes) AS attributes_json FROM spans",
      ),
      logs: await query<Record<string, unknown>>(origin, "SELECT * FROM logs"),
    };
    expect(raw.spans.length).toBeGreaterThanOrEqual(spans.length);
    expect(JSON.stringify(raw)).not.toContain(PII);

    const handlerA = handlers.a!;
    const handlerB = handlers.b!;
    const roleOf = (traceId: string) => (traceId === handlerA.trace_id ? "a" : "b");
    const report = (["a", "b"] as const).map((role) => {
      const handler = role === "a" ? handlerA : handlerB;
      const own = spans.filter((s) => s.name.startsWith(`e2e.${role}.`));
      return {
        role,
        spanCount: own.length,
        spans: own
          .map((s) => ({
            name: s.name,
            trace: roleOf(s.trace_id),
            parent: s.parent_id === handler.span_id ? "handler" : "other",
            error: s.error,
            attributes: Object.fromEntries(Object.entries(s.attributes).toSorted()),
          }))
          .toSorted((x, y) => x.name.localeCompare(y.name)),
        logs: logs
          .filter((l) => l.trace_id === handler.trace_id)
          .map((l) => ({ level: l.level, message: parse(l.message) }))
          .filter((l) => Array.isArray(l.message))
          .map((l) => {
            const entry = (l.message as Record<string, unknown>[])[0]!;
            return {
              level: l.level,
              message: entry["message"],
              annotations: entry["annotations"],
            };
          })
          .toSorted((x, y) =>
            `${x.level}${String(x.message)}`.localeCompare(`${y.level}${String(y.message)}`),
          ),
        overlapped: bodies[role].overlapped,
        asyncResource: bodies[role].asyncResource,
      };
    });
    mkdirSync(dirname(ARTIFACT), { recursive: true });
    writeFileSync(ARTIFACT, `${JSON.stringify(report, null, 2)}\n`);

    // Effect restores a fiber's async context through `AsyncResource`.
    expect(bodies.a.asyncResource).toBe(true);
    // Both requests had installed their `ctx.tracing` before either opened a
    // span, so one request's spans went through the other's tracing object.
    expect(bodies.a.overlapped && bodies.b.overlapped).toBe(true);

    for (const { role, spans: own } of report) {
      for (const span of own) {
        expect({ span: span.name, trace: span.trace, parent: span.parent }).toEqual({
          span: span.name,
          trace: role,
          parent: "handler",
        });
      }
    }
    for (const { role, spans: own } of report) {
      expect(own.map((s) => s.name)).toEqual([
        `e2e.${role}.background`,
        `e2e.${role}.child`,
        `e2e.${role}.failing`,
        `e2e.${role}.outer`,
      ]);
    }

    // The caller's `traceparent` is not adopted.
    expect(handlerA.trace_id).not.toBe(FORGED_TRACE_ID);

    for (const { role, spans: own, logs: lines } of report) {
      const outer = own.find((s) => s.name === `e2e.${role}.outer`)!;
      expect(outer.attributes["email"]).toBe("[REDACTED]");
      expect(outer.attributes["kind"]).toBe("probe");
      const failing = own.find((s) => s.name === `e2e.${role}.failing`)!;
      // The error status is set too, but wrangler's local collector does not
      // record it: its `outcome` column reads `ok` for such a span.
      expect(failing.attributes["error.type"]).toBe("LookupFailed");

      // A structured object at its own level, annotations redacted.
      expect(lines).toContainEqual({
        level: "info",
        message: `e2e ${role} looked up`,
        annotations: { email: "[REDACTED]", weddingId: `wed_${role}` },
      });
    }
    // One error-level row per request: the program's `logError`. No span wrote one.
    for (const handler of [handlerA, handlerB]) {
      const errors = logs.filter((l) => l.trace_id === handler.trace_id && l.level === "error");
      expect(errors).toHaveLength(1);
    }
  }, 150_000);
});
