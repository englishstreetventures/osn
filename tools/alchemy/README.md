# Alchemy dev probe

This workspace is an isolated Cloudflare infrastructure probe for the Cire and OSN API Workers. It adopts the existing dev D1 databases and R2 buckets, then deploys two temporary Workers on `workers.dev` to verify their bindings. The routed dev APIs and their Wrangler deployments remain the source of truth.

The stack accepts only `--stage dev`. It uses local Alchemy state, so run it from this directory with one operator at a time. The state directory is ignored by Git. Resource removal retains the adopted D1 databases and R2 buckets.

## Run the probe

Authenticate Alchemy's Cloudflare profile with an account that can read the dev resources and manage Workers. Set `ALCHEMY_PROBE_TOKEN` in the deploy shell to a fresh, high-entropy secret of at least 32 bytes; keep it out of the repo and terminal history. The local Alchemy state may contain sensitive binding inputs. From `tools/alchemy`:

```bash
bun alchemy profile edit --add Cloudflare
bun run plan --no-input
bun run deploy --yes --no-input
curl -fsS -H "Authorization: Bearer $ALCHEMY_PROBE_TOKEN" https://cire-api-alchemy-probe-dev.chavaniket.workers.dev/health
curl -fsS -H "Authorization: Bearer $ALCHEMY_PROBE_TOKEN" https://osn-api-alchemy-probe-dev.chavaniket.workers.dev/health
bun run plan --no-input
```

Both health responses should contain `"ok":true`. The postdeploy plan should show no changes. Unauthenticated requests return 401 before reading storage. The probe reads D1 with `SELECT 1`, lists at most one object from each Cire R2 bucket, and checks the Images and rate limit bindings. It has no application routes or secrets.

## Clean up

Inspect the removal plan before applying it:

```bash
bun alchemy destroy alchemy.run.ts --stage dev --dry-run --no-input
bun run destroy --yes --no-input
```

The expected plan deletes only the two probe Workers and orphans the four adopted storage resources. Confirm that the two probe Worker URLs no longer respond. If a provider rate limit interrupts destroy, verify each resource in Cloudflare before retrying; the local state can differ from live resources after a partial failure. Do not delete the D1 databases or R2 buckets.

## Adoption boundary

This probe does not update `cire-api-dev` or `osn-api-dev`. Alchemy `2.0.0-beta.80` does not preserve undeclared Worker secret bindings during an update to an existing Worker. Both routed dev APIs have secret bindings that Alchemy cannot import from Cloudflare as values. The existing GitHub dev token also lacks Secrets Store write access for a CI state store. Keep Wrangler as the deploy path for the routed APIs until those inputs and the full Worker configuration can be represented safely.

The Workers provider also adds `new_module_registry` to compatibility flags in this beta. A routed Worker adoption requires an explicit review of that setting and of observability; Cire invocation logs must remain disabled.
