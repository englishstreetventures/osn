// @vitest-environment happy-dom
import { AuthContext } from "@osn/client/solid";
import { createMemoryHistory, MemoryRouter, Route } from "@solidjs/router";
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The privacy notice tells a person what they can do for themselves "in
 * Settings". Each of those actions must be a control Settings has, or the
 * notice sends them to a page that cannot do it.
 *
 * The notice is read as a reader sees it, from its rendered text, so a new
 * "in Settings" sentence, or a new item in the list of things a person can do
 * there, fails here until it is matched to a control. Download and delete are
 * driven end to end by `tools/e2e/tests/flows/musubi-account-deletion.flow.ts`;
 * this file holds that the notice and the controls name the same things.
 */

const apps = vi.hoisted(() => ({ revoke: vi.fn() }));

vi.mock("@osn/auth-ui/ProfileOnboarding", () => ({ ProfileOnboarding: () => null }));
vi.mock("../../src/components/SecuritySection", () => ({ default: () => null }));
vi.mock("../../src/lib/authClients", () => ({
  registrationClient: { checkHandle: () => Promise.resolve(true) },
  connectionsClient: {
    list: () =>
      Promise.resolve({
        connections: [
          { clientId: "client_1", clientName: "Pulse", logoUrl: null, scope: "openid" },
        ],
      }),
    revoke: (...args: unknown[]) => {
      apps.revoke(...args);
      return Promise.resolve();
    },
  },
  accountClient: {},
  stepUpClient: {},
  totpClient: {},
}));

import { PrivacyPage } from "../../src/pages/PrivacyPage";
import { SettingsPage } from "../../src/pages/SettingsPage";

type Tab = "account" | "apps";

/** How to find, on its Settings tab, the control behind each thing the notice offers. */
const CONTROLS: Record<string, { tab: Tab; find: () => Promise<HTMLElement> }> = {
  "download a copy of your data": {
    tab: "account",
    find: () => screen.findByRole("button", { name: "Download my data" }),
  },
  "disconnect an app": {
    tab: "apps",
    find: () => screen.findByRole("button", { name: "Revoke" }),
  },
  "delete your account": {
    tab: "account",
    find: () => screen.findByRole("link", { name: "Delete account…" }),
  },
};

/** The "in Settings" sentences this file checks, each by the words that place it. */
const KNOWN_SENTENCES = [
  // "Apps you have connected": withdrawing consent is the Revoke under Connected apps.
  /withdrawing it in Settings under Connected apps/,
  // "Your rights": the list of things a person can do for themselves.
  /you can do yourself in Settings — /,
];

/** The notice's text as rendered, whitespace collapsed. */
function noticeText(): string {
  const { container, unmount } = render(() => <PrivacyPage />);
  const text = (container.textContent ?? "").replace(/\s+/g, " ");
  unmount();
  return text;
}

/** Every sentence of the notice that sends the reader to Settings. */
function settingsSentences(text: string): string[] {
  return text.split(/(?<=\.)\s+/).filter((sentence) => sentence.includes("in Settings"));
}

/** The items of the "you can do yourself in Settings — a, b, c." list. */
function selfServiceItems(text: string): string[] {
  const list = text.match(/you can do yourself in Settings — ([^.]+)\./);
  if (!list) throw new Error("the notice has no list of things to do in Settings");
  return list[1].split(/,\s*(?:or\s+|and\s+)?/).map((item) => item.trim());
}

/** An unsigned access token carrying the claim the page reads. */
const ACCESS_TOKEN = `header.${btoa(JSON.stringify({ sub: "usr_alice" }))}.signature`;

function renderSettings(tab: Tab) {
  const session = { accessToken: ACCESS_TOKEN, idToken: null, expiresAt: 0, scopes: [] };
  const resource = <T,>(value: T) =>
    Object.assign(() => value, {
      state: "ready",
      loading: false,
      error: undefined,
      latest: value,
      refetch: () => {},
      mutate: () => {},
    });
  const auth = {
    session: resource(session),
    profiles: resource([]),
    activeProfileId: () => null,
  };
  const history = createMemoryHistory();
  history.set({ value: `/settings#${tab}` });
  render(() => (
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the slice of AuthContext Settings reads
    <AuthContext.Provider value={auth as any}>
      <MemoryRouter history={history}>
        <Route path="/settings" component={SettingsPage} />
      </MemoryRouter>
    </AuthContext.Provider>
  ));
}

afterEach(() => {
  cleanup();
  apps.revoke.mockClear();
});

describe("what the privacy notice says can be done in Settings", () => {
  it("sends the reader to Settings only in sentences this file checks", () => {
    const unknown = settingsSentences(noticeText()).filter(
      (sentence) => !KNOWN_SENTENCES.some((known) => known.test(sentence)),
    );
    expect(unknown).toEqual([]);
  });

  it("names only actions that have a control in Settings", () => {
    const items = selfServiceItems(noticeText());
    expect(items.length).toBeGreaterThan(0);
    expect(items.filter((item) => !(item in CONTROLS))).toEqual([]);
  });

  it.each(Object.keys(CONTROLS))("finds the control for “%s” on its tab", async (item) => {
    const control = CONTROLS[item];
    renderSettings(control.tab);
    const element = await control.find();
    expect(element.hasAttribute("disabled")).toBe(false);
  });

  it("opens the delete flow from “Delete account…”", async () => {
    renderSettings("account");
    const link = await screen.findByRole("link", { name: "Delete account…" });
    expect(link.getAttribute("href")).toBe("/settings/delete-account");
  });

  it("disconnects an app from Revoke under Connected apps", async () => {
    renderSettings("apps");
    fireEvent.click(await screen.findByRole("button", { name: "Revoke" }));
    await waitFor(() => expect(apps.revoke).toHaveBeenCalledWith({ clientId: "client_1" }));
  });
});
