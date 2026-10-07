/**
 * Mint an unlock code: a code a friend or a comp types into the organiser
 * portal to move their wedding to a paid tier with no payment. NOT a network
 * surface — an operator tool that prints, like `grant-tier.ts`.
 *
 *   bun run --cwd cire/api mint-unlock-code --tier <gold|crimson> --by <operator>
 *       [--uses <1-1000>] [--expires <YYYY-MM-DD>]
 *
 * Prints two lines: `code: <code>`, the code to hand over, and `sql: …`, the
 * row to apply. The SQL carries only the code's SHA-256, so neither the shell
 * history it lands in nor the database holds a code anyone could redeem. The
 * code itself is shown here once and stored nowhere: keep it until it has been
 * handed over.
 *
 * `--uses` is how many weddings may redeem it (default 1). `--expires` is the
 * last day it works, through the end of that day in UTC; without it the code
 * never expires. `--by` names the operator, recorded as `script:<operator>`.
 *
 * Production: from `cire/api`, apply the printed SQL with `wrangler d1 execute
 * cire-db --env production --remote --command "<sql>"`, naming the env as every
 * production D1 command in the deploy runbook does. It is a prod D1 write,
 * which needs explicit human authorisation naming `cire-db` first.
 */
import { generateRecoveryCode, hashRecoveryCode } from "@shared/crypto/recovery";

import { isPaidTier } from "../src/services/tiers";
import type { PaidTier } from "../src/services/tiers";

const OPERATOR_RE = /^[A-Za-z0-9_]+$/;
const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
/** Far beyond any comp; a larger number is a typo, not a plan. */
const MAX_USES = 1000;

const USAGE =
  "usage: mint-unlock-code --tier <gold|crimson> --by <operator> [--uses <1-1000>] [--expires <YYYY-MM-DD>]";

export interface MintRequest {
  tier: PaidTier;
  uses: number;
  /** The first instant the code no longer works, or null for never. */
  expiresAt: Date | null;
  /** `script:<operator>`. */
  createdBy: string;
}

export interface MintedCode extends MintRequest {
  id: string;
  /** Shown to the operator once, never stored. */
  code: string;
  codeHash: string;
  createdAt: Date;
}

/** The instant after the last day `day` names, in UTC — or a reason it is not one. */
function endOfDay(day: string, now: Date): Date {
  const match = DAY_RE.exec(day);
  if (!match) throw new Error(`--expires takes a day as YYYY-MM-DD, not ${day}`);
  const [, y, m, d] = match.map(Number) as [number, number, number, number];
  const start = new Date(Date.UTC(y, m - 1, d));
  if (start.getUTCFullYear() !== y || start.getUTCMonth() !== m - 1 || start.getUTCDate() !== d) {
    throw new Error(`--expires names a day that does not exist: ${day}`);
  }
  const end = new Date(Date.UTC(y, m - 1, d + 1));
  if (end.getTime() <= now.getTime()) throw new Error(`--expires is already past: ${day}`);
  return end;
}

/**
 * Validate the operator's arguments before any of them reaches SQL. Every
 * value {@link unlockCodeToSql} interpolates has passed one of these checks or
 * is generated here, which is what makes the printed statement safe.
 */
export function parseMintArgs(argv: readonly string[], now: Date): MintRequest {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i]!;
    if (!["--tier", "--uses", "--expires", "--by"].includes(flag)) {
      throw new Error(`unknown argument ${flag}\n${USAGE}`);
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${flag} needs a value\n${USAGE}`);
    }
    values.set(flag, value);
  }

  const tier = values.get("--tier");
  if (tier === undefined) throw new Error(`--tier is required\n${USAGE}`);
  if (!isPaidTier(tier)) throw new Error(`--tier must be gold or crimson, not ${tier}`);

  const operator = values.get("--by");
  if (operator === undefined) throw new Error(`--by is required\n${USAGE}`);
  if (!OPERATOR_RE.test(operator)) {
    throw new Error("--by takes letters, digits and underscores only");
  }

  const usesArg = values.get("--uses") ?? "1";
  const uses = Number(usesArg);
  if (!/^\d+$/.test(usesArg) || uses < 1 || uses > MAX_USES) {
    throw new Error(`--uses takes a whole number from 1 to ${MAX_USES}, not ${usesArg}`);
  }

  const expires = values.get("--expires");
  return {
    tier,
    uses,
    expiresAt: expires === undefined ? null : endOfDay(expires, now),
    createdBy: `script:${operator}`,
  };
}

/** A fresh code for `req`: random, in the recovery-code format, with its hash. */
export function mintUnlockCode(req: MintRequest, now: Date): MintedCode {
  const code = generateRecoveryCode();
  return {
    ...req,
    id: `ulc_${crypto.randomUUID()}`,
    code,
    codeHash: hashRecoveryCode(code),
    createdAt: now,
  };
}

const seconds = (at: Date): number => Math.floor(at.getTime() / 1000);

/** The row for `minted`, ready for `wrangler d1 execute`. Holds the hash, never the code. */
export function unlockCodeToSql(minted: MintedCode): string {
  const expires = minted.expiresAt === null ? "NULL" : String(seconds(minted.expiresAt));
  return (
    "INSERT INTO unlock_codes (id, code_hash, tier, max_redemptions, redeemed_count, expires_at, created_by, created_at) " +
    `VALUES ('${minted.id}', '${minted.codeHash}', '${minted.tier}', ${minted.uses}, 0, ${expires}, ` +
    `'${minted.createdBy}', ${seconds(minted.createdAt)});`
  );
}

// Thin main. Guarded so importing the module in tests does not execute it.
if (import.meta.main) {
  const now = new Date();
  let minted: MintedCode;
  try {
    minted = mintUnlockCode(parseMintArgs(Bun.argv.slice(2), now), now);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
  process.stdout.write(`code: ${minted.code}\nsql: ${unlockCodeToSql(minted)}\n`);
}
