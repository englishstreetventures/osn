#!/usr/bin/env node
/**
 * The reference side of scripts/guest-route-parity.ts: Wrangler's local
 * runtime serving the guest build's generated config, started on Node with
 * `unstable_startWorker`, from the wrangler cire/invites resolves.
 *
 * It is plain JavaScript on Node's built-ins, and imports nothing from the
 * repository's TypeScript, because Wrangler and Miniflare run on Node: Bun
 * replaces the `undici` and `ws` Miniflare is built on. Its types, for the
 * tests that import it under Bun, are in guest-route-parity-reference.d.ts.
 *
 * Every call the Worker makes to `--api-origin` goes to the relay in the
 * parent on 127.0.0.1:<relay-port>, its path and query kept, with the run's
 * token and whether the Worker's own request carried a user agent; the relay
 * sends it on to cire-api. A call to any other origin goes out from here as
 * the Worker sent it. No redirect is followed: the Worker sees each one.
 *
 * Usage, with cire/invites as the working directory:
 *
 *   PARITY_RELAY_TOKEN=<token> node scripts/guest-route-parity-reference.js \
 *     --port <n> --relay-port <n> --api-origin <origin> \
 *     --persist <dir> --env-file <empty file> [--config <wrangler.json>]
 *
 * `--config` defaults to `dist/server/wrangler.json`. The Worker listens on
 * 127.0.0.1:<port> and sees that as its own origin; it has no inspector, no
 * remote bindings, no file watching and no dev registry, and loads only the
 * env file it is given.
 *
 * Exit codes: 2 a usage error; 3 wrangler could not be loaded, or did not
 * start (the reason on stderr); otherwise it serves until it is killed.
 */

import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

/** Whether the Worker's own request to cire-api carried a user agent: `present` or `absent`. */
export const WORKER_UA_HEADER = "x-parity-worker-ua";

/** The run's relay token, without which the relay serves nothing. */
export const RELAY_TOKEN_HEADER = "x-parity-relay-token";

/**
 * The function Miniflare hands every outbound request of the Worker to. A
 * request whose origin is exactly `apiOrigin` goes to the relay; any other
 * goes where it was sent. Miniflare's request comes from its own undici,
 * which Node's fetch does not take as a request, so it is rebuilt from its
 * URL, method, headers and body, the body streamed (`duplex: "half"`).
 */
export function makeForward({ apiOrigin, relayPort, token, fetchImpl }) {
  return (request) => {
    const url = new URL(request.url);
    const headers = new Headers(request.headers);
    const init = {
      method: request.method,
      headers,
      body: request.body,
      duplex: "half",
      redirect: "manual",
    };
    if (url.origin !== apiOrigin) return fetchImpl(request.url, init);
    headers.set(WORKER_UA_HEADER, request.headers.has("user-agent") ? "present" : "absent");
    headers.set(RELAY_TOKEN_HEADER, token);
    return fetchImpl(`http://127.0.0.1:${relayPort}${url.pathname}${url.search}`, init);
  };
}

/**
 * `error`'s message on one line, followed by each cause's: Wrangler wraps the
 * reason a start fails in a generic error's `cause`.
 */
function oneLine(error) {
  const messages = [];
  let at = error;
  while (at !== undefined && at !== null && messages.length < 4) {
    messages.push(at instanceof Error ? at.message : String(at));
    at = at instanceof Error ? at.cause : undefined;
  }
  return messages
    .join(": ")
    .replaceAll(/\s*\n\s*/g, " ")
    .trim();
}

/** What a Wrangler DevEnv error event says: a UserError, or `{ source, reason, cause }`. */
function describeEvent(event) {
  if (event instanceof Error) return oneLine(event);
  const what = [event?.source, event?.reason].filter((part) => typeof part === "string");
  const cause = event?.cause === undefined ? "" : ` (${oneLine(event.cause)})`;
  return `${what.join(": ")}${cause}`;
}

function fail(code, message) {
  process.stderr.write(`guest-route-parity-reference: ${message}\n`);
  process.exit(code);
}

const USAGE =
  "usage: guest-route-parity-reference.js --port <n> --relay-port <n> --api-origin <origin> --persist <dir> --env-file <file> [--config <wrangler.json>], with PARITY_RELAY_TOKEN set";

async function main(args) {
  let values;
  try {
    ({ values } = parseArgs({
      args,
      strict: true,
      options: {
        config: { type: "string", default: "dist/server/wrangler.json" },
        port: { type: "string" },
        "relay-port": { type: "string" },
        "api-origin": { type: "string" },
        persist: { type: "string" },
        "env-file": { type: "string" },
      },
    }));
  } catch (error) {
    fail(2, `${oneLine(error)}; ${USAGE}`);
  }
  const port = Number(values.port);
  const relayPort = Number(values["relay-port"]);
  const apiOrigin = values["api-origin"] ?? "";
  const token = process.env.PARITY_RELAY_TOKEN ?? "";
  const given = [apiOrigin, values.persist ?? "", values["env-file"] ?? "", token];
  if (!Number.isInteger(port) || !Number.isInteger(relayPort) || given.includes("")) {
    fail(2, USAGE);
  }

  let wrangler;
  try {
    wrangler = createRequire(join(process.cwd(), "package.json"))("wrangler");
  } catch (error) {
    fail(3, `cannot load wrangler from ${process.cwd()}: ${oneLine(error)}`);
  }

  let worker;
  try {
    worker = await wrangler.unstable_startWorker({
      config: values.config,
      envFiles: [values["env-file"]],
      dev: {
        server: { hostname: "127.0.0.1", port },
        origin: { hostname: `127.0.0.1:${port}` },
        persist: values.persist,
        inspector: false,
        remote: false,
        watch: false,
        logLevel: "warn",
        registry: undefined,
        outboundService: makeForward({
          apiOrigin,
          relayPort,
          token,
          fetchImpl: (url, init) => globalThis.fetch(url, init),
        }),
      },
    });
  } catch (error) {
    fail(3, `wrangler refused to start: ${oneLine(error)}`);
  }

  // A start-up failure arrives as an error event, not as `ready` rejecting.
  let ready = false;
  worker.raw.on("error", (event) => {
    if (!ready) fail(3, `wrangler failed while starting: ${describeEvent(event)}`);
    process.stderr.write(`guest-route-parity-reference: wrangler: ${describeEvent(event)}\n`);
  });
  try {
    await worker.ready;
  } catch (error) {
    fail(3, `wrangler did not become ready: ${oneLine(error)}`);
  }
  ready = true;
}

/** Whether Node was started on this file, by any path to it, symlinked or not. */
function startedHere() {
  try {
    const entry = process.argv[1];
    return (
      entry !== undefined && realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    return false;
  }
}

if (startedHere()) await main(process.argv.slice(2));
