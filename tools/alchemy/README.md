# Alchemy dev probe

This workspace checks the Cire and OSN dev API infrastructure with Alchemy. It adopts the dev D1 databases (`cire-db-dev`, `osn-db-dev`) and Cire's dev R2 buckets (`cire-sheets-dev`, `cire-assets-dev`), and deploys two temporary Workers on `workers.dev`, `cire-api-alchemy-probe-dev` and `osn-api-alchemy-probe-dev`, that prove the bindings work. The routed dev APIs and their Wrangler deployments stay the source of truth; the stack never names them.

## What stops a run

`alchemy.run.ts` refuses before it declares anything when:

- the stage is not `dev`, or the run did not start in this directory (local state lives in `.alchemy/` here, and a run from anywhere else would plan against empty state) — `run-mode.ts`;
- any name or id the probe uses is not the one `[env.dev]` binds in `cire/api/wrangler.toml` or `osn/api/wrangler.toml`, is used by any other environment of any committed Worker config, or a probe Worker name matches a Worker those configs deploy — `boundary.ts`. Recreating a dev database means updating its pinned id there as well as in `wrangler.toml`;
- the live buckets and databases differ from what the stack declares — `storage-preflight.ts`, below;
- `ALCHEMY_PROBE_TOKEN` is shorter than 32 characters — `config.ts`.

### Adoption never changes the dev storage

Alchemy follows every adoption with an update that sets each resource's mutable settings to the declaration: an R2 bucket's storage class, lifecycle rules, CORS rules and public r2.dev access, and a D1 database's read replication. The stack declares what the dev tier has today — Standard storage, no lifecycle rules, no CORS rules, r2.dev off, read replication disabled (`DEV_BUCKET_SETTINGS` and `DEV_DATABASE_SETTINGS`) — and the preflight reads the live resources and refuses unless they match exactly, using Alchemy's own comparison. When it passes, the update has nothing to write. It also refuses when a bucket or database is missing, so the stack never creates one, and when a database's id is not the pinned dev id.

When it refuses, it prints each live setting next to the declared one. If the live setting is intended, add it to the declaration in that printed form; never change a dev resource to suit the probe.

All four storage resources are declared with `RemovalPolicy.retain()`: destroy, an orphaned declaration and a replacement forget them and never delete them.

## Run the probe

Give Alchemy a Cloudflare API token rather than its OAuth login, which grants write access across the account's developer platform. Store it in the profile (`bun alchemy profile edit --add Cloudflare`, kept in `~/.alchemy`, readable only by you) or set `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` in the shell, which take precedence over the profile. The stack uploads and deletes the two probe Workers and, once the preflight passes, only reads D1 and R2, so a token limited to Workers Scripts edit plus read-only D1 and Workers R2 Storage should be enough. That set has not been tried end to end; widen it only if a run fails on a permission.

From `tools/alchemy`, in one shell:

```bash
umask 077
export ALCHEMY_PROBE_TOKEN="$(openssl rand -hex 32)"
bun run plan --no-input
bun run deploy --yes --no-input
```

Deploy prints `cireUrl` and `osnUrl`. Check each one, sending the token on stdin so it never appears in the process list:

```bash
printf 'Authorization: Bearer %s\n' "$ALCHEMY_PROBE_TOKEN" | curl -fsS -H @- "<cireUrl>/health"
printf 'Authorization: Bearer %s\n' "$ALCHEMY_PROBE_TOKEN" | curl -fsS -H @- "<osnUrl>/health"
bun run plan --no-input
```

Both responses should be `{"product":…,"ok":true}` and the second plan should show no changes. A request without the token gets 401 before any storage read. The probe answers only `GET /health`: it runs `SELECT 1` on D1, lists at most one key from each Cire bucket, checks that the Images and rate-limit bindings exist, and returns nothing it read. It binds the dev rate-limit namespaces `1101` and `2101`, whose counters the routed dev Workers share, and never calls them.

`alchemy drift --config alchemy.run.ts --stage dev --no-input` compares what Alchemy reads back with what it stored. The stack declares read replication explicitly so both sides say `disabled`; left unset, every adopted database reports as changed with no live difference. Do not run `drift --repair` on the adopted databases ([#1490](https://github.com/englishstreetventures/osn/issues/1490)).

## Clean up

The probe Workers are public while they exist, so remove them once the checks pass. The `destroy` script sets `ALCHEMY_PROBE_TEARDOWN=1`, which skips the token and storage checks so cleanup cannot be blocked by them:

```bash
bun run destroy --dry-run --no-input
bun run destroy --yes --no-input
```

The plan should delete only the two probe Workers and forget the four storage resources. Confirm both probe URLs stop answering. If a provider rate limit interrupts destroy, check each resource in Cloudflare before retrying; local state can differ from live resources after a partial failure.

Between deploy and destroy, `.alchemy/state/` holds the probe token in plaintext, because Alchemy stores each Worker's inputs. Git ignores the directory, `umask 077` keeps the files private, and destroy deletes the Worker rows that hold it.

## Adoption boundary

This probe does not update `cire-api-dev` or `osn-api-dev`. Alchemy `2.0.0-beta.80` does not preserve undeclared Worker secret bindings during an update to an existing Worker. Both routed dev APIs have secret bindings that Alchemy cannot import from Cloudflare as values. The existing GitHub dev token also lacks Secrets Store write access for a CI state store. Keep Wrangler as the deploy path for the routed APIs until those inputs and the full Worker configuration can be represented safely.

The Workers provider also adds `new_module_registry` to compatibility flags in this beta. A routed Worker adoption requires an explicit review of that setting and of observability; Cire invocation logs must remain disabled.
