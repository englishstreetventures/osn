/**
 * A live read that matches a stack's adopted resources exactly, for each
 * product's `plan:guard` tests (`<product>/infra/tests/plan-guard.test.ts`
 * imports this by relative path): every resource exists, each Worker holds
 * every secret the inventory requires of it on production and nothing else,
 * its crons, Durable Object classes and observability are the declared ones,
 * and each database and bucket holds its declared settings.
 */

import type { AdoptedResources, LedgerCounts, LiveState } from "../../src/production-live";
import { tierSecrets } from "../../src/secrets/inventory";

/** A migrated database's ledger once converted and frozen, with nothing to apply. */
export const CONVERTED_LEDGER: LedgerCounts = {
  table: "__alchemy_migrations",
  foreign: 0,
  frozen: true,
  rows: 12,
  duplicates: 0,
  matched: 12,
  unmatched: 0,
  rewritten: 0,
  pending: 0,
  skipped: 0,
  late: 0,
  wranglerRows: 11,
  frozenMissing: 0,
};

export function matchingLive(adopted: AdoptedResources): LiveState {
  return {
    workers: Object.fromEntries(
      Object.entries(adopted.workers).map(([id, worker]) => [
        id,
        {
          exists: true,
          secrets: [...tierSecrets(worker.worker, "production").secrets],
          crons: [...worker.crons],
          durableObjectClasses: Object.values(worker.durableObjects),
          domains: [],
          observability: {
            enabled: worker.observability.logs,
            logs: {
              enabled: worker.observability.logs,
              invocation_logs:
                worker.observability.logs && (worker.observability.invocationLogs ?? false),
            },
            traces: { enabled: worker.observability.traces.enabled },
            redact_query_string: worker.observability.redactQueryString,
          },
        },
      ]),
    ),
    databases: Object.fromEntries(
      Object.entries(adopted.databases).map(([id, database]) => [
        id,
        {
          exists: true,
          readReplication: database.readReplication,
          ...(database.migrations === null ? {} : { ledger: CONVERTED_LEDGER }),
        },
      ]),
    ),
    buckets: Object.fromEntries(
      Object.entries(adopted.buckets).map(([id, bucket]) => [
        id,
        {
          exists: true,
          lifecycleRules: [...bucket.lifecycleRules],
          corsRules: bucket.cors.length,
          managedDomain: bucket.publicAccess,
          customDomains: [...bucket.domains],
        },
      ]),
    ),
  };
}
