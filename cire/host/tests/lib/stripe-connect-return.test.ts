import { describe, expect, it } from "vitest";

import {
  clearStripeConnectParam,
  readStripeConnectReturn,
  stripeConnectWords,
} from "../../src/lib/stripe-connect-return";

/**
 * Coming back from connecting a Stripe account. cire-api's callback did the
 * work and sends the browser here with one word, `stripe_connect`, saying how
 * it ended. Nothing in it grants anything: the panel reads the settings as
 * stored. The word must still be stripped, because the dashboard carries the
 * search through every later hash write and the login bounce.
 */
describe("readStripeConnectReturn", () => {
  it("reads the outcome and nothing else", () => {
    expect(readStripeConnectReturn("?stripe_connect=connected")).toBe("connected");
    expect(readStripeConnectReturn("?x=1&stripe_connect=expired")).toBe("expired");
    expect(readStripeConnectReturn("?code=ac_1&state=wed.x")).toBeNull();
    expect(readStripeConnectReturn("")).toBeNull();
  });

  it("keeps an outcome it has no words for, so it can still say something", () => {
    expect(readStripeConnectReturn("?stripe_connect=something_new")).toBe("something_new");
    expect(readStripeConnectReturn("?stripe_connect=")).toBeNull();
  });
});

describe("clearStripeConnectParam", () => {
  it("strips the word and keeps the route and every other param", () => {
    const url = new URL(
      "https://host.test/?a=1&stripe_connect=connected#/w/wed_1/registry/settings",
    );
    expect(clearStripeConnectParam(url)).toBe("/?a=1#/w/wed_1/registry/settings");
  });
});

describe("stripeConnectWords", () => {
  it("is good news only for a connection", () => {
    expect(stripeConnectWords("connected").ok).toBe(true);
    for (const outcome of [
      "denied",
      "expired",
      "signed_out",
      "forbidden",
      "already_connected",
      "rejected",
      "unavailable",
      "currency_mismatch",
      "owners_differ",
      "something_new",
    ]) {
      const words = stripeConnectWords(outcome);
      expect(words.ok).toBe(false);
      expect(words.text.length).toBeGreaterThan(0);
    }
  });

  it("says each outcome in its own words", () => {
    const phrases: Record<string, RegExp> = {
      connected: /is connected/,
      denied: /didn’t connect/,
      expired: /run out or was already used/,
      signed_out: /signed out/,
      forbidden: /Only the wedding’s owner/,
      already_connected: /already has a Stripe account/,
      rejected: /didn’t accept/,
      currency_mismatch: /different currency/,
      owners_differ: /different owners/,
      unavailable: /Couldn’t finish connecting/,
    };
    for (const [outcome, phrase] of Object.entries(phrases)) {
      expect(stripeConnectWords(outcome).text).toMatch(phrase);
    }
    const texts = Object.keys(phrases).map((outcome) => stripeConnectWords(outcome).text);
    expect(new Set(texts).size).toBe(texts.length);
  });

  it("says something for an outcome this build does not know", () => {
    expect(stripeConnectWords("something_new").text).toMatch(/Stripe account wasn’t connected/);
  });
});
