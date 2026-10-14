import { readFile, writeFile } from "node:fs/promises";

const source = "cire/invites/dist/server/wrangler.json";
const target = "cire/invites/dist/server/wrangler-traced.json";

const config = JSON.parse(await readFile(source, "utf8"));

if (
  config.name !== "cire-invites" ||
  config.main !== "entry.mjs" ||
  config.assets?.directory !== "../client" ||
  config.routes?.length !== 1 ||
  config.routes[0]?.pattern !== "invite.cireweddings.com" ||
  config.routes[0]?.custom_domain !== true ||
  config.observability?.traces?.enabled !== false
) {
  throw new Error("The generated legacy invites config changed; inspect it before tracing");
}

config.name = "cire-invites-traced";
config.routes = [{ pattern: "invite.cireweddings.com/cire/*", zone_name: "cireweddings.com" }];
config.workers_dev = false;
config.preview_urls = false;
config.observability = {
  ...config.observability,
  redact_query_string: true,
  logs: { ...config.observability.logs, invocation_logs: false },
  traces: { enabled: true, head_sampling_rate: 1 },
};

await writeFile(target, JSON.stringify(config));
