// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GiftMoneyPanel, giftMoneyMessage } from "./GiftMoneyPanel";

/**
 * The "give money" panel.
 *
 * What is load-bearing here:
 *   - it takes no card details and never could — the button hands the guest to
 *     Stripe's own page, and that is the only navigation it performs;
 *   - the amount is typed in MAJOR units and converted once, with the
 *     currency's real exponent: a fixed ×100 is wrong by 100× in yen;
 *   - an amount the server would refuse cannot be submitted at all;
 *   - every refusal says something the guest can act on, and the one they CAN
 *     fix — a lapsed session — hands them the way back.
 */

const API = "https://api.test";
const SLUG = "anita-and-ben";
const INVITE_HREF = `/${SLUG}`;

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function stubFetch(response: Response) {
  const calls: { url: string; body: unknown }[] = [];
  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      body: init?.body === undefined ? null : JSON.parse(String(init.body)),
    });
    return response.clone();
  });
  globalThis.fetch = mock as unknown as typeof fetch;
  return { mock, calls };
}

function renderPanel(props: Partial<Parameters<typeof GiftMoneyPanel>[0]> = {}) {
  return render(() => (
    <GiftMoneyPanel apiUrl={API} slug={SLUG} currency="AUD" inviteHref={INVITE_HREF} {...props} />
  ));
}

const realFetch = globalThis.fetch;

afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

/**
 * The component's one navigation, as a stub. Passed in rather than patched onto
 * `window.location`: replacing that object breaks every later navigation in the
 * file, and the seam exists precisely so a test never has to.
 */
function captureNavigation() {
  return vi.fn();
}

describe("the hand-off", () => {
  it("sends the guest to Stripe's page, and never asks for a card itself", async () => {
    const assign = captureNavigation();
    const { calls } = stubFetch(json({ url: "https://checkout.stripe.com/c/pay/cs_1" }));
    const { container } = renderPanel({ navigate: assign });

    // No card field exists on this page, in any state.
    expect(container.querySelector('input[autocomplete*="cc-"]')).toBeNull();
    expect(container.textContent).not.toMatch(/card number|cvc|expiry/i);

    fireEvent.submit(container.querySelector("form") as HTMLFormElement);

    await waitFor(() =>
      expect(assign).toHaveBeenCalledWith("https://checkout.stripe.com/c/pay/cs_1"),
    );
    expect(calls[0]?.url).toBe(`${API}/api/invite/${SLUG}/registry/contribute`);
  });

  it("gives the first preset unless the guest picks another", async () => {
    const { calls } = stubFetch(json({ url: "https://checkout.stripe.com/c/pay/cs_1" }));
    const { container } = renderPanel({ navigate: captureNavigation() });

    fireEvent.submit(container.querySelector("form") as HTMLFormElement);

    await waitFor(() => expect(calls).toHaveLength(1));
    expect((calls[0]?.body as { amountMinor: number } | undefined)?.amountMinor).toBe(5000);
  });

  it("sends the note and name as null when the guest wrote none", async () => {
    const { calls } = stubFetch(json({ url: "https://checkout.stripe.com/c/pay/cs_1" }));
    const { container } = renderPanel({ navigate: captureNavigation() });

    fireEvent.submit(container.querySelector("form") as HTMLFormElement);

    await waitFor(() => expect(calls).toHaveLength(1));
    const body = calls[0]?.body as
      | { message: string | null; displayName: string | null }
      | undefined;
    // Empty means "I said nothing", which is null on the wire, not "".
    expect(body?.message).toBeNull();
    expect(body?.displayName).toBeNull();
  });

  /**
   * A full-page navigation out of a payment flow, to a string the server
   * chose. One bad response body — a compromised or misconfigured API origin, a
   * future proxy — would otherwise make "Continue to payment" an open redirect.
   */
  it("refuses to send the guest anywhere but Stripe's own checkout", async () => {
    const assign = captureNavigation();
    stubFetch(json({ url: "https://checkout.stripe.com.evil.test/pay/cs_1" }));
    const { container } = renderPanel({ navigate: assign });

    fireEvent.submit(container.querySelector("form") as HTMLFormElement);

    await screen.findByText(/Could not reach the payment page/);
    expect(assign).not.toHaveBeenCalled();
  });

  it("says so, and stays put, when a 200 carries no URL", async () => {
    const assign = captureNavigation();
    stubFetch(json({}));
    const { container } = renderPanel({ navigate: assign });

    fireEvent.submit(container.querySelector("form") as HTMLFormElement);

    await screen.findByText(/Could not reach the payment page/);
    // Sending a guest nowhere is worse than telling them it did not work.
    expect(assign).not.toHaveBeenCalled();
  });
});

describe("the amount a guest types", () => {
  it("is converted with the currency's own exponent", async () => {
    const { calls } = stubFetch(json({ url: "https://checkout.stripe.com/c/pay/cs_1" }));
    const { container } = renderPanel({ currency: "JPY", navigate: captureNavigation() });

    fireEvent.click(screen.getByText("Another amount"));
    const input = container.querySelector("[data-gift-money-amount]") as HTMLInputElement;
    fireEvent.input(input, { target: { value: "5000" } });
    fireEvent.submit(container.querySelector("form") as HTMLFormElement);

    await waitFor(() => expect(calls).toHaveLength(1));
    // Yen has no minor unit: ¥5000 is 5000 minor units, not 500 000.
    expect((calls[0]?.body as { amountMinor: number } | undefined)?.amountMinor).toBe(5000);
  });

  it("cannot be submitted at all when the server would refuse it", async () => {
    const { calls } = stubFetch(json({ url: "https://checkout.stripe.com/c/pay/cs_1" }));
    const { container } = renderPanel({ navigate: captureNavigation() });

    fireEvent.click(screen.getByText("Another amount"));
    const input = container.querySelector("[data-gift-money-amount]") as HTMLInputElement;
    const button = screen.getByRole("button", { name: "Continue to payment" }) as HTMLButtonElement;

    for (const value of ["", "0", "-20", "1", "999999999", "abc"]) {
      fireEvent.input(input, { target: { value } });
      expect(button.disabled).toBe(true);
    }
    fireEvent.input(input, { target: { value: "75" } });
    expect(button.disabled).toBe(false);

    fireEvent.submit(container.querySelector("form") as HTMLFormElement);
    await waitFor(() => expect(calls).toHaveLength(1));
    expect((calls[0]?.body as { amountMinor: number } | undefined)?.amountMinor).toBe(7500);
  });
});

describe("when it does not work", () => {
  it("says the couple are not taking money, without blaming the guest", async () => {
    stubFetch(json({ error: "cash_gifts_unavailable" }, 409));
    const { container } = renderPanel();
    fireEvent.submit(container.querySelector("form") as HTMLFormElement);
    const said = await screen.findByText("The couple aren’t taking money gifts at the moment.");
    expect(said).toBeTruthy();
  });

  it("hands back the way in when the session has lapsed", async () => {
    stubFetch(json({ error: "Unauthorized" }, 401));
    const { container } = renderPanel();
    fireEvent.submit(container.querySelector("form") as HTMLFormElement);

    await screen.findByText(/Your invite session has ended/);
    expect(screen.getByRole("link", { name: "Open the invitation" }).getAttribute("href")).toBe(
      INVITE_HREF,
    );
  });

  it("names a wait only when the server named one", () => {
    expect(giftMoneyMessage({ kind: "rate-limited", retryAfterSeconds: 30 })).toContain(
      "30 seconds",
    );
    expect(giftMoneyMessage({ kind: "rate-limited", retryAfterSeconds: null })).toContain(
      "a moment",
    );
  });

  it("has its own words for every outcome, and blames the guest for none of them", () => {
    const messages = [
      giftMoneyMessage({ kind: "unavailable" }),
      giftMoneyMessage({ kind: "signed-out" }),
      giftMoneyMessage({ kind: "invalid" }),
      giftMoneyMessage({ kind: "error" }),
    ];
    expect(new Set(messages).size).toBe(messages.length);
    for (const message of messages) expect(message).not.toMatch(/you (failed|entered|did)/i);
  });

  it("re-enables the button so a guest can try again", async () => {
    stubFetch(json({}, 500));
    const { container } = renderPanel();
    const button = screen.getByRole("button", { name: "Continue to payment" }) as HTMLButtonElement;

    fireEvent.submit(container.querySelector("form") as HTMLFormElement);

    await screen.findByText(/Could not reach the payment page/);
    expect(button.disabled).toBe(false);
  });
});

describe("what the panel promises", () => {
  it("says where the guest is going and who reads what they wrote", () => {
    const { container } = renderPanel();
    const text = container.textContent ?? "";
    // Said before they press, not after.
    expect(text).toContain("Stripe");
    expect(text).toMatch(/never to the other guests/i);
  });
});
