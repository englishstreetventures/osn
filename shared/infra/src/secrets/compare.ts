import { allowedCredentials, forbiddenCredentials, requiredCredentials } from "../accounts";
import type { Tier } from "../stage";
import { SECRET_INVENTORY, WORKFLOW_SECRETS, type WorkerKey } from "./inventory";

export interface NameDiff {
  readonly where: string;
  readonly missing: readonly string[];
  readonly unexpected: readonly string[];
  /** Held names the inventory says must never be set there. */
  readonly forbidden: readonly string[];
}

/**
 * `required` names absent from `actual`; `actual` names in `forbidden`; and
 * `actual` names that are neither required, `allowed` nor forbidden.
 */
export function diffNames(
  where: string,
  required: readonly string[],
  actual: readonly string[],
  allowed: readonly string[] = [],
  forbidden: readonly string[] = [],
): NameDiff {
  const known = new Set([...required, ...allowed, ...forbidden]);
  const banned = new Set(forbidden);
  const have = new Set(actual);
  return {
    where,
    missing: required.filter((name) => !have.has(name)).toSorted(),
    unexpected: actual.filter((name) => !known.has(name)).toSorted(),
    forbidden: actual.filter((name) => banned.has(name)).toSorted(),
  };
}

/** The secret names in `wrangler secret list --format json` output; throws on anything else. */
export function parseWranglerSecretList(stdout: string): string[] {
  const parsed: unknown = JSON.parse(stdout);
  if (!Array.isArray(parsed)) throw new Error("wrangler secret list did not print a JSON array");
  return parsed
    .map((entry: unknown) => {
      if (
        typeof entry !== "object" ||
        entry === null ||
        !("name" in entry) ||
        typeof entry.name !== "string"
      ) {
        throw new Error("wrangler secret list printed an entry with no name");
      }
      return entry.name;
    })
    .toSorted();
}

export interface LiveExpectation {
  readonly worker: WorkerKey;
  readonly tier: Tier;
  readonly scriptName: string;
  readonly required: readonly string[];
  readonly optional: readonly string[];
  readonly forbidden: readonly string[];
}

/** One tier's deployed Workers and the names each must, may and must not hold. */
export function liveExpectations(tier: Tier): LiveExpectation[] {
  return SECRET_INVENTORY.flatMap((entry) => {
    const row = entry.tiers[tier];
    return row.scriptName === null
      ? []
      : [
          {
            worker: entry.worker,
            tier,
            scriptName: row.scriptName,
            required: row.secrets,
            optional: row.optional,
            forbidden: row.forbidden,
          },
        ];
  });
}

export function liveDiff(expected: LiveExpectation, actual: readonly string[]): NameDiff {
  return diffNames(
    `${expected.worker} ${expected.tier} (${expected.scriptName})`,
    expected.required,
    actual,
    expected.optional,
    expected.forbidden,
  );
}

/**
 * Every name the tier's GitHub Environment must hold, once: each required
 * Worker secret, the tier's required credentials and the secrets only its
 * workflows read.
 */
export function githubExpectations(tier: Tier): string[] {
  return [
    ...new Set([
      ...SECRET_INVENTORY.flatMap((entry) => entry.tiers[tier].secrets),
      ...requiredCredentials(tier),
      ...WORKFLOW_SECRETS[tier],
    ]),
  ].toSorted();
}

/**
 * Missing required names and the other tier's credentials fail; optional
 * secrets and the old credentials the tier may still hold are not unexpected.
 */
export function githubDiff(tier: Tier, actual: readonly string[]): NameDiff {
  const optional = SECRET_INVENTORY.flatMap((entry) => entry.tiers[tier].optional);
  return diffNames(
    `GitHub Environment ${tier}`,
    githubExpectations(tier),
    actual,
    [...optional, ...allowedCredentials(tier)],
    forbiddenCredentials(tier),
  );
}

/** True when nothing is missing, unexpected or forbidden. */
export const isClean = (diff: NameDiff): boolean =>
  diff.missing.length === 0 && diff.unexpected.length === 0 && diff.forbidden.length === 0;

export function formatDiffs(diffs: readonly NameDiff[]): string {
  return diffs
    .map((diff) => {
      if (isClean(diff)) return `ok    ${diff.where}\n`;
      const missing = diff.missing.length > 0 ? ` — missing: ${diff.missing.join(", ")}` : "";
      const unexpected =
        diff.unexpected.length > 0 ? ` — not in the inventory: ${diff.unexpected.join(", ")}` : "";
      const forbidden =
        diff.forbidden.length > 0 ? ` — forbidden but set: ${diff.forbidden.join(", ")}` : "";
      return `DIFF  ${diff.where}${missing}${unexpected}${forbidden}\n`;
    })
    .join("");
}

/** The tier a check script runs for: `--tier dev` or `--tier production`, nothing else. */
export function parseTierArgument(argv: readonly string[]): Tier {
  const at = argv.indexOf("--tier");
  const value = at === -1 ? undefined : argv[at + 1];
  if (value === "dev" || value === "production") return value;
  throw new Error(
    "pass --tier dev or --tier production: each tier is a separate Cloudflare account",
  );
}

/** The account a live check reads, which the caller must name: one login can see several accounts. */
export function accountIdFrom(env: Readonly<Record<string, string | undefined>>): string {
  const id = env.CLOUDFLARE_ACCOUNT_ID?.trim() ?? "";
  if (id === "") {
    throw new Error(
      "set CLOUDFLARE_ACCOUNT_ID to the account that serves this tier's Workers; a login that sees several accounts must not pick one",
    );
  }
  return id;
}

/** `text` with every Cloudflare account id (32 lowercase hex characters) replaced, so tool errors never carry one into a log. */
export function redactAccountIds(text: string): string {
  return text
    .replace(/\/accounts\/[0-9a-f]{32}/g, "/accounts/<account-id>")
    .replace(/[0-9a-f]{32}/g, "<account-id>");
}
