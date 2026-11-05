// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import RegistrySettingsView from "../../src/components/RegistrySettingsView";
import {
  __resetRegistryCache,
  dropRegistry,
  peekCachedRegistry,
  type RegistryItem,
  type RegistrySnapshot,
  setCachedRegistry,
} from "../../src/lib/registry-store";

/**
 * The registry's settings panel.
 *
 * What is load-bearing here:
 *   - publishing is blocked while the list is empty, and the panel says why —
 *     including that money gifts need a published list too;
 *   - the one owner-only control is visible to an editor, disabled, with the
 *     reason. A co-host who wonders why money gifts are off gets an answer;
 *   - once an account is connected, only the owner who connected it is offered
 *     its onboarding link; every other owner sees its status, and can still
 *     ask Stripe for it;
 *   - "let guests give money" cannot be turned on until Stripe can actually
 *     take a charge, and the 409 that means the account changed under the page
 *     says the true thing rather than "check the fields";
 *   - empty copy is sent as `null`, never `""` — the guest surface reads null as
 *     "use the built-in default" and an empty string would beat it;
 *   - the live Stripe read happens for a couple MID-ONBOARDING and nobody else.
 */

const authFetch = vi.fn();
/** The signed-in profile; `null` while the session is still loading. */
const ME = "usr_me";
const activeProfileId = vi.fn<() => string | null>(() => ME);
vi.mock("@shared/rp-auth/solid", () => ({ useAuth: () => ({ authFetch, activeProfileId }) }));

const { haptic } = vi.hoisted(() => ({ haptic: vi.fn() }));
vi.mock("../../src/lib/touch-feedback", () => ({ haptic }));

// Only `redirectToLogin` is replaced — it assigns `window.location.href`, which
// happy-dom cannot follow. `apiUrl` and `isAuthExpired` stay real.
const redirectToLogin = vi.hoisted(() => vi.fn());
vi.mock("../../src/lib/api", async () => ({
  ...(await vi.importActual<typeof import("../../src/lib/api")>("../../src/lib/api")),
  redirectToLogin,
}));

const toastError = vi.fn();
const toastSuccess = vi.fn();
vi.mock("@shared/toast", () => ({
  toast: { error: (m: string) => toastError(m), success: (m: string) => toastSuccess(m) },
}));

const item = (over: Partial<RegistryItem> = {}): RegistryItem =>
  ({
    id: "itm_1",
    weddingId: "wed_1",
    kind: "product",
    title: "Copper pan",
    description: null,
    imageKey: null,
    imageCrop: null,
    externalUrl: null,
    priceMinor: null,
    quantityWanted: 1,
    quantityClaimed: 0,
    allowPartial: false,
    targetMinor: null,
    category: null,
    sortOrder: 0,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  }) as RegistryItem;

const snapshot = (over: Partial<RegistrySnapshot> = {}): RegistrySnapshot =>
  ({
    settings: {
      weddingId: "wed_1",
      published: false,
      headline: null,
      message: null,
      cashGiftsEnabled: false,
      shippingAddress: null,
      shippingVisibleFrom: null,
      stripeConnected: false,
      stripeChargesEnabled: false,
      stripeConnectedByOsnProfileId: null,
      // What the server says for no Stripe account. A test that renders a
      // money state sets the reason the server would send for it.
      moneyGiftsBlockedBy: "stripe_not_ready",
      updatedAt: null,
      ...over.settings,
    },
    items: over.items ?? [],
    gifts: [],
    giftsHasMore: false,
    giftSummary: null,
    currency: "AUD",
    contributionsPrimaryMinor: 0,
    contributionsOtherCurrencyCount: 0,
    takesPayments: over.takesPayments ?? true,
  }) as RegistrySnapshot;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function renderPanel(props: { canEdit?: boolean; canManage?: boolean } = {}) {
  return render(() => (
    <RegistrySettingsView
      weddingId="wed_1"
      canEdit={props.canEdit ?? true}
      canManage={props.canManage ?? true}
    />
  ));
}

/** The last body `authFetch` was given, parsed. */
function lastBody(): Record<string, unknown> {
  const call = authFetch.mock.calls.at(-1);
  return JSON.parse(String((call?.[1] as RequestInit | undefined)?.body ?? "{}")) as Record<
    string,
    unknown
  >;
}

/**
 * A press of "Connect an account" on a wedding with no account asks first for
 * the owner's accounts on other weddings. This answers that with none, and
 * every other call with `answer`, a fresh response each time.
 */
function noOtherAccounts(answer: () => Response): void {
  authFetch.mockImplementation(async (url: string) =>
    String(url).includes("/registry/stripe/accounts") ? json({ accounts: [] }) : answer(),
  );
}

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  __resetRegistryCache();
  authFetch.mockReset();
  activeProfileId.mockReset();
  activeProfileId.mockImplementation(() => ME);
  toastError.mockReset();
  toastSuccess.mockReset();
  haptic.mockReset();
  redirectToLogin.mockReset();
});

describe("publishing", () => {
  it("opens on a first visit, before anything is cached", async () => {
    // The settings tab can be the first registry view a session opens: its
    // publish gate runs before the registry read has answered.
    authFetch.mockResolvedValueOnce(json(snapshot({ items: [item()] })));
    renderPanel();
    const publish = (await screen.findByRole("radio", { name: /^Published/ })) as HTMLInputElement;
    expect(publish.disabled).toBe(false);
  });

  it("is blocked while the list is empty, and says why", async () => {
    setCachedRegistry("wed_1", snapshot());
    renderPanel();

    const publish = (await screen.findByRole("radio", { name: /^Published/ })) as HTMLInputElement;
    expect(publish.disabled).toBe(true);
    // The consequence a couple needs to know: money gifts live on the published
    // page too, so this is not only about the gift list.
    expect(screen.getByText(/money-gift option/i)).toBeTruthy();
    // And it is announced on entering the group rather than left as loose text
    // beside a control the keyboard skips. The radio group carries the name
    // and the reason once: the fieldset round it, there to disable every
    // control at once, is no second group named "Visibility".
    const group = screen.getByRole("radiogroup", { name: "Visibility" });
    expect(group.contains(publish)).toBe(true);
    expect(group.getAttribute("aria-describedby")).toBe("registry-publish-blocked");
    expect(screen.queryByRole("group", { name: "Visibility" })).toBeNull();
    expect(group.hasAttribute("aria-label")).toBe(false);
    expect(document.getElementById("registry-publish-blocked")?.textContent).toMatch(
      /Add a gift before publishing/i,
    );
    // No fund, so nothing to say about funds.
    expect(document.getElementById("registry-publish-blocked")?.textContent).not.toMatch(
      /cash funds|group gifts/i,
    );
  });

  it("locks the visibility for someone who can read the settings but not change them", async () => {
    setCachedRegistry("wed_1", snapshot({ items: [item()] }));
    renderPanel({ canEdit: false });
    const draft = (await screen.findByRole("radio", { name: /^Draft/ })) as HTMLInputElement;
    // The fieldset round the group disables both radios at once (the DOM
    // here does not cascade it to `:disabled`; a browser does).
    expect(draft.closest("fieldset")?.disabled).toBe(true);
    expect(screen.getByRole("radio", { name: /^Published/ }).closest("fieldset")).toBe(
      draft.closest("fieldset"),
    );
  });

  it("shows the list's visibility and lets Published be chosen", async () => {
    setCachedRegistry("wed_1", snapshot({ items: [item()] }));
    renderPanel();
    const draft = (await screen.findByRole("radio", { name: /^Draft/ })) as HTMLInputElement;
    const publish = screen.getByRole("radio", { name: /^Published/ }) as HTMLInputElement;
    expect([draft.checked, publish.checked]).toEqual([true, false]);
    fireEvent.click(publish);
    expect([draft.checked, publish.checked]).toEqual([false, true]);
    fireEvent.click(draft);
    expect([draft.checked, publish.checked]).toEqual([true, false]);
  });

  it("is allowed once there is a gift", async () => {
    setCachedRegistry("wed_1", snapshot({ items: [item()] }));
    renderPanel();

    const publish = (await screen.findByRole("radio", { name: /^Published/ })) as HTMLInputElement;
    expect(publish.disabled).toBe(false);
    expect(screen.queryByText(/Add a gift before publishing/i)).toBeNull();
    // The description goes with the notice — a dangling id describes nothing.
    expect(publish.closest("fieldset")?.getAttribute("aria-describedby")).toBeNull();
  });

  it("counts a cash fund only while guests can give to it", async () => {
    // Guests see a fund only while the server says they can give money. A list
    // of funds alone, otherwise, would publish a page with nothing on it.
    const funds = [item({ kind: "cash_fund", title: "Honeymoon", targetMinor: 500_000 })];
    setCachedRegistry(
      "wed_1",
      snapshot({
        items: funds,
        settings: {
          stripeConnected: true,
          stripeChargesEnabled: true,
          moneyGiftsBlockedBy: "cash_gifts_off",
        } as never,
      }),
    );
    const { unmount } = renderPanel();
    const blocked = (await screen.findByRole("radio", { name: /^Published/ })) as HTMLInputElement;
    expect(blocked.disabled).toBe(true);
    expect(document.getElementById("registry-publish-blocked")?.textContent).toMatch(
      /cash funds and group gifts count once money gifts are on\.$/i,
    );
    unmount();

    setCachedRegistry(
      "wed_1",
      snapshot({
        items: funds,
        settings: {
          cashGiftsEnabled: true,
          stripeConnected: true,
          stripeChargesEnabled: true,
          moneyGiftsBlockedBy: null,
        } as never,
      }),
    );
    const { unmount: unmountOpen } = renderPanel();
    const open = (await screen.findByRole("radio", { name: /^Published/ })) as HTMLInputElement;
    expect(open.disabled).toBe(false);
    expect(document.getElementById("registry-publish-blocked")).toBeNull();
    unmountOpen();

    // Half on is off: Stripe charging with the switch off, or the switch on
    // with Stripe not charging — each with the reason the server sends.
    for (const [half, tail] of [
      [
        {
          cashGiftsEnabled: false,
          stripeConnected: true,
          stripeChargesEnabled: true,
          moneyGiftsBlockedBy: "cash_gifts_off",
        },
        /cash funds and group gifts count once money gifts are on\.$/i,
      ],
      [
        {
          cashGiftsEnabled: true,
          stripeConnected: true,
          stripeChargesEnabled: false,
          moneyGiftsBlockedBy: "stripe_not_ready",
        },
        /cash funds and group gifts count once Stripe can take payments for you and money gifts are on\.$/i,
      ],
    ] as const) {
      setCachedRegistry("wed_1", snapshot({ items: funds, settings: half as never }));
      const { unmount: unmountHalf } = renderPanel();
      const halfOn = (await screen.findByRole("radio", { name: /^Published/ })) as HTMLInputElement;
      expect(halfOn.disabled).toBe(true);
      expect(document.getElementById("registry-publish-blocked")?.textContent).toMatch(tail);
      unmountHalf();
    }
  });

  /** A list of one fund, with the server's reason for guests not giving money. */
  const fundsOnly = (moneyGiftsBlockedBy: unknown, currency = "AUD"): RegistrySnapshot => ({
    ...snapshot({
      items: [item({ kind: "cash_fund", title: "Honeymoon", targetMinor: 500_000 })],
      settings: {
        cashGiftsEnabled: true,
        stripeConnected: true,
        stripeChargesEnabled: true,
        moneyGiftsBlockedBy,
      } as never,
    }),
    currency,
  });
  const publishNotice = () => document.getElementById("registry-publish-blocked")?.textContent;

  it("counts no fund while the account pays out in another currency, and says so", async () => {
    // Money on, Stripe charging, the site taking payments: only the currency
    // stands between the couple and a list guests can see.
    setCachedRegistry("wed_1", fundsOnly("currency_mismatch", "NZD"));
    const { unmount } = renderPanel();
    const blocked = (await screen.findByRole("radio", { name: /^Published/ })) as HTMLInputElement;
    expect(blocked.disabled).toBe(true);
    expect(publishNotice()).toMatch(
      /cash funds and group gifts don’t count: your Stripe account pays out in a currency other than NZD\.$/i,
    );
    expect(publishNotice()).not.toMatch(/once money gifts are on/i);
    expect(screen.getByTestId("money-gifts-currency").textContent).toMatch(
      /guests aren’t offered money gifts, cash funds or group gifts: your Stripe account pays out in a currency other than NZD, the one every gift is charged in/i,
    );
    unmount();

    // The same snapshot with the currencies agreeing: publishable, and quiet.
    setCachedRegistry("wed_1", fundsOnly(null, "NZD"));
    renderPanel();
    const open = (await screen.findByRole("radio", { name: /^Published/ })) as HTMLInputElement;
    expect(open.disabled).toBe(false);
    expect(publishNotice()).toBeUndefined();
    expect(screen.queryByTestId("money-gifts-currency")).toBeNull();
  });

  it("counts no fund until Stripe names the currency, and tells each role what to do", async () => {
    setCachedRegistry("wed_1", fundsOnly("stripe_currency_unknown"));
    authFetch.mockResolvedValue(
      json({
        connected: true,
        chargesEnabled: true,
        payoutsEnabled: true,
        moneyGiftsBlockedBy: "stripe_currency_unknown",
      }),
    );
    const owner = renderPanel({ canManage: true });
    expect(
      ((await screen.findByRole("radio", { name: /^Published/ })) as HTMLInputElement).disabled,
    ).toBe(true);
    expect(publishNotice()).toMatch(
      /cash funds and group gifts don’t count until Stripe says which currency your account pays out in\.$/i,
    );
    expect(screen.getByTestId("money-gifts-currency").textContent).toMatch(
      /Guests aren’t offered money gifts, cash funds or group gifts until Stripe says which currency your account pays out in\. Check again to ask it\.$/,
    );
    owner.unmount();

    __resetRegistryCache();
    setCachedRegistry("wed_1", fundsOnly("stripe_currency_unknown"));
    renderPanel({ canManage: false });
    await screen.findByRole("radio", { name: /^Published/ });
    expect(screen.getByTestId("money-gifts-currency").textContent).toMatch(
      /Ask an owner to check the Stripe connection\.$/,
    );
  });

  it("names Stripe, not the switch, when the switch is on and Stripe cannot charge", async () => {
    setCachedRegistry(
      "wed_1",
      snapshot({
        items: [item({ kind: "cash_fund", title: "Honeymoon", targetMinor: 500_000 })],
        settings: {
          cashGiftsEnabled: true,
          stripeConnected: true,
          stripeChargesEnabled: false,
          moneyGiftsBlockedBy: "stripe_not_ready",
        } as never,
      }),
    );
    authFetch.mockResolvedValue(
      json({
        connected: true,
        chargesEnabled: false,
        payoutsEnabled: false,
        moneyGiftsBlockedBy: "stripe_not_ready",
      }),
    );
    renderPanel();
    await screen.findByRole("radio", { name: /^Published/ });
    expect(publishNotice()).toMatch(
      /once Stripe can take payments for you and money gifts are on/i,
    );
    expect(screen.queryByTestId("money-gifts-currency")).toBeNull();
  });

  it("counts no fund for a reason it has no words for", async () => {
    // A reason a newer API sends, or none from one that predates the field.
    for (const reason of ["something_new", undefined]) {
      __resetRegistryCache();
      setCachedRegistry("wed_1", fundsOnly(reason));
      const view = renderPanel();
      const publish = (await screen.findByRole("radio", {
        name: /^Published/,
      })) as HTMLInputElement;
      expect(publish.disabled).toBe(true);
      expect(publishNotice()).toMatch(
        /cash funds and group gifts don’t count while guests can’t see them\.$/i,
      );
      view.unmount();
    }
  });

  it("counts no cash fund where this site cannot take a money gift", async () => {
    // The couple's side is ready, but the deployment is not: guests are offered
    // no money and no fund, so a list of funds alone is still an empty page.
    const funds = [item({ kind: "cash_fund", title: "Honeymoon", targetMinor: 500_000 })];
    setCachedRegistry(
      "wed_1",
      snapshot({
        items: funds,
        takesPayments: false,
        settings: {
          cashGiftsEnabled: true,
          stripeConnected: true,
          stripeChargesEnabled: true,
          moneyGiftsBlockedBy: "payments_unavailable",
        } as never,
      }),
    );
    renderPanel();

    const publish = (await screen.findByRole("radio", { name: /^Published/ })) as HTMLInputElement;
    expect(publish.disabled).toBe(true);
    const notice = document.getElementById("registry-publish-blocked")?.textContent ?? "";
    expect(notice).toMatch(
      /cash funds and group gifts don’t count: money gifts aren’t available on this site yet\.$/i,
    );
    // Turning money gifts on would change nothing, so the notice does not say to.
    expect(notice).not.toMatch(/once money gifts are on/i);
  });

  it("never traps a couple whose published list lost its last gift", async () => {
    // Publishing is blocked, but an ALREADY published list must stay
    // switchable — otherwise deleting the last gift would freeze the radio
    // group on "Published" with no way back to draft.
    setCachedRegistry("wed_1", snapshot({ settings: { published: true } as never }));
    renderPanel();

    const publish = (await screen.findByRole("radio", { name: /^Published/ })) as HTMLInputElement;
    expect(publish.disabled).toBe(false);
    expect(publish.checked).toBe(true);
  });
});

describe("what gets saved", () => {
  it("sends cleared copy as null, not as an empty string", async () => {
    setCachedRegistry(
      "wed_1",
      snapshot({
        items: [item()],
        settings: {
          headline: "Our list",
          message: "No boxes",
          shippingAddress: "1 Example St",
          shippingVisibleFrom: "2026-12-01",
        } as never,
      }),
    );
    authFetch.mockResolvedValue(json({ settings: snapshot().settings }));
    const { container } = renderPanel();

    await screen.findByRole("radio", { name: /^Published/ });
    for (const label of [/Heading/i, /A note above the list/i, /^Address/i]) {
      fireEvent.input(screen.getByLabelText(label), { target: { value: "   " } });
    }
    fireEvent.input(screen.getByLabelText(/Hide the address until/i), { target: { value: "" } });
    fireEvent.submit(container.querySelector("form") as HTMLFormElement);

    await waitFor(() => expect(authFetch).toHaveBeenCalled());
    const body = lastBody();
    // The guest surface reads null as "use the built-in default"; "" would win
    // over it and render an empty heading.
    expect(body.headline).toBeNull();
    expect(body.message).toBeNull();
    expect(body.shippingAddress).toBeNull();
    expect(body.shippingVisibleFrom).toBeNull();
  });

  it("sends only what was changed, with what it was before", async () => {
    // A co-host's tab: published, with an address. They change the heading
    // and nothing else — so publishing and the address must not be re-sent,
    // or a tab opened an hour ago could put back what someone else withdrew.
    setCachedRegistry(
      "wed_1",
      snapshot({
        items: [item()],
        settings: { published: true, shippingAddress: "1 Example St" } as never,
      }),
    );
    authFetch.mockResolvedValue(json({ settings: snapshot().settings }));
    const { container } = renderPanel();

    await screen.findByRole("radio", { name: /^Published/ });
    fireEvent.input(screen.getByLabelText(/Heading/i), { target: { value: "Gifts" } });
    fireEvent.submit(container.querySelector("form") as HTMLFormElement);

    await waitFor(() => expect(authFetch).toHaveBeenCalled());
    expect(lastBody()).toEqual({ headline: "Gifts", expected: { headline: null } });
  });

  it("compares the next save with the row the last one returned", async () => {
    setCachedRegistry("wed_1", snapshot({ items: [item()] }));
    authFetch.mockResolvedValueOnce(
      json({ settings: { ...snapshot().settings, headline: "Gifts" } }),
    );
    const { container } = renderPanel();

    await screen.findByRole("radio", { name: /^Published/ });
    fireEvent.input(screen.getByLabelText(/Heading/i), { target: { value: "Gifts" } });
    fireEvent.submit(container.querySelector("form") as HTMLFormElement);
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledTimes(1));

    authFetch.mockResolvedValueOnce(
      json({ settings: { ...snapshot().settings, headline: "Gifts", message: "No boxes" } }),
    );
    fireEvent.input(screen.getByLabelText(/A note above the list/i), {
      target: { value: "No boxes" },
    });
    fireEvent.submit(container.querySelector("form") as HTMLFormElement);
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledTimes(2));
    // The heading was saved already: it is not sent again with a stale guess.
    expect(lastBody()).toEqual({ message: "No boxes", expected: { message: null } });
  });

  it("counts typing a field back to what it was as no change", async () => {
    setCachedRegistry(
      "wed_1",
      snapshot({ items: [item()], settings: { headline: "Ours" } as never }),
    );
    authFetch.mockResolvedValue(json({ settings: snapshot().settings }));
    const { container } = renderPanel();

    await screen.findByRole("radio", { name: /^Published/ });
    const heading = screen.getByLabelText(/Heading/i);
    fireEvent.input(heading, { target: { value: "Something else" } });
    fireEvent.input(heading, { target: { value: " Ours " } });
    fireEvent.submit(container.querySelector("form") as HTMLFormElement);

    await waitFor(() => expect(authFetch).toHaveBeenCalled());
    expect(lastBody()).toEqual({});
  });

  it("sends what the couple typed, trimmed", async () => {
    setCachedRegistry("wed_1", snapshot({ items: [item()] }));
    authFetch.mockResolvedValue(json({ settings: snapshot().settings }));
    const { container } = renderPanel();

    await screen.findByRole("radio", { name: /^Published/ });
    fireEvent.input(screen.getByLabelText(/Heading/i), { target: { value: "  Our list  " } });
    fireEvent.submit(container.querySelector("form") as HTMLFormElement);

    await waitFor(() => expect(authFetch).toHaveBeenCalled());
    expect(lastBody().headline).toBe("Our list");
  });

  it("patches the shared snapshot rather than re-fetching the whole registry", async () => {
    setCachedRegistry("wed_1", snapshot({ items: [item()] }));
    authFetch.mockResolvedValue(
      json({ settings: { ...snapshot().settings, headline: "Our list", published: true } }),
    );
    const { container } = renderPanel();

    await screen.findByRole("radio", { name: /^Published/ });
    fireEvent.submit(container.querySelector("form") as HTMLFormElement);

    await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
    const cached = peekCachedRegistry("wed_1");
    expect(cached?.settings.headline).toBe("Our list");
    // The list is untouched — switching back to the gift list costs no fetch.
    expect(cached?.items).toHaveLength(1);
  });
});

describe("a save that changes whether guests can give", () => {
  it("stops counting a fund once the save says money is off", async () => {
    const funds = [item({ kind: "cash_fund", title: "Honeymoon", targetMinor: 500_000 })];
    const open = {
      ...snapshot().settings,
      cashGiftsEnabled: true,
      stripeConnected: true,
      stripeChargesEnabled: true,
      moneyGiftsBlockedBy: null,
    };
    setCachedRegistry("wed_1", snapshot({ items: funds, settings: open as never }));
    authFetch.mockResolvedValue(
      json({
        settings: { ...open, cashGiftsEnabled: false, moneyGiftsBlockedBy: "cash_gifts_off" },
      }),
    );
    const { container } = renderPanel();
    expect(
      ((await screen.findByRole("radio", { name: /^Published/ })) as HTMLInputElement).disabled,
    ).toBe(false);

    fireEvent.click(screen.getByRole("checkbox", { name: "Let guests give money" }));
    fireEvent.submit(container.querySelector("form") as HTMLFormElement);

    await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
    expect((screen.getByRole("radio", { name: /^Published/ }) as HTMLInputElement).disabled).toBe(
      true,
    );
    expect(document.getElementById("registry-publish-blocked")?.textContent).toMatch(
      /cash funds and group gifts count once money gifts are on/i,
    );
  });
});

describe("when a co-host saved first", () => {
  it("says so, shows their change, keeps what was typed, and saves against the new row", async () => {
    setCachedRegistry(
      "wed_1",
      snapshot({
        items: [item()],
        settings: { published: true, shippingAddress: "1 Example St" } as never,
      }),
    );
    // Meanwhile a co-host unpublished and cleared the address.
    const theirs = {
      ...snapshot().settings,
      published: false,
      shippingAddress: null,
    };
    authFetch.mockResolvedValueOnce(json({ error: "settings_changed", settings: theirs }, 409));
    const { container } = renderPanel();

    await screen.findByRole("radio", { name: /^Published/ });
    fireEvent.input(screen.getByLabelText(/^Address/i), { target: { value: "2 Example St" } });
    fireEvent.input(screen.getByLabelText(/Heading/i), { target: { value: "Gifts" } });
    fireEvent.submit(container.querySelector("form") as HTMLFormElement);

    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(String(toastError.mock.calls[0]?.[0])).toMatch(/Someone else saved these settings/);
    // Their unpublish now shows, because this tab never touched it…
    expect((screen.getByRole("radio", { name: /^Published/ }) as HTMLInputElement).checked).toBe(
      false,
    );
    expect(peekCachedRegistry("wed_1")?.settings.published).toBe(false);
    // …and what this tab typed is still there, not wiped.
    expect((screen.getByLabelText(/^Address/i) as HTMLTextAreaElement).value).toBe("2 Example St");
    expect((screen.getByLabelText(/Heading/i) as HTMLInputElement).value).toBe("Gifts");

    // Saving again is made against the row as it now stands.
    authFetch.mockResolvedValueOnce(
      json({ settings: { ...theirs, shippingAddress: "2 Example St", headline: "Gifts" } }),
    );
    fireEvent.submit(container.querySelector("form") as HTMLFormElement);
    await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
    expect(lastBody()).toEqual({
      headline: "Gifts",
      shippingAddress: "2 Example St",
      expected: { headline: null, shippingAddress: null },
    });
  });
});

describe("money gifts", () => {
  it("cannot be switched on until Stripe can take a charge", async () => {
    setCachedRegistry(
      "wed_1",
      snapshot({
        items: [item()],
        settings: { stripeConnected: true, stripeChargesEnabled: false } as never,
      }),
    );
    authFetch.mockResolvedValue(
      json({ connected: true, chargesEnabled: false, payoutsEnabled: false }),
    );
    renderPanel();

    const toggle = (await screen.findByRole("checkbox", {
      name: "Let guests give money",
    })) as HTMLInputElement;
    expect(toggle.disabled).toBe(true);
    expect(screen.getByText(/Available once Stripe can take payments/i)).toBeTruthy();
  });

  it("is switchable once Stripe is ready", async () => {
    setCachedRegistry(
      "wed_1",
      snapshot({
        items: [item()],
        settings: { stripeConnected: true, stripeChargesEnabled: true } as never,
      }),
    );
    renderPanel();

    const toggle = (await screen.findByRole("checkbox", {
      name: "Let guests give money",
    })) as HTMLInputElement;
    expect(toggle.disabled).toBe(false);
  });

  it("cannot be switched on where this site cannot take a money gift, and says so", async () => {
    // Stripe is ready, so only the deployment stands in the way: no Connect
    // webhook to record a gift, or no Stripe at all.
    setCachedRegistry(
      "wed_1",
      snapshot({
        items: [item()],
        takesPayments: false,
        settings: { stripeConnected: true, stripeChargesEnabled: true } as never,
      }),
    );
    renderPanel();

    const toggle = (await screen.findByRole("checkbox", {
      name: "Let guests give money",
    })) as HTMLInputElement;
    expect(toggle.disabled).toBe(true);
    expect(screen.getByTestId("money-gifts-unavailable").textContent).toMatch(
      /money gifts aren’t available on this site yet/i,
    );
    // Connecting the account still works: a site can hold the key before the
    // webhook that records gifts.
    expect(screen.getByRole("button", { name: "Continue on Stripe" })).toBeTruthy();
  });

  it("can still be switched off where this site cannot take a money gift", async () => {
    // Saved on before the site lost the ability to take money. The wedding's
    // currency stays locked while it is on, and the Settings tab tells the
    // couple to turn it off here — so here it must turn off.
    setCachedRegistry(
      "wed_1",
      snapshot({
        items: [item()],
        takesPayments: false,
        settings: {
          cashGiftsEnabled: true,
          stripeConnected: true,
          stripeChargesEnabled: true,
        } as never,
      }),
    );
    authFetch.mockResolvedValue(json({ settings: snapshot().settings }));
    const { container } = renderPanel();

    const toggle = (await screen.findByRole("checkbox", {
      name: "Let guests give money",
    })) as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    expect(toggle.disabled).toBe(false);
    fireEvent.click(toggle);
    fireEvent.submit(container.querySelector("form") as HTMLFormElement);

    await waitFor(() => expect(authFetch).toHaveBeenCalled());
    expect(lastBody()).toEqual({
      cashGiftsEnabled: false,
      expected: { cashGiftsEnabled: true },
    });
  });

  it("says nothing about the site where it can take a money gift", async () => {
    setCachedRegistry(
      "wed_1",
      snapshot({
        items: [item()],
        settings: { stripeConnected: true, stripeChargesEnabled: true } as never,
      }),
    );
    renderPanel();

    await screen.findByRole("checkbox", { name: "Let guests give money" });
    expect(screen.queryByTestId("money-gifts-unavailable")).toBeNull();
  });

  it("says the true thing when the account changed under the page", async () => {
    setCachedRegistry(
      "wed_1",
      snapshot({
        items: [item()],
        settings: { stripeConnected: true, stripeChargesEnabled: true } as never,
      }),
    );
    authFetch.mockResolvedValue(json({ error: "stripe_not_ready" }, 409));
    const { container } = renderPanel();

    const toggle = (await screen.findByRole("checkbox", {
      name: "Let guests give money",
    })) as HTMLInputElement;
    fireEvent.click(toggle);
    fireEvent.submit(container.querySelector("form") as HTMLFormElement);

    await waitFor(() => expect(toastError).toHaveBeenCalled());
    // Not "check the fields" — nothing in the form is wrong.
    expect(String(toastError.mock.calls[0]?.[0])).toMatch(/Stripe can’t take a payment/);
    // And the switch does not sit on, claiming something the server refused.
    expect(
      (screen.getByRole("checkbox", { name: "Let guests give money" }) as HTMLInputElement).checked,
    ).toBe(false);
  });

  /** Switch money gifts on against a 409 carrying `error`, as `canManage`. */
  async function refusedWith(error: string, canManage = true) {
    setCachedRegistry(
      "wed_1",
      snapshot({
        items: [item()],
        settings: {
          stripeConnected: true,
          stripeChargesEnabled: true,
          moneyGiftsBlockedBy: "cash_gifts_off",
        } as never,
      }),
    );
    authFetch.mockImplementation(async (url: string) =>
      String(url).includes("/registry/stripe/refresh")
        ? json({ connected: true, chargesEnabled: true, payoutsEnabled: true })
        : json({ error }, 409),
    );
    const { container } = renderPanel({ canManage });
    fireEvent.click(await screen.findByRole("checkbox", { name: "Let guests give money" }));
    fireEvent.submit(container.querySelector("form") as HTMLFormElement);
    await waitFor(() => expect(toastError).toHaveBeenCalled());
    return String(toastError.mock.calls[0]?.[0]);
  }

  it("says the account pays out in another currency when that is the refusal", async () => {
    const message = await refusedWith("currency_mismatch");
    expect(message).toMatch(/pays out in a different currency/);
    expect(message).not.toMatch(/can’t take a payment/);
    expect(
      (screen.getByRole("checkbox", { name: "Let guests give money" }) as HTMLInputElement).checked,
    ).toBe(false);
  });

  it("asks Stripe again for an owner when the payout currency is not known yet", async () => {
    const message = await refusedWith("stripe_currency_unknown");
    expect(message).toMatch(/hasn’t told us which currency/);
    await waitFor(() => {
      const urls = authFetch.mock.calls.map((c) => String(c[0]));
      expect(urls.some((u) => u.includes("/registry/stripe/refresh"))).toBe(true);
    });
    expect(
      (screen.getByRole("checkbox", { name: "Let guests give money" }) as HTMLInputElement).checked,
    ).toBe(false);
  });

  it("tells an editor to ask an owner, since only an owner can ask Stripe again", async () => {
    const message = await refusedWith("stripe_currency_unknown", false);
    expect(message).toMatch(/hasn’t told us which currency/);
    expect(message).toMatch(/owner/);
    const urls = authFetch.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes("/registry/stripe/refresh"))).toBe(false);
  });

  /** A money-on save refused for an editor, with `body` as the 409's answer:
   *  JSON, or a whole `Response` for a body that is not. */
  async function editorRefused(body: unknown) {
    // Loaded as "money off"; a co-host has since moved the wedding to a
    // currency the account does not pay out in.
    setCachedRegistry(
      "wed_1",
      snapshot({
        items: [item({ kind: "cash_fund", title: "Honeymoon", targetMinor: 500_000 })],
        settings: {
          stripeConnected: true,
          stripeChargesEnabled: true,
          moneyGiftsBlockedBy: "cash_gifts_off",
        } as never,
      }),
    );
    authFetch.mockResolvedValue(body instanceof Response ? body : json(body, 409));
    const { container } = renderPanel({ canManage: false });
    fireEvent.click(await screen.findByRole("checkbox", { name: "Let guests give money" }));
    fireEvent.submit(container.querySelector("form") as HTMLFormElement);
    await waitFor(() => expect(toastError).toHaveBeenCalledTimes(1));
  }

  it("shows the reason a refused money save carries, without asking again", async () => {
    const now = snapshot({
      items: [item({ kind: "cash_fund", title: "Honeymoon", targetMinor: 500_000 })],
      settings: {
        stripeConnected: true,
        stripeChargesEnabled: true,
        moneyGiftsBlockedBy: "currency_mismatch",
      } as never,
    });
    await editorRefused({ error: "currency_mismatch", settings: now.settings });

    await waitFor(() => expect(screen.getByTestId("money-gifts-currency")).toBeTruthy());
    expect(document.getElementById("registry-publish-blocked")?.textContent).toMatch(
      /pays out in a currency other than AUD/,
    );
    // The refusal was the whole answer: no second request, no Stripe read.
    expect(authFetch).toHaveBeenCalledTimes(1);
    // The list stays as it was: only the settings row was patched.
    expect(peekCachedRegistry("wed_1")?.items).toHaveLength(1);
  });

  it("keeps what it holds when a refusal carries no settings, and says nothing more", async () => {
    // An API that predates the field answers with the code alone.
    await editorRefused({ error: "currency_mismatch" });
    expect(peekCachedRegistry("wed_1")?.settings.moneyGiftsBlockedBy).toBe("cash_gifts_off");
    expect(screen.getByTestId("stripe-status").textContent).toMatch(
      /connected and can take payments/i,
    );
    expect(authFetch).toHaveBeenCalledTimes(1);
  });

  it("says only that Stripe cannot take a payment when a refusal's body is not JSON", async () => {
    // A proxy in front of the API can answer 409 with a page of its own.
    await editorRefused(new Response("Conflict", { status: 409 }));
    expect(toastError).toHaveBeenCalledTimes(1);
    expect(String(toastError.mock.calls[0]?.[0])).toMatch(/Stripe can’t take a payment/);
    expect(peekCachedRegistry("wed_1")?.settings.moneyGiftsBlockedBy).toBe("cash_gifts_off");
  });
});

describe("who may connect the account", () => {
  it("lets the owner start onboarding, and hands them to Stripe", async () => {
    setCachedRegistry("wed_1", snapshot({ items: [item()] }));
    noOtherAccounts(() => json({ url: "https://connect.stripe.com/setup/s/x" }));
    const assign = vi.fn();
    Object.defineProperty(window, "location", { configurable: true, value: { assign } });

    renderPanel({ canManage: true });
    const button = await screen.findByRole("button", { name: /Connect an account/i });
    expect((button as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(button);

    await waitFor(() =>
      expect(assign).toHaveBeenCalledWith("https://connect.stripe.com/setup/s/x"),
    );
    const [url, init] = authFetch.mock.calls.at(-1) ?? [];
    expect(String(url)).toContain("/registry/stripe/session");
    expect((init as RequestInit | undefined)?.method).toBe("POST");
  });

  it("goes to Stripe and nowhere else", async () => {
    // The response body decides where a signed-in owner's browser goes next, so
    // anything that is not Stripe's own onboarding host is refused rather than
    // navigated to.
    setCachedRegistry("wed_1", snapshot({ items: [item()] }));
    noOtherAccounts(() => json({ url: "https://connect.stripe.com.evil.test/setup" }));
    const assign = vi.fn();
    Object.defineProperty(window, "location", { configurable: true, value: { assign } });

    renderPanel({ canManage: true });
    fireEvent.click(await screen.findByRole("button", { name: /Connect an account/i }));

    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(assign).not.toHaveBeenCalled();
  });

  it("shows an editor the panel, disabled, with the reason", async () => {
    setCachedRegistry("wed_1", snapshot({ items: [item()] }));
    renderPanel({ canEdit: true, canManage: false });

    const button = await screen.findByRole("button", { name: /Connect an account/i });
    // Visible, not hidden: a co-host who wonders why money gifts are off gets
    // an answer instead of a missing section.
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByTestId("stripe-owner-only").textContent).toMatch(
      /only the wedding’s owner/i,
    );
    // And the reason is REACHABLE: `aria-disabled` rather than `disabled` keeps
    // the button in the tab order, and the description says whose job it is.
    expect(button.getAttribute("aria-describedby")).toBe("stripe-owner-only");
    expect(screen.getByTestId("stripe-owner-only").id).toBe("stripe-owner-only");
    // The other owners' reason is not an editor's.
    expect(screen.queryByTestId("stripe-connector-only")).toBeNull();
    // Focusable, but still inert — pressing it asks Stripe for nothing.
    fireEvent.click(button);
    expect(authFetch).not.toHaveBeenCalled();
  });

  it("gives an editor the owners' reason, not the connector's, once an account exists", async () => {
    setCachedRegistry(
      "wed_1",
      snapshot({
        items: [item()],
        settings: {
          stripeConnected: true,
          stripeChargesEnabled: true,
          moneyGiftsBlockedBy: "cash_gifts_off",
        } as never,
      }),
    );
    renderPanel({ canEdit: true, canManage: false });

    const button = await screen.findByRole("button", { name: /Continue on Stripe/i });
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.getAttribute("aria-describedby")).toBe("stripe-owner-only");
    expect(screen.getByTestId("stripe-owner-only")).toBeTruthy();
    expect(screen.queryByTestId("stripe-connector-only")).toBeNull();
    // An editor helps the couple, so the account is still "yours" to them.
    expect(screen.getByTestId("stripe-status").textContent).toMatch(/straight to your account/i);
  });

  it("says Stripe could not be reached when the refusal is not a 403", async () => {
    setCachedRegistry("wed_1", snapshot({ items: [item()] }));
    // No other account to offer, so the press goes on to Stripe, which fails.
    noOtherAccounts(() => json({ error: "stripe_unavailable" }, 502));

    renderPanel({ canManage: true });
    fireEvent.click(await screen.findByRole("button", { name: /Connect an account/i }));

    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(String(toastError.mock.calls.at(-1)?.[0])).toBe(
      "Couldn’t reach Stripe just now. Try again in a moment.",
    );
    expect(peekCachedRegistry("wed_1")?.settings.stripeConnected).toBe(false);
  });

  it("tells an owner the role gate refused them, and changes nothing it holds", async () => {
    // A 403 that is not about the account: this organiser is no longer an owner.
    setCachedRegistry("wed_1", snapshot({ items: [item()] }));
    noOtherAccounts(() => json({ error: "forbidden" }, 403));

    renderPanel({ canManage: true });
    fireEvent.click(await screen.findByRole("button", { name: /Connect an account/i }));

    await waitFor(() => expect(toastError).toHaveBeenCalled());
    const words = String(toastError.mock.calls.at(-1)?.[0]);
    expect(words).toMatch(/only the wedding’s owner/i);
    expect(words).not.toMatch(/person who connected/i);
    expect(peekCachedRegistry("wed_1")?.settings.stripeConnected).toBe(false);
  });
});

describe("who may continue on Stripe once an account is connected", () => {
  /** A ready account, connected by `connector`. */
  const connectedBy = (connector: string | null) =>
    snapshot({
      items: [item()],
      settings: {
        stripeConnected: true,
        stripeChargesEnabled: true,
        stripeConnectedByOsnProfileId: connector,
        moneyGiftsBlockedBy: "cash_gifts_off",
      } as never,
    });

  it("hands the owner who connected it back to Stripe, as before", async () => {
    setCachedRegistry("wed_1", connectedBy(ME));
    authFetch.mockResolvedValue(json({ url: "https://connect.stripe.com/setup/s/again" }));
    const assign = vi.fn();
    Object.defineProperty(window, "location", { configurable: true, value: { assign } });

    renderPanel({ canManage: true });
    const button = await screen.findByRole("button", { name: /Continue on Stripe/i });
    expect(button.getAttribute("aria-disabled")).toBeNull();
    expect(screen.queryByTestId("stripe-connector-only")).toBeNull();
    expect(screen.getByTestId("stripe-status").textContent).toMatch(/straight to your account/i);
    fireEvent.click(button);

    await waitFor(() =>
      expect(assign).toHaveBeenCalledWith("https://connect.stripe.com/setup/s/again"),
    );
    const [url, init] = authFetch.mock.calls.at(-1) ?? [];
    expect(String(url)).toContain("/registry/stripe/session");
    expect((init as RequestInit | undefined)?.method).toBe("POST");
  });

  it.each([
    ["another owner connected it", "usr_partner", ME],
    ["nobody is recorded as connecting it", null, ME],
    ["nobody is recorded and the session is still loading", null, null],
  ] as const)("shows the status and no link when %s", async (_label, connector, me) => {
    activeProfileId.mockImplementation(() => me);
    setCachedRegistry("wed_1", connectedBy(connector));
    authFetch.mockResolvedValue(
      json({
        connected: true,
        chargesEnabled: true,
        payoutsEnabled: true,
        moneyGiftsBlockedBy: "cash_gifts_off",
      }),
    );

    renderPanel({ canManage: true });
    // The account's status — and not that it is this owner's account.
    const status = (await screen.findByTestId("stripe-status")).textContent;
    expect(status).toMatch(/connected and can take payments/i);
    expect(status).toMatch(/account of the person who connected it/i);
    expect(status).not.toMatch(/your account/i);
    const button = screen.getByRole("button", { name: /Continue on Stripe/i });
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.getAttribute("aria-describedby")).toBe("stripe-connector-only");
    const note = screen.getByTestId("stripe-connector-only");
    expect(note.id).toBe("stripe-connector-only");
    expect(note.textContent).toMatch(/only the person who connected this Stripe account/i);
    // The editor's reason is not this owner's.
    expect(screen.queryByTestId("stripe-owner-only")).toBeNull();
    fireEvent.click(button);
    expect(authFetch).not.toHaveBeenCalled();

    // Checking on the account stays theirs.
    fireEvent.click(screen.getByRole("button", { name: /Check again/i }));
    await waitFor(() => expect(authFetch).toHaveBeenCalledTimes(1));
    expect(String(authFetch.mock.calls[0]?.[0])).toContain("/registry/stripe/refresh");
  });

  it("says whose account it is when the API refuses a page that is out of date", async () => {
    // This page still thinks the caller connected it; the row says otherwise.
    setCachedRegistry("wed_1", connectedBy(ME));
    authFetch.mockResolvedValue(json({ error: "stripe_connector_only" }, 403));
    const assign = vi.fn();
    Object.defineProperty(window, "location", { configurable: true, value: { assign } });

    renderPanel({ canManage: true });
    fireEvent.click(await screen.findByRole("button", { name: /Continue on Stripe/i }));

    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(toastError.mock.calls.at(-1)?.[0]).toMatch(
      /only the person who connected this Stripe account/i,
    );
    expect(assign).not.toHaveBeenCalled();
    // And the panel stops offering the link it was just refused.
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /Continue on Stripe/i }).getAttribute("aria-disabled"),
      ).toBe("true"),
    );
    expect(screen.getByTestId("stripe-connector-only")).toBeTruthy();
  });

  it("stops offering Connect when another owner connected the account meanwhile", async () => {
    // Loaded with no account; another owner connected one before this press.
    setCachedRegistry("wed_1", snapshot({ items: [item()] }));
    noOtherAccounts(() => json({ error: "stripe_connector_only" }, 403));

    renderPanel({ canManage: true });
    fireEvent.click(await screen.findByRole("button", { name: /Connect an account/i }));

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /Continue on Stripe/i }).getAttribute("aria-disabled"),
      ).toBe("true"),
    );
    expect(screen.getByTestId("stripe-status").textContent).toMatch(
      /from the person who connected it/i,
    );
  });
});

describe("the live Stripe read", () => {
  it("happens for a couple mid-onboarding", async () => {
    setCachedRegistry(
      "wed_1",
      snapshot({
        items: [item()],
        settings: { stripeConnected: true, stripeChargesEnabled: false } as never,
      }),
    );
    authFetch.mockResolvedValue(
      json({ connected: true, chargesEnabled: true, payoutsEnabled: true }),
    );
    renderPanel();

    // They have just come back from Stripe and the webhook may be seconds
    // behind them; this is the one state where asking is worth a call.
    await waitFor(() => {
      const urls = authFetch.mock.calls.map((c) => String(c[0]));
      expect(urls.some((u) => u.includes("/registry/stripe/refresh"))).toBe(true);
    });
    await waitFor(() =>
      expect(
        (screen.getByRole("checkbox", { name: "Let guests give money" }) as HTMLInputElement)
          .disabled,
      ).toBe(false),
    );
  });

  it("does not happen for a couple with no account, or one already ready", async () => {
    setCachedRegistry("wed_1", snapshot({ items: [item()] }));
    renderPanel();
    await screen.findByRole("radio", { name: /^Published/ });
    expect(authFetch).not.toHaveBeenCalled();

    cleanup();
    __resetRegistryCache();
    authFetch.mockReset();
    setCachedRegistry(
      "wed_1",
      snapshot({
        items: [item()],
        settings: {
          stripeConnected: true,
          stripeChargesEnabled: true,
          moneyGiftsBlockedBy: "cash_gifts_off",
        } as never,
      }),
    );
    renderPanel();
    await screen.findByRole("radio", { name: /^Published/ });
    expect(authFetch).not.toHaveBeenCalled();
  });

  it("happens for an owner whose Stripe can charge but has not named its currency", async () => {
    // The account is live, but money cannot open until Stripe names the payout
    // currency — which the webhook may be seconds behind on.
    const unnamed = () =>
      snapshot({
        items: [item()],
        settings: {
          stripeConnected: true,
          stripeChargesEnabled: true,
          moneyGiftsBlockedBy: "stripe_currency_unknown",
        } as never,
      });
    setCachedRegistry("wed_1", unnamed());
    authFetch.mockResolvedValue(
      json({
        connected: true,
        chargesEnabled: true,
        payoutsEnabled: true,
        moneyGiftsBlockedBy: "cash_gifts_off",
      }),
    );
    renderPanel({ canManage: true });
    await waitFor(() =>
      expect(peekCachedRegistry("wed_1")?.settings.moneyGiftsBlockedBy).toBe("cash_gifts_off"),
    );
    const urls = authFetch.mock.calls.map((c) => String(c[0]));
    expect(urls.filter((u) => u.includes("/registry/stripe/refresh"))).toHaveLength(1);

    // An editor cannot ask Stripe, so the panel does not try.
    cleanup();
    __resetRegistryCache();
    authFetch.mockReset();
    setCachedRegistry("wed_1", unnamed());
    renderPanel({ canManage: false });
    await screen.findByRole("radio", { name: /^Published/ });
    expect(authFetch).not.toHaveBeenCalled();
  });
});

describe("what the panel says about the account", () => {
  it("asks a couple with no account to connect one, and offers nothing to re-check", async () => {
    setCachedRegistry("wed_1", snapshot({ items: [item()] }));
    renderPanel();

    expect((await screen.findByTestId("stripe-status")).textContent).toMatch(
      /connect a Stripe account/i,
    );
    expect(screen.getByRole("button", { name: /Connect an account/i })).toBeTruthy();
    // Nothing to check on yet, so the button that checks is not there to press.
    expect(screen.queryByRole("button", { name: /Check again/i })).toBeNull();
  });

  it("tells a couple mid-onboarding that Stripe is still waiting on them", async () => {
    setCachedRegistry(
      "wed_1",
      snapshot({
        items: [item()],
        settings: {
          stripeConnected: true,
          stripeChargesEnabled: false,
          stripeConnectedByOsnProfileId: ME,
        } as never,
      }),
    );
    // The mount read finds nothing has changed, so the panel stays where it was.
    authFetch.mockResolvedValue(
      json({ connected: true, chargesEnabled: false, payoutsEnabled: false }),
    );
    renderPanel();

    expect((await screen.findByTestId("stripe-status")).textContent).toMatch(
      /still wants something/i,
    );
    // Not "connect an account" — they have one, and sending them back to the
    // start would read as though the work they already did was lost.
    expect(screen.getByRole("button", { name: /Continue on Stripe/i })).toBeTruthy();
    // Awaited: the mount read is in flight on first paint, and the button reads
    // "Checking…" until it lands.
    expect(await screen.findByRole("button", { name: /Check again/i })).toBeTruthy();
  });

  it("tells a ready couple the money reaches them directly", async () => {
    setCachedRegistry(
      "wed_1",
      snapshot({
        items: [item()],
        settings: { stripeConnected: true, stripeChargesEnabled: true } as never,
      }),
    );
    renderPanel();

    const status = await screen.findByTestId("stripe-status");
    expect(status.textContent).toMatch(/connected and can take payments/i);
    expect(status.textContent).toMatch(/never hold the money/i);
    expect(screen.getByRole("button", { name: /Continue on Stripe/i })).toBeTruthy();
  });
});

describe("checking on Stripe by hand", () => {
  it("opens a list of funds alone once the answer says guests can give", async () => {
    setCachedRegistry(
      "wed_1",
      snapshot({
        items: [item({ kind: "cash_fund", title: "Honeymoon", targetMinor: 500_000 })],
        settings: {
          cashGiftsEnabled: true,
          stripeConnected: true,
          stripeChargesEnabled: true,
          moneyGiftsBlockedBy: "stripe_currency_unknown",
        } as never,
      }),
    );
    // The one-shot mount read answers as Stripe did then; the press, as now.
    authFetch
      .mockResolvedValueOnce(
        json({
          connected: true,
          chargesEnabled: true,
          payoutsEnabled: true,
          moneyGiftsBlockedBy: "stripe_currency_unknown",
        }),
      )
      .mockResolvedValue(
        json({
          connected: true,
          chargesEnabled: true,
          payoutsEnabled: true,
          moneyGiftsBlockedBy: null,
        }),
      );
    renderPanel();
    await screen.findByTestId("money-gifts-currency");
    await waitFor(() => expect(authFetch).toHaveBeenCalledTimes(1));

    fireEvent.click(await screen.findByRole("button", { name: /Check again/i }));

    await waitFor(() =>
      expect((screen.getByRole("radio", { name: /^Published/ }) as HTMLInputElement).disabled).toBe(
        false,
      ),
    );
    expect(screen.queryByTestId("money-gifts-currency")).toBeNull();
    expect(String(toastSuccess.mock.calls.at(-1)?.[0])).toMatch(/Stripe is ready/);
    // A patch of the cached settings, not a re-read of the whole registry.
    const urls = authFetch.mock.calls.map((c) => String(c[0]));
    expect(urls.every((u) => u.includes("/registry/stripe/refresh"))).toBe(true);
  });

  it.each([
    [false, "stripe_not_ready", /still has something outstanding/, "reject"],
    [
      true,
      "stripe_currency_unknown",
      /hasn’t said which currency your account pays out in/,
      "reject",
    ],
    [true, "currency_mismatch", /pays out in a currency other than NZD/, "reject"],
    [true, "payments_unavailable", /money gifts aren’t available on this site yet/, "reject"],
    [true, "cash_gifts_off", /^Stripe is ready — you can let guests give money\.$/, "commit"],
    [true, null, /^Stripe is ready — you can let guests give money\.$/, "commit"],
  ] as const)(
    "calls an account ready only when nothing on Stripe's side keeps guests from giving (charges %s, %s)",
    async (chargesEnabled, reason, words, feel) => {
      setCachedRegistry("wed_1", {
        ...snapshot({
          items: [item()],
          settings: {
            stripeConnected: true,
            stripeChargesEnabled: true,
            moneyGiftsBlockedBy: "cash_gifts_off",
          } as never,
        }),
        currency: "NZD",
      });
      authFetch.mockResolvedValue(
        json({
          connected: true,
          chargesEnabled,
          payoutsEnabled: true,
          moneyGiftsBlockedBy: reason,
        }),
      );
      renderPanel();
      fireEvent.click(await screen.findByRole("button", { name: /Check again/i }));
      await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
      const message = String(toastSuccess.mock.calls.at(-1)?.[0]);
      expect(message).toMatch(words);
      // Only good news says "ready": a toast for a blocked account never does.
      expect(/ready/i.test(message)).toBe(feel === "commit");
      expect(haptic).toHaveBeenLastCalledWith(feel);
    },
  );

  it("still reports what Stripe said when the registry is let go while it asks", async () => {
    setCachedRegistry(
      "wed_1",
      snapshot({
        items: [item()],
        settings: {
          stripeConnected: true,
          stripeChargesEnabled: true,
          moneyGiftsBlockedBy: "cash_gifts_off",
        } as never,
      }),
    );
    let answer: (res: Response) => void = () => {};
    authFetch.mockReturnValue(new Promise<Response>((resolve) => (answer = resolve)));
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: /Check again/i }));
    await waitFor(() => expect(authFetch).toHaveBeenCalledTimes(1));
    // The organiser leaves the wedding mid-read: its snapshot is released.
    dropRegistry("wed_1");
    answer(
      json({
        connected: true,
        chargesEnabled: true,
        payoutsEnabled: true,
        moneyGiftsBlockedBy: "currency_mismatch",
      }),
    );
    // The answer is still Stripe's, in the currency the API falls back to —
    // not a made-up "couldn't reach Stripe".
    await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
    expect(String(toastSuccess.mock.calls[0]?.[0])).toMatch(/a currency other than AUD,/);
    expect(toastError).not.toHaveBeenCalled();
  });

  it("says so when Stripe cannot be reached, and changes nothing", async () => {
    setCachedRegistry(
      "wed_1",
      snapshot({
        items: [item()],
        settings: { stripeConnected: true, stripeChargesEnabled: true } as never,
      }),
    );
    authFetch.mockResolvedValue(json({ error: "stripe_unavailable" }, 502));
    renderPanel();

    fireEvent.click(await screen.findByRole("button", { name: /Check again/i }));

    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(String(toastError.mock.calls[0]?.[0])).toMatch(/Couldn’t reach Stripe just now/);
    // An outage is not news about the account: the panel keeps saying what it
    // last knew rather than demoting a couple who can in fact take payments.
    expect(screen.getByTestId("stripe-status").textContent).toMatch(
      /connected and can take payments/i,
    );
    expect(
      (screen.getByRole("checkbox", { name: "Let guests give money" }) as HTMLInputElement)
        .disabled,
    ).toBe(false);
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it("asks a couple whose account Stripe no longer knows to connect one again", async () => {
    setCachedRegistry(
      "wed_1",
      snapshot({
        items: [item()],
        settings: { stripeConnected: true, stripeChargesEnabled: true } as never,
      }),
    );
    authFetch.mockResolvedValue(
      json({ connected: false, chargesEnabled: false, payoutsEnabled: false }),
    );
    renderPanel();

    fireEvent.click(await screen.findByRole("button", { name: /Check again/i }));

    // Not "Stripe still wants something" — there is no account to finish.
    await waitFor(() =>
      expect(screen.getByTestId("stripe-status").textContent).toMatch(/connect a Stripe account/i),
    );
    expect(peekCachedRegistry("wed_1")?.settings.stripeConnected).toBe(false);
  });

  it("re-reads Stripe after a save it refused, without a second complaint", async () => {
    setCachedRegistry(
      "wed_1",
      snapshot({
        items: [item()],
        settings: { stripeConnected: true, stripeChargesEnabled: true } as never,
      }),
    );
    authFetch.mockImplementation((url: string) =>
      Promise.resolve(
        String(url).includes("/registry/stripe/refresh")
          ? json({ connected: true, chargesEnabled: false, payoutsEnabled: false })
          : json({ error: "stripe_not_ready" }, 409),
      ),
    );
    const { container } = renderPanel();

    fireEvent.click(await screen.findByRole("checkbox", { name: "Let guests give money" }));
    fireEvent.submit(container.querySelector("form") as HTMLFormElement);

    // The 409 says the page is out of date about Stripe, so the panel goes and
    // finds out rather than waiting for the couple to press anything.
    await waitFor(() => {
      const urls = authFetch.mock.calls.map((c) => String(c[0]));
      expect(urls.some((u) => u.includes("/registry/stripe/refresh"))).toBe(true);
    });
    await waitFor(() =>
      expect(screen.getByTestId("stripe-status").textContent).toMatch(/still wants something/i),
    );
    // One complaint, about the save. The read behind it is quiet: a second
    // toast saying Stripe is not ready tells them nothing they were not just
    // told, and a success toast would contradict the first.
    expect(toastError).toHaveBeenCalledTimes(1);
    expect(toastSuccess).not.toHaveBeenCalled();
  });
});

describe("the one-shot live read", () => {
  it("is spent for good, so a couple switching tabs does not re-ask Stripe", async () => {
    setCachedRegistry(
      "wed_1",
      snapshot({
        items: [item()],
        settings: { stripeConnected: true, stripeChargesEnabled: false } as never,
      }),
    );
    // Still not ready, so nothing about the wedding has changed between the two
    // mounts: only the spent token stops the second read.
    authFetch.mockResolvedValue(
      json({ connected: true, chargesEnabled: false, payoutsEnabled: false }),
    );

    renderPanel();
    await waitFor(() => expect(authFetch).toHaveBeenCalledTimes(1));

    cleanup();
    renderPanel();
    await screen.findByRole("radio", { name: /^Published/ });
    expect(authFetch).toHaveBeenCalledTimes(1);
  });
});

describe("asking which Stripe account takes the gifts", () => {
  type Listed = {
    fromWeddingId: string;
    weddingNames: string[];
    chargesEnabled: boolean;
    currencyKnown: boolean;
    blockedBy: "currency_mismatch" | "stripe_owners_differ" | null;
  };
  const READY: Listed = {
    fromWeddingId: "wed_ceremony",
    weddingNames: ["Beach", "Ceremony"],
    chargesEnabled: true,
    currencyKnown: true,
    blockedBy: null,
  };
  const SECOND_READY: Listed = {
    fromWeddingId: "wed_second",
    weddingNames: ["Second"],
    chargesEnabled: true,
    currencyKnown: true,
    blockedBy: null,
  };
  const UNFINISHED: Listed = {
    fromWeddingId: "wed_garden",
    weddingNames: ["Garden", "Hall", "Island"],
    chargesEnabled: false,
    currencyKnown: false,
    blockedBy: null,
  };
  const NO_CURRENCY: Listed = {
    fromWeddingId: "wed_quiet",
    weddingNames: ["Quiet"],
    chargesEnabled: true,
    currencyKnown: false,
    blockedBy: null,
  };
  const OTHER_CURRENCY: Listed = {
    fromWeddingId: "wed_abroad",
    weddingNames: ["Abroad"],
    chargesEnabled: true,
    currencyKnown: true,
    blockedBy: "currency_mismatch",
  };
  const OTHER_OWNERS: Listed = {
    fromWeddingId: "wed_solo",
    weddingNames: ["Solo"],
    chargesEnabled: true,
    currencyKnown: true,
    blockedBy: "stripe_owners_differ",
  };

  /** What the API answers, by route: a response, or an error the fetch throws. */
  function api(answers: {
    accounts?: Response | Error;
    reuse?: Response | Error;
    session?: Response | Error;
  }): void {
    authFetch.mockImplementation(async (url: string) => {
      const at = String(url);
      const answer = at.includes("/registry/stripe/accounts")
        ? (answers.accounts ?? json({ accounts: [] }))
        : at.includes("/registry/stripe/reuse")
          ? (answers.reuse ?? json({}, 500))
          : at.includes("/registry/stripe/session")
            ? (answers.session ?? json({}, 500))
            : json({}, 500);
      if (answer instanceof Error) throw answer;
      return answer;
    });
  }
  const urls = () => authFetch.mock.calls.map((c) => String(c[0]));
  const sessionAsked = () => urls().some((u) => u.includes("/registry/stripe/session"));
  const navigation = () => {
    const assign = vi.fn();
    Object.defineProperty(window, "location", { configurable: true, value: { assign } });
    return assign;
  };
  /** The settings as an API refusal hands them back: this wedding, no account. */
  const asTheyStand = () =>
    snapshot({ items: [item()], settings: { updatedAt: 99 } as never }).settings;

  async function pressConnect(): Promise<void> {
    fireEvent.click(await screen.findByRole("button", { name: /Connect an account/i }));
  }

  /** Offer `accounts`, choose the one taken from `fromWeddingId`, and use it. */
  async function useAccount(accounts: Listed[], fromWeddingId: string): Promise<void> {
    renderPanel({ canManage: true });
    await pressConnect();
    const chosen = accounts.find((a) => a.fromWeddingId === fromWeddingId) as Listed;
    fireEvent.click(
      await screen.findByRole("radio", {
        name: new RegExp(`^The account you use for ${chosen.weddingNames[0]}`),
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Use this account" }));
  }

  it("asks nothing about other accounts until an owner presses Connect", async () => {
    setCachedRegistry("wed_1", snapshot({ items: [item()] }));
    api({ accounts: json({ accounts: [READY] }) });

    renderPanel({ canManage: true });
    await screen.findByRole("button", { name: /Connect an account/i });

    expect(urls().some((u) => u.includes("/registry/stripe/accounts"))).toBe(false);
  });

  it.each([
    ["no other account", json({ accounts: [] })],
    ["a body with no list", json({ url: "https://connect.stripe.com/setup/s/x" })],
  ])("goes straight on to Stripe when there is %s", async (_label, accounts) => {
    setCachedRegistry("wed_1", snapshot({ items: [item()] }));
    api({ accounts, session: json({ url: "https://connect.stripe.com/setup/s/x" }) });
    const assign = navigation();

    renderPanel({ canManage: true });
    await pressConnect();

    await waitFor(() =>
      expect(assign).toHaveBeenCalledWith("https://connect.stripe.com/setup/s/x"),
    );
    expect(urls().map((u) => u.replace(/^.*\/registry\//, ""))).toEqual([
      "stripe/accounts",
      "stripe/session",
    ]);
    expect(screen.queryByTestId("stripe-account-choice")).toBeNull();
  });

  // Whatever stops the list, nothing goes on to Stripe: a new account is made
  // only when the owner chose one, or had nothing else to choose.
  it.each([
    [
      "the site has no Stripe",
      json({ error: "not_found" }, 404),
      "Money gifts aren’t available on this site yet.",
    ],
    [
      "the role gate refuses",
      json({ error: "forbidden" }, 403),
      "Only the wedding’s owner can connect the account gifts are paid into.",
    ],
    [
      "the API fails",
      json({ error: "Internal error" }, 502),
      "Couldn’t start connecting an account just now. Try again in a moment.",
    ],
    [
      "the request never arrives",
      new Error("network down"),
      "Couldn’t start connecting an account just now. Is the API running?",
    ],
  ] as const)("says why and asks Stripe nothing when %s", async (_label, accounts, words) => {
    setCachedRegistry("wed_1", snapshot({ items: [item()] }));
    api({ accounts, session: json({ url: "https://connect.stripe.com/setup/s/x" }) });
    const assign = navigation();

    renderPanel({ canManage: true });
    await pressConnect();

    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(String(toastError.mock.calls.at(-1)?.[0])).toBe(words);
    expect(sessionAsked()).toBe(false);
    expect(assign).not.toHaveBeenCalled();
    expect(screen.queryByTestId("stripe-account-choice")).toBeNull();
  });

  it("sends an owner whose session ended to sign in, from the list", async () => {
    setCachedRegistry("wed_1", snapshot({ items: [item()] }));
    api({ accounts: json({ error: "unauthorised" }, 401) });

    renderPanel({ canManage: true });
    await pressConnect();

    await waitFor(() => expect(redirectToLogin).toHaveBeenCalled());
    expect(sessionAsked()).toBe(false);
  });

  it("asks which account, with none chosen, and says why the others cannot", async () => {
    setCachedRegistry("wed_1", snapshot({ items: [item()] }));
    api({
      accounts: json({
        accounts: [READY, UNFINISHED, NO_CURRENCY, OTHER_CURRENCY, OTHER_OWNERS],
      }),
    });

    renderPanel({ canManage: true });
    await pressConnect();

    const choice = await screen.findByTestId("stripe-account-choice");
    // The button pressed is gone, so the question takes focus, named by its
    // own words for a screen reader.
    await waitFor(() => expect(document.activeElement).toBe(choice));
    expect(choice.tagName).toBe("FIELDSET");
    expect(choice.getAttribute("aria-labelledby")).toBe("stripe-account-choice-label");
    const radios = screen.getAllByRole("radio", { name: /account/i }) as HTMLInputElement[];
    // Each account by the weddings it serves, with what Stripe can do with it.
    expect(radios.map((r) => r.closest("label")?.textContent ?? "")).toEqual([
      "The account you use for Beach and CeremonyStripe can take payments on it.",
      "The account you use for Garden, Hall and IslandStripe still wants something before it can take payments.",
      "The account you use for QuietStripe hasn’t said which currency it pays out in yet.",
      "A new account for this weddingStripe asks for your identity and bank details.",
    ]);
    // Nothing is chosen for the owner: giving a wedding an account is theirs
    // to decide, every time.
    expect(radios.every((r) => !r.checked)).toBe(true);
    // The question's own buttons stand in for Connect while it is open.
    expect(screen.queryByRole("button", { name: /Connect an account/i })).toBeNull();
    // An account that cannot take these gifts is a line, not a radio — and
    // only those accounts get one.
    const lines = [...choice.querySelectorAll("p")]
      .map((p) => p.textContent ?? "")
      .filter((text) => text.startsWith("The account you use for"));
    expect(lines).toEqual([
      "The account you use for Abroad pays out in a currency other than AUD, the one this wedding’s gifts are charged in, so it can’t take them.",
      "The account you use for Solo can’t be used here: this wedding has an owner who isn’t an owner of Solo.",
    ]);

    // With nothing chosen the action says so, and does nothing.
    const action = screen.getByRole("button", { name: /^Continue$/ });
    expect(action.getAttribute("aria-disabled")).toBe("true");
    expect(action.getAttribute("aria-describedby")).toBe("stripe-account-choose");
    expect(document.getElementById("stripe-account-choose")?.textContent).toBe(
      "Choose an account first.",
    );
    authFetch.mockClear();
    fireEvent.click(action);
    expect(authFetch).not.toHaveBeenCalled();

    // Once something is chosen the reason goes, and the action names it.
    fireEvent.click(radios[0] as HTMLInputElement);
    const use = await screen.findByRole("button", { name: "Use this account" });
    expect(use.getAttribute("aria-disabled")).toBeNull();
    expect(document.getElementById("stripe-account-choose")).toBeNull();

    // Cancel closes the question and gives focus back to Connect.
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    const connect = await screen.findByRole("button", { name: /Connect an account/i });
    expect(screen.queryByTestId("stripe-account-choice")).toBeNull();
    expect(document.activeElement).toBe(connect);
  });

  it("goes on to Stripe for a new account", async () => {
    setCachedRegistry("wed_1", snapshot({ items: [item()] }));
    api({
      accounts: json({ accounts: [READY] }),
      session: json({ url: "https://connect.stripe.com/setup/s/new" }),
    });
    const assign = navigation();

    renderPanel({ canManage: true });
    await pressConnect();
    fireEvent.click(await screen.findByRole("radio", { name: /A new account for this wedding/ }));
    fireEvent.click(screen.getByRole("button", { name: "Continue to Stripe" }));

    await waitFor(() =>
      expect(assign).toHaveBeenCalledWith("https://connect.stripe.com/setup/s/new"),
    );
    expect(urls().some((u) => u.includes("/registry/stripe/reuse"))).toBe(false);
  });

  it("gives the wedding the account chosen, by its own wedding, without leaving the portal", async () => {
    setCachedRegistry("wed_1", snapshot({ items: [item()] }));
    const now = snapshot({
      items: [item()],
      settings: {
        stripeConnected: true,
        stripeChargesEnabled: true,
        stripeConnectedByOsnProfileId: ME,
        moneyGiftsBlockedBy: "cash_gifts_off",
      } as never,
    });
    api({
      accounts: json({ accounts: [READY, SECOND_READY] }),
      reuse: json({ settings: now.settings }),
    });
    const assign = navigation();

    // The second of two: the request and the words name that one.
    await useAccount([READY, SECOND_READY], SECOND_READY.fromWeddingId);

    await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
    expect(String(toastSuccess.mock.calls.at(-1)?.[0])).toBe(
      "This wedding’s gifts now go to the account you use for Second.",
    );
    const [url, init] = authFetch.mock.calls.at(-1) ?? [];
    expect(String(url)).toContain("/registry/stripe/reuse");
    expect((init as RequestInit | undefined)?.method).toBe("POST");
    expect(lastBody()).toEqual({ fromWeddingId: "wed_second" });
    expect(assign).not.toHaveBeenCalled();
    expect(screen.queryByTestId("stripe-account-choice")).toBeNull();
    expect(screen.getByTestId("stripe-status").textContent).toMatch(/straight to your account/i);
    expect(peekCachedRegistry("wed_1")?.settings.stripeConnectedByOsnProfileId).toBe(ME);
    // Focus lands on the panel's button, which now continues the account.
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: /Continue on Stripe/i }),
    );
  });

  it("shows the account someone else connected meanwhile", async () => {
    setCachedRegistry("wed_1", snapshot({ items: [item()] }));
    const theirs = snapshot({
      items: [item()],
      settings: {
        stripeConnected: true,
        stripeChargesEnabled: false,
        stripeConnectedByOsnProfileId: "usr_partner",
        moneyGiftsBlockedBy: "stripe_not_ready",
      } as never,
    });
    api({
      accounts: json({ accounts: [READY] }),
      reuse: json({ error: "stripe_already_connected", settings: theirs.settings }, 409),
    });

    await useAccount([READY], READY.fromWeddingId);

    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(String(toastError.mock.calls.at(-1)?.[0])).toMatch(/already has a Stripe account/);
    expect(screen.queryByTestId("stripe-account-choice")).toBeNull();
    expect(screen.getByTestId("stripe-status").textContent).toMatch(
      /from the person who connected it/i,
    );
  });

  it.each([
    [
      "can no longer be used here",
      () => json({ error: "stripe_account_not_found" }, 404),
      "That account can’t be used here any more. Choose another, or a new one.",
    ],
    [
      "now sits beside an owner who is not on its own wedding",
      () => json({ error: "stripe_owners_differ", settings: asTheyStand() }, 409),
      "The account you use for Second can’t be used here: this wedding has an owner who isn’t an owner of Second.",
    ],
    [
      "now pays out in another currency",
      () => json({ error: "currency_mismatch", settings: asTheyStand() }, 409),
      "The account you use for Second pays out in a currency other than AUD, the one this wedding’s gifts are charged in, so it can’t take them.",
    ],
  ] as const)("drops an account that %s, and keeps asking", async (_label, answer, words) => {
    setCachedRegistry("wed_1", snapshot({ items: [item()] }));
    api({ accounts: json({ accounts: [READY, SECOND_READY] }), reuse: answer() });

    await useAccount([READY, SECOND_READY], SECOND_READY.fromWeddingId);

    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(String(toastError.mock.calls.at(-1)?.[0])).toBe(words);
    // Only the refused account goes; the other and a new one stay, and
    // nothing is chosen.
    await waitFor(() =>
      expect(screen.queryByRole("radio", { name: /The account you use for Second/ })).toBeNull(),
    );
    expect(screen.getByRole("radio", { name: /The account you use for Beach/ })).toBeTruthy();
    expect(screen.getByRole("radio", { name: /A new account for this wedding/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Continue$/ }).getAttribute("aria-disabled")).toBe(
      "true",
    );
    expect(peekCachedRegistry("wed_1")?.settings.stripeConnected).toBe(false);
  });

  it("takes the settings a refusal hands back", async () => {
    setCachedRegistry("wed_1", snapshot({ items: [item()] }));
    api({
      accounts: json({ accounts: [READY, SECOND_READY] }),
      reuse: json({ error: "stripe_owners_differ", settings: asTheyStand() }, 409),
    });

    await useAccount([READY, SECOND_READY], SECOND_READY.fromWeddingId);

    await waitFor(() => expect(peekCachedRegistry("wed_1")?.settings.updatedAt).toBe(99));
  });

  it.each([
    [
      "the API fails",
      () => json({ error: "Internal error" }, 502) as Response | Error,
      "Couldn’t connect the account just now. Try again in a moment.",
    ],
    [
      "the request never arrives",
      () => new Error("network down") as Response | Error,
      "Couldn’t connect the account just now. Is the API running?",
    ],
  ] as const)("keeps the question open when %s", async (_label, answer, words) => {
    setCachedRegistry("wed_1", snapshot({ items: [item()] }));
    api({ accounts: json({ accounts: [READY, SECOND_READY] }), reuse: answer() });

    await useAccount([READY, SECOND_READY], SECOND_READY.fromWeddingId);

    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(String(toastError.mock.calls.at(-1)?.[0])).toBe(words);
    // Nothing dropped, the choice kept, and the action ready to try again.
    expect(screen.getByRole("radio", { name: /The account you use for Second/ })).toBeTruthy();
    const again = await screen.findByRole("button", { name: "Use this account" });
    expect((again as HTMLButtonElement).disabled).toBe(false);
  });

  it("sends an owner whose session ended to sign in, from the reuse", async () => {
    setCachedRegistry("wed_1", snapshot({ items: [item()] }));
    api({
      accounts: json({ accounts: [READY] }),
      reuse: json({ error: "unauthorised" }, 401),
    });

    await useAccount([READY], READY.fromWeddingId);

    await waitFor(() => expect(redirectToLogin).toHaveBeenCalled());
    expect(toastError).not.toHaveBeenCalled();
  });
});
