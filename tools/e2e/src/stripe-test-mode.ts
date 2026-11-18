/**
 * What the run against Stripe's test mode decides from text it is handed: the
 * key and account it may use, whether the GitHub Environment holding them is
 * open to `main` alone, what of `stripe listen`'s output reaches the log, and
 * how the Stripe stand-in's answers compare with Stripe's own.
 *
 * Imports nothing from this repository. The test-mode entry
 * (`stripe-test-mode-launcher.ts`) loads this before it sets the suite clock's
 * start, and `config.ts` reads that start when it is first loaded, so nothing
 * here may reach `config.ts`. `tests/stripe-test-mode.test.ts` holds both
 * files' import lists to that.
 *
 * No function here returns or prints a key it was given: a refusal names the
 * variable and the rule it breaks, and the log goes through
 * {@link redactStripeSecrets}.
 */

/** The GitHub Environment the nightly job reads its Stripe values from. */
export const STRIPE_TEST_ENVIRONMENT = "stripe-test-mode";
/** The secret: the sandbox's test-mode secret key. */
export const SECRET_KEY_VAR = "STRIPE_TEST_SECRET_KEY";
/** The variable: the sandbox's connected account the gift is charged on. */
export const ACCOUNT_VAR = "STRIPE_TEST_CONNECTED_ACCOUNT";

/**
 * The `Stripe-Version` the flow reads Stripe's objects in: cire-api's own pin
 * (`STRIPE_API_VERSION` in `cire/api/src/services/stripe.ts`), which a test
 * holds this to.
 */
export const STRIPE_TEST_API_VERSION = "2025-03-31.basil";

/** Stripe's API origin, where every call of the test-mode run goes. */
const STRIPE_API = "https://api.stripe.com";

export type StripeTestMode =
  | { readonly kind: "absent" }
  | { readonly kind: "refused"; readonly reason: string }
  | { readonly kind: "ready"; readonly secretKey: string; readonly account: string };

/**
 * A test-mode key, and nothing around it. The same rule the dev tier's cire
 * stack holds `STRIPE_SECRET_KEY` to (`shared/infra/src/secrets/require.ts`),
 * with the body after the prefix spelled out: a value is never trimmed, since
 * a pasted newline would otherwise reach Stripe as a different key.
 */
const TEST_KEY = /^(sk|rk)_test_[A-Za-z0-9]+$/;
const ACCOUNT_ID = /^acct_[A-Za-z0-9]+$/;

/**
 * Which key and account the run may use. Neither set (empty is what GitHub
 * passes for a secret or a variable that is not set) is no run. Anything else
 * short of a test key and a well-formed account is a refusal: the account with
 * no key is a setup half undone, a key deleted after the run has worked, and
 * a key that is not a test-mode one, or one with no account beside it, would
 * fail later and less clearly.
 */
export function stripeTestMode(env: Readonly<Record<string, string | undefined>>): StripeTestMode {
  const secretKey = env[SECRET_KEY_VAR];
  if (secretKey === undefined || secretKey === "") {
    const account = env[ACCOUNT_VAR];
    if (account === undefined || account === "") return { kind: "absent" };
    return {
      kind: "refused",
      reason: `${SECRET_KEY_VAR} is not set but ${ACCOUNT_VAR} is: the ${STRIPE_TEST_ENVIRONMENT} setup is half undone; store the key again, or delete the variable as well to skip the run`,
    };
  }
  if (!TEST_KEY.test(secretKey)) {
    return {
      kind: "refused",
      reason: `${SECRET_KEY_VAR} is not a test-mode key: it must be sk_test_ or rk_test_ followed by letters and digits, with nothing before or after it`,
    };
  }
  const account = env[ACCOUNT_VAR];
  if (account === undefined || account === "") {
    return {
      kind: "refused",
      reason: `${ACCOUNT_VAR} is not set: it names the sandbox's connected account the gift is charged on`,
    };
  }
  if (!ACCOUNT_ID.test(account)) {
    return {
      kind: "refused",
      reason: `${ACCOUNT_VAR} is not a connected account id: it must be acct_ followed by letters and digits`,
    };
  }
  return { kind: "ready", secretKey, account };
}

/**
 * Why the Environment's secret could reach a branch other than `main`, or null
 * when it cannot. Takes GitHub's answers to `GET …/environments/<name>` and
 * `GET …/environments/<name>/deployment-branch-policies`, or null for one that
 * could not be read, which is a refusal too.
 *
 * Only custom rules naming the `main` branch and nothing else pass. "Protected
 * branches" names no branch: it admits whatever branch protection covers.
 */
export function branchPolicyRefusal(environment: unknown, policies: unknown): string | null {
  const fix = `set the ${STRIPE_TEST_ENVIRONMENT} Environment's deployment branches to the main branch alone`;
  if (environment === null || policies === null) {
    return `could not read the ${STRIPE_TEST_ENVIRONMENT} Environment's deployment branches; ${fix}`;
  }
  const policy = (environment as { deployment_branch_policy?: unknown })
    .deployment_branch_policy as
    | { protected_branches?: unknown; custom_branch_policies?: unknown }
    | null
    | undefined;
  if (policy === null || policy === undefined) {
    return `every branch can read the ${STRIPE_TEST_ENVIRONMENT} Environment's secret; ${fix}`;
  }
  if (policy.custom_branch_policies !== true || policy.protected_branches === true) {
    return `the ${STRIPE_TEST_ENVIRONMENT} Environment admits protected branches rather than named ones; ${fix}`;
  }
  const rules = (policies as { branch_policies?: unknown }).branch_policies;
  const named = Array.isArray(rules)
    ? rules.map((rule) => {
        const { name, type } = rule as { name?: unknown; type?: unknown };
        return `${String(type ?? "branch")}:${String(name)}`;
      })
    : [];
  if (named.length !== 1 || named[0] !== "branch:main") {
    return `the ${STRIPE_TEST_ENVIRONMENT} Environment's deployment branches are not the main branch alone; ${fix}`;
  }
  return null;
}

/**
 * ANSI colour and hyperlink sequences. `stripe listen` runs with `--color off`
 * into a pipe and should write none; one that slips through would otherwise
 * split a JSON line or a status line.
 */
// oxlint-disable-next-line no-control-regex -- matching the escape character is the point
const ANSI = /\u001b\[[0-9;]*m|\u001b\]8;[^\u0007\u001b]*(?:\u0007|\u001b\\)/g;

const stripAnsi = (text: string): string => text.replace(ANSI, "");

/**
 * The text with every Stripe secret in it replaced: a webhook signing secret
 * and a secret or restricted key, test or live, Stripe's masked form of one
 * (`sk_test_****0000`) included.
 */
export function redactStripeSecrets(text: string): string {
  return text
    .replace(/whsec_[A-Za-z0-9*]+/g, "whsec_[redacted]")
    .replace(/(sk|rk)_(test|live)_[A-Za-z0-9*]+/g, "$1_$2_[redacted]");
}

/** The signing secret on `stripe listen`'s `Ready!` line, or null for any other line. */
export function webhookSecretIn(line: string): string | null {
  return (
    /Ready!.*webhook signing secret is (whsec_[A-Za-z0-9]+)/.exec(stripAnsi(line))?.[1] ?? null
  );
}

/**
 * What of one line of `stripe listen`'s output goes to the log: the line
 * without colour and with its secrets redacted, or null to leave it out. An
 * event from any connected account but the configured one is left out, so a
 * sandbox shared by mistake puts nobody else's payment in a public artifact.
 */
export function listenLine(line: string, account: string): string | null {
  const plain = stripAnsi(line);
  if (plain.trimStart().startsWith("{")) {
    try {
      const event = JSON.parse(plain) as { account?: unknown };
      if (event.account !== account) return null;
    } catch {
      // Not an event: kept, redacted, like any other line.
    }
  }
  return redactStripeSecrets(plain);
}

/** A value parsed from JSON. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [field: string]: JsonValue };

/** A JSON object: a Stripe object, an event, an answer from GitHub. */
export interface JsonObject {
  readonly [field: string]: JsonValue;
}

/** One field the stand-in sends, with its JSON type there and in Stripe's answer. */
export interface FieldTypes {
  readonly path: string;
  readonly standIn: string;
  readonly stripe: string;
}

const typeOf = (value: unknown): string => {
  if (value === undefined) return "absent";
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
};

const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Every field the stand-in's answer carries, with its type there and in
 * Stripe's, by dotted path. An object on both sides is read into; an object
 * Stripe sends as anything else is one row. Fields only Stripe sends are not
 * listed: the stand-in answers what cire-api reads, and Stripe sends far more.
 * A row whose two types differ is drift.
 */
export function fieldTypes(standIn: unknown, stripe: unknown, prefix = ""): FieldTypes[] {
  if (!isObject(standIn)) return [];
  const theirs: JsonObject = isObject(stripe) ? stripe : {};
  const rows: FieldTypes[] = [];
  for (const [field, value] of Object.entries(standIn)) {
    const path = prefix === "" ? field : `${prefix}.${field}`;
    const other = theirs[field];
    rows.push({ path, standIn: typeOf(value), stripe: typeOf(other) });
    if (isObject(value) && isObject(other)) rows.push(...fieldTypes(value, other, path));
  }
  return rows;
}

/** The drifted rows as one line a check can compare, or `none`. */
export function driftLine(rows: readonly FieldTypes[]): string {
  const drifted = rows.filter((row) => row.standIn !== row.stripe);
  return drifted.length === 0
    ? "none"
    : drifted.map((row) => `${row.path}: ${row.standIn} vs ${row.stripe}`).join("; ");
}

/** The `checkout.session.completed` event for `sessionId` in the listen log, or null. */
export function forwardedEvent(log: string, sessionId: string): JsonObject | null {
  for (const raw of log.split(/\r?\n/)) {
    const line = stripAnsi(raw).trim();
    if (!line.startsWith("{")) continue;
    let event: JsonValue;
    try {
      event = JSON.parse(line) as JsonValue;
    } catch {
      continue;
    }
    if (!isObject(event) || event.type !== "checkout.session.completed") continue;
    const data = event.data;
    const object = isObject(data) ? data.object : undefined;
    if (isObject(object) && object.id === sessionId) return event;
  }
  return null;
}

/** How the forwarded endpoint answered `eventId`, from the listen log, or null before it has. */
export function webhookAnswer(
  log: string,
  eventId: string,
): { readonly status: number; readonly url: string } | null {
  for (const raw of log.split(/\r?\n/)) {
    const match = /<--\s+\[(\d{3})\]\s+POST\s+(\S+)\s+\[(evt_[A-Za-z0-9]+)\]/.exec(stripAnsi(raw));
    if (match?.[3] === eventId) return { status: Number(match[1]), url: match[2] ?? "" };
  }
  return null;
}

/** A Stripe answer: its status and its parsed body (null when it was not JSON). */
export interface StripeAnswer {
  readonly status: number;
  readonly body: JsonValue;
}

/**
 * Calls to Stripe's test mode with `secretKey`, form-encoded as cire-api
 * sends them, in cire-api's API version, on a connected account when
 * `account` is given. Node's `fetch`, never a Playwright request context,
 * whose trace would record the `Authorization` header.
 */
export function stripeCaller(secretKey: string, fetchImpl: typeof fetch = fetch) {
  return async (
    method: "GET" | "POST",
    path: string,
    options: { readonly form?: Readonly<Record<string, string>>; readonly account?: string } = {},
  ): Promise<StripeAnswer> => {
    const headers = new Headers({
      authorization: `Bearer ${secretKey}`,
      "stripe-version": STRIPE_TEST_API_VERSION,
    });
    if (options.account !== undefined) headers.set("stripe-account", options.account);
    let body: string | undefined;
    if (method === "POST") {
      headers.set("content-type", "application/x-www-form-urlencoded");
      body = new URLSearchParams(options.form ?? {}).toString();
    }
    const response = await fetchImpl(`${STRIPE_API}${path}`, {
      method,
      headers,
      body,
      signal: AbortSignal.timeout(20_000),
    });
    const parsed = (await response.json().catch(() => null)) as JsonValue;
    return { status: response.status, body: parsed };
  };
}

/** Stripe's machine code for a refusal, never its message, which can quote the request. */
export function stripeErrorCode(body: unknown): string {
  const error = (body as { error?: { code?: unknown; type?: unknown } } | null)?.error;
  if (typeof error?.code === "string") return error.code;
  if (typeof error?.type === "string") return error.type;
  return "none";
}
