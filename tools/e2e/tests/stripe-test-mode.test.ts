import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  branchPolicyRefusal,
  forwardedEvent,
  listenLine,
  redactStripeSecrets,
  fieldTypes,
  STRIPE_TEST_API_VERSION,
  stripeTestMode,
  webhookAnswer,
  webhookSecretIn,
} from "../src/stripe-test-mode";

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");

// Key-shaped values are built from parts, so no fixture reads as a key to the
// secret scan, and none is one.
const key = (kind: string, mode: string, tail = "4eC39HqLyjWDarjtT1zdp7dc"): string =>
  [kind, mode, tail].join("_");
const ACCOUNT = "acct_1Abc2Def3Ghi";

describe("stripeTestMode: which key and account the test-mode run may use", () => {
  const ready = {
    STRIPE_TEST_SECRET_KEY: key("sk", "test"),
    STRIPE_TEST_CONNECTED_ACCOUNT: ACCOUNT,
  };

  test("no key is no run, and not an error", () => {
    expect(stripeTestMode({}).kind).toBe("absent");
    expect(stripeTestMode({ STRIPE_TEST_CONNECTED_ACCOUNT: ACCOUNT }).kind).toBe("absent");
  });

  test("an empty key, which is what GitHub passes for a missing secret, is no run", () => {
    expect(stripeTestMode({ ...ready, STRIPE_TEST_SECRET_KEY: "" }).kind).toBe("absent");
  });

  test.each([
    ["a live secret key", key("sk", "live")],
    ["a live restricted key", key("rk", "live")],
    ["a publishable key", key("pk", "test")],
    ["a webhook secret", ["whsec", "abc123"].join("_")],
    ["arbitrary text", "not-a-key"],
    ["the prefix with nothing after it", key("sk", "test", "")],
    ["the prefix not at the start", `x${key("sk", "test")}`],
    [
      "a live key that carries the test prefix later",
      `${key("sk", "live", "")}${key("sk", "test")}`,
    ],
    ["a test key with a space before it", ` ${key("sk", "test")}`],
    ["a test key with a newline after it", `${key("sk", "test")}\n`],
    ["a test key with a space inside it", key("sk", "test", "abc def")],
  ])("refuses %s, before anything starts", (_, value) => {
    expect(stripeTestMode({ ...ready, STRIPE_TEST_SECRET_KEY: value }).kind).toBe("refused");
  });

  test("refuses a test key with no connected account", () => {
    const decision = stripeTestMode({ STRIPE_TEST_SECRET_KEY: key("sk", "test") });
    expect(decision.kind).toBe("refused");
  });

  test.each([
    ["a hyphen for the underscore", "acct-1Abc2Def"],
    ["the prefix alone", "acct_"],
    ["a header injected after it", `${ACCOUNT}\r\nX-Other: 1`],
    ["a space after it", `${ACCOUNT} `],
  ])("refuses an account id with %s", (_, value) => {
    expect(stripeTestMode({ ...ready, STRIPE_TEST_CONNECTED_ACCOUNT: value }).kind).toBe("refused");
  });

  test("a test secret key or a test restricted key, with an account, is ready, value for value", () => {
    expect(stripeTestMode(ready)).toEqual({
      kind: "ready",
      secretKey: key("sk", "test"),
      account: ACCOUNT,
    });
    expect(stripeTestMode({ ...ready, STRIPE_TEST_SECRET_KEY: key("rk", "test") }).kind).toBe(
      "ready",
    );
  });

  test("no refusal names the key or the account it was given", () => {
    const values = [
      key("sk", "live"),
      ` ${key("sk", "test")}`,
      key("pk", "test"),
      `${ACCOUNT}\r\nX-Other: 1`,
    ];
    for (const value of values) {
      for (const env of [
        { ...ready, STRIPE_TEST_SECRET_KEY: value },
        { ...ready, STRIPE_TEST_CONNECTED_ACCOUNT: value },
      ]) {
        const decision = stripeTestMode(env);
        if (decision.kind !== "refused") continue;
        expect(decision.reason).not.toContain(value.trim());
        expect(decision.reason).not.toContain(key("sk", "test"));
      }
    }
  });
});

describe("branchPolicyRefusal: the Environment lets main alone read its secret", () => {
  const custom = {
    deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
  };
  const mainOnly = { branch_policies: [{ name: "main", type: "branch" }] };

  test("refuses an Environment any branch may deploy from", () => {
    expect(branchPolicyRefusal({ deployment_branch_policy: null }, null)).not.toBeNull();
    expect(branchPolicyRefusal({}, mainOnly)).not.toBeNull();
  });

  test("refuses protected branches, which names no branch", () => {
    const protectedOnly = {
      deployment_branch_policy: { protected_branches: true, custom_branch_policies: false },
    };
    expect(branchPolicyRefusal(protectedOnly, mainOnly)).not.toBeNull();
  });

  test("refuses custom rules that admit more than main", () => {
    expect(
      branchPolicyRefusal(custom, {
        branch_policies: [
          { name: "main", type: "branch" },
          { name: "feat/*", type: "branch" },
        ],
      }),
    ).not.toBeNull();
    expect(
      branchPolicyRefusal(custom, {
        branch_policies: [
          { name: "main", type: "branch" },
          { name: "v1", type: "tag" },
        ],
      }),
    ).not.toBeNull();
    expect(
      branchPolicyRefusal(custom, { branch_policies: [{ name: "main", type: "tag" }] }),
    ).not.toBeNull();
    expect(branchPolicyRefusal(custom, { branch_policies: [] })).not.toBeNull();
  });

  test("allows custom rules naming the main branch alone", () => {
    expect(branchPolicyRefusal(custom, mainOnly)).toBeNull();
  });

  test("refuses when either answer could not be read", () => {
    expect(branchPolicyRefusal(null, mainOnly)).not.toBeNull();
    expect(branchPolicyRefusal(custom, null)).not.toBeNull();
    expect(branchPolicyRefusal({ message: "Not Found" }, { message: "Not Found" })).not.toBeNull();
  });
});

describe("redactStripeSecrets: what stripe listen prints reaches the log without a secret", () => {
  test("replaces a webhook signing secret", () => {
    const secret = ["whsec", "a1B2c3D4e5"].join("_");
    const out = redactStripeSecrets(`Ready! Your webhook signing secret is ${secret} (^C to quit)`);
    expect(out).not.toContain(secret);
    expect(out).toContain("whsec_[redacted]");
  });

  test("replaces every kind of secret key, and Stripe's masked form of one", () => {
    for (const value of [
      key("sk", "test"),
      key("rk", "test"),
      key("sk", "live"),
      key("rk", "live"),
      key("sk", "test", "*************************0000"),
    ]) {
      const out = redactStripeSecrets(`Invalid API Key provided: ${value}`);
      expect(out).not.toContain(value);
    }
  });

  test("replaces several on one line, and leaves a line without one alone", () => {
    const line = `${key("sk", "test")} and ${["whsec", "xyz"].join("_")} and ${key("rk", "live")}`;
    const out = redactStripeSecrets(line);
    expect(out).toBe("sk_test_[redacted] and whsec_[redacted] and rk_live_[redacted]");
    const plain =
      "2026-11-18 04:41:02  <--  [200] POST http://127.0.0.1:8787/api/stripe/webhook [evt_1]";
    expect(redactStripeSecrets(plain)).toBe(plain);
  });
});

describe("webhookSecretIn: the signing secret stripe listen prints when it is ready", () => {
  const secret = ["whsec", "0a1b2c3d4e"].join("_");

  test("reads it from the Ready line, coloured or not", () => {
    const line = `Ready! You are using Stripe API Version [2025-03-31.basil]. Your webhook signing secret is ${secret} (^C to quit)`;
    expect(webhookSecretIn(line)).toBe(secret);
    expect(webhookSecretIn(line.replace(secret, `\u001b[1m${secret}\u001b[0m`))).toBe(secret);
  });

  test("reads nothing from any other line", () => {
    expect(webhookSecretIn("Getting ready...")).toBeNull();
    expect(webhookSecretIn(`a stray ${secret} with no Ready line`)).toBeNull();
  });
});

describe("listenLine: what of stripe listen's output reaches the log", () => {
  const event = (account: string | undefined) =>
    JSON.stringify({
      id: "evt_1",
      type: "checkout.session.completed",
      account,
      data: { object: { id: "cs_1" } },
    });

  test("drops an event from any account but the configured one", () => {
    expect(listenLine(event("acct_someoneElse"), ACCOUNT)).toBeNull();
    expect(listenLine(event(undefined), ACCOUNT)).toBeNull();
  });

  test("keeps the configured account's events, status lines and other text, redacted", () => {
    expect(listenLine(event(ACCOUNT), ACCOUNT)).toBe(event(ACCOUNT));
    const status = "<--  [200] POST http://127.0.0.1:8787/api/stripe/webhook [evt_1]";
    expect(listenLine(`\u001b[32m${status}\u001b[0m`, ACCOUNT)).toBe(status);
    expect(
      listenLine(`Ready! Your webhook signing secret is ${["whsec", "q"].join("_")}`, ACCOUNT),
    ).toBe("Ready! Your webhook signing secret is whsec_[redacted]");
  });
});

describe("fieldTypes: the stand-in's answer against Stripe's, field by field", () => {
  const standIn = {
    id: "cs_e2e_1",
    url: "https://checkout.stripe.com/c/pay/cs_e2e_1",
    amount_total: 7500,
    payment_intent: null,
    metadata: { contributionId: "rct_1" },
  };

  test("finds none when every field the stand-in sends is there with the same type", () => {
    const stripe = {
      ...standIn,
      id: "cs_test_x",
      livemode: false,
      metadata: { contributionId: "rct_9" },
    };
    expect(fieldTypes(standIn, stripe).filter((row) => row.standIn !== row.stripe)).toEqual([]);
  });

  test("reports a field Stripe does not send, by its path", () => {
    const { url: _url, ...stripe } = standIn;
    expect(fieldTypes(standIn, stripe).filter((row) => row.standIn !== row.stripe)).toEqual([
      { path: "url", standIn: "string", stripe: "absent" },
    ]);
  });

  test("reports a type that differs, null against a string included", () => {
    const stripe = { ...standIn, amount_total: "7500", payment_intent: "pi_1" };
    expect(fieldTypes(standIn, stripe).filter((row) => row.standIn !== row.stripe)).toEqual([
      { path: "amount_total", standIn: "number", stripe: "string" },
      { path: "payment_intent", standIn: "null", stripe: "string" },
    ]);
  });

  test("reports drift inside an object by its dotted path", () => {
    const event = { data: { object: { amount_total: 7500 } } };
    const stripe = { data: { object: { amount_total: null } } };
    expect(fieldTypes(event, stripe).filter((row) => row.standIn !== row.stripe)).toEqual([
      { path: "data.object.amount_total", standIn: "number", stripe: "null" },
    ]);
  });

  test("ignores fields only Stripe sends", () => {
    const stripe = { ...standIn, customer_details: { email: "a@example.com" }, ui_mode: "hosted" };
    expect(fieldTypes(standIn, stripe).map((row) => row.path)).not.toContain("ui_mode");
    expect(fieldTypes(standIn, stripe).map((row) => row.path)).not.toContain("customer_details");
  });

  test("reports an object Stripe sends as null or a list, without reading into it", () => {
    for (const metadata of [null, []]) {
      const rows = fieldTypes(standIn, { ...standIn, metadata });
      expect(rows.filter((row) => row.standIn !== row.stripe)).toEqual([
        { path: "metadata", standIn: "object", stripe: metadata === null ? "null" : "array" },
      ]);
    }
    expect(() => fieldTypes(standIn, null)).not.toThrow();
  });
});

describe("reading the listen log", () => {
  const ours = {
    id: "evt_ours",
    type: "checkout.session.completed",
    data: { object: { id: "cs_ours" } },
  };
  const theirs = {
    id: "evt_theirs",
    type: "checkout.session.completed",
    data: { object: { id: "cs_theirs" } },
  };
  const log = [
    "Ready! Your webhook signing secret is whsec_[redacted] (^C to quit)",
    JSON.stringify(theirs),
    "{ not json",
    `\u001b[2m${JSON.stringify(ours)}\u001b[0m`,
    "2026-11-18 04:41:02  <--  [500] POST http://127.0.0.1:8787/api/stripe/webhook [evt_theirs]",
    "2026-11-18 04:41:03  <--  [200] POST http://127.0.0.1:8787/api/stripe/webhook [evt_ours]",
  ].join("\n");

  test("forwardedEvent finds the completed event for the session, past other lines", () => {
    expect(forwardedEvent(log, "cs_ours")).toEqual(ours);
    expect(forwardedEvent(log, "cs_missing")).toBeNull();
  });

  test("webhookAnswer reads the answer to that event and no other", () => {
    expect(webhookAnswer(log, "evt_ours")).toEqual({
      status: 200,
      url: "http://127.0.0.1:8787/api/stripe/webhook",
    });
    expect(webhookAnswer(log, "evt_theirs")?.status).toBe(500);
    expect(webhookAnswer(log, "evt_missing")).toBeNull();
  });
});

describe("guards", () => {
  // The flow reads Stripe's objects in the version cire-api asks for; any other
  // version can answer a different shape, and the drift check would compare
  // the stand-in with something cire-api never sees.
  test("the flow's Stripe-Version is the one cire-api pins", () => {
    const source = readFileSync(join(REPO_ROOT, "cire/api/src/services/stripe.ts"), "utf8");
    const pinned = /export const STRIPE_API_VERSION = "([^"]+)"/.exec(source)?.[1];
    expect(pinned).toBeDefined();
    expect(STRIPE_TEST_API_VERSION).toBe(pinned ?? "");
  });

  // `config.ts` reads the clock's start when it is first loaded. The test-mode
  // entry sets that start and only then loads it, which holds only while
  // nothing it loads up front reaches `config.ts`.
  test("the test-mode entry and its helpers load nothing that reaches config.ts before the clock is set", () => {
    const imports = (file: string) =>
      [
        ...readFileSync(join(import.meta.dirname, "..", "src", file), "utf8").matchAll(
          /^import (?!type )[^;]*?from "([^"]+)";/gms,
        ),
      ].map((match) => match[1] ?? "");
    expect(imports("stripe-test-mode.ts").filter((spec) => !spec.startsWith("node:"))).toEqual([]);
    expect(
      imports("stripe-test-mode-launcher.ts").filter((spec) => !spec.startsWith("node:")),
    ).toEqual(["./stripe-test-mode"]);
  });
});
