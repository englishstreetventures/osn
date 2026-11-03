import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { verifyStripeWebhook, WEBHOOK_TOLERANCE_SECONDS } from "../../src/stripe/verify";
import { hmacHex } from "../support/stripe";

const SECRET = "whsec_test_secret";
const now = 1_800_000_000;
const body = JSON.stringify({ id: "evt_1", type: "invoice.paid" });

async function signedHeader(at = now, secret = SECRET): Promise<string> {
  return `t=${at},v1=${await hmacHex(secret, `${at}.${body}`)}`;
}

const reasonOf = async (input: Parameters<typeof verifyStripeWebhook>[0]) =>
  (await Effect.runPromise(Effect.flip(verifyStripeWebhook(input)))).reason;

describe("verifyStripeWebhook", () => {
  it("accepts a delivery Stripe signed, and returns the parsed body", async () => {
    const event = await Effect.runPromise(
      verifyStripeWebhook({
        payload: body,
        signatureHeader: await signedHeader(),
        secret: SECRET,
        now,
      }),
    );
    expect(event).toEqual({ id: "evt_1", type: "invoice.paid" });
  });

  it("accepts a delivery signed with any of several rotating secrets", async () => {
    const header = `t=${now},v1=${await hmacHex("whsec_old", `${now}.${body}`)},v1=${await hmacHex(
      SECRET,
      `${now}.${body}`,
    )}`;
    expect(
      await Effect.runPromise(
        verifyStripeWebhook({ payload: body, signatureHeader: header, secret: SECRET, now }),
      ),
    ).toEqual({ id: "evt_1", type: "invoice.paid" });
  });

  it("refuses a body changed after signing, and a signature made with another secret", async () => {
    const header = await signedHeader();
    expect(
      await reasonOf({ payload: `${body} `, signatureHeader: header, secret: SECRET, now }),
    ).toBe("no-match");
    expect(
      await reasonOf({
        payload: body,
        signatureHeader: await signedHeader(now, "whsec_other"),
        secret: SECRET,
        now,
      }),
    ).toBe("no-match");
  });

  it("refuses a delivery outside the tolerance either side, and accepts one on its edge", async () => {
    for (const at of [now - WEBHOOK_TOLERANCE_SECONDS - 1, now + WEBHOOK_TOLERANCE_SECONDS + 1]) {
      expect(
        await reasonOf({
          payload: body,
          signatureHeader: await signedHeader(at),
          secret: SECRET,
          now,
        }),
      ).toBe("too-old");
    }
    await Effect.runPromise(
      verifyStripeWebhook({
        payload: body,
        signatureHeader: await signedHeader(now - WEBHOOK_TOLERANCE_SECONDS),
        secret: SECRET,
        now,
      }),
    );
  });

  it("refuses a missing header, and one without the parts the check needs", async () => {
    for (const header of [null, "", "t=123", `v1=${"0".repeat(64)}`, "nonsense"]) {
      expect(await reasonOf({ payload: body, signatureHeader: header, secret: SECRET, now })).toBe(
        "malformed",
      );
    }
  });

  it("refuses everything when no signing secret is configured", async () => {
    expect(
      await reasonOf({ payload: body, signatureHeader: await signedHeader(), secret: null, now }),
    ).toBe("unconfigured");
  });
});
