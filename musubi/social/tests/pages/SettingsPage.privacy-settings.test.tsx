// @vitest-environment happy-dom
import { AuthContext } from "@osn/client/solid";
import { createMemoryHistory, MemoryRouter, Route } from "@solidjs/router";
import { cleanup, render, screen } from "@solidjs/testing-library";
import type { JSX } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The privacy notice and the terms tell a person what they can do for
 * themselves in Settings. Each of those actions must be a control Settings
 * has, or the page sends them somewhere that cannot do it.
 *
 * Both pages are read as a reader sees them, from their rendered text, so a
 * new sentence that names Settings, or a new item in the notice's list of
 * things a person can do there, fails here until it is matched to a control.
 * The controls working is the E2E flows' to show
 * (`musubi-account-deletion.flow.ts` for download and delete,
 * `musubi-passkey.flow.ts` for Revoke); this file holds that the pages and the
 * controls name the same things.
 */

vi.mock("@osn/auth-ui/ProfileOnboarding", () => ({ ProfileOnboarding: () => null }));
vi.mock("../../src/components/SecuritySection", () => ({ default: () => null }));
vi.mock("../../src/lib/authClients", () => ({
  registrationClient: { checkHandle: () => Promise.resolve(true) },
  connectionsClient: {
    list: () =>
      Promise.resolve({
        connections: [
          {
            clientId: "client_1",
            clientName: "Pulse",
            logoUrl: null,
            scope: "openid",
            manageDataUrl: null,
          },
        ],
      }),
    revoke: () => Promise.resolve(),
  },
  accountClient: {},
  stepUpClient: {},
  totpClient: {},
}));

import { PrivacyPage } from "../../src/pages/PrivacyPage";
import { SettingsPage } from "../../src/pages/SettingsPage";
import { TermsPage } from "../../src/pages/TermsPage";

type Tab = "account" | "apps";

/** How to find, on its Settings tab, the control behind each thing the pages offer. */
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

/** Each sentence the pages send a reader to Settings in, by the words that place it, and the action it names. */
const KNOWN_SENTENCES: { words: RegExp; action: string }[] = [
  // Privacy notice, "Apps you have connected".
  { words: /withdrawing it in Settings under Connected apps/, action: "disconnect an app" },
  // Privacy notice, "Your rights": checked item by item below.
  { words: /you can do yourself in Settings — /, action: "the list" },
  // Terms, "Connecting other apps".
  {
    words: /withdraw it at any time in Settings under Connected apps/,
    action: "disconnect an app",
  },
  // Terms, "Ending it".
  { words: /You can delete your account at any time from Settings/, action: "delete your account" },
];

/** A page's text as rendered, whitespace collapsed. */
function pageText(Page: () => JSX.Element): string {
  const { container, unmount } = render(() => <Page />);
  const text = (container.textContent ?? "").replace(/\s+/g, " ");
  unmount();
  return text;
}

/** Every sentence of `text` that names Settings. */
function settingsSentences(text: string): string[] {
  return text.split(/(?<=\.)\s+/).filter((sentence) => /\bSettings\b/.test(sentence));
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

afterEach(() => cleanup());

describe("what the privacy notice and the terms say can be done in Settings", () => {
  it.each([
    ["the privacy notice", PrivacyPage],
    ["the terms", TermsPage],
  ])("%s names Settings only in sentences this file checks", (_name, Page) => {
    const unknown = settingsSentences(pageText(Page)).filter(
      (sentence) => !KNOWN_SENTENCES.some((known) => known.words.test(sentence)),
    );
    expect(unknown).toEqual([]);
  });

  it("matches each of those sentences to an action with a control", () => {
    const unmatched = KNOWN_SENTENCES.filter(
      (known) => known.action !== "the list" && !(known.action in CONTROLS),
    );
    expect(unmatched).toEqual([]);
  });

  it("the privacy notice lists only actions that have a control in Settings", () => {
    const items = selfServiceItems(pageText(PrivacyPage));
    expect(items.length).toBeGreaterThan(0);
    expect(items.filter((item) => !(item in CONTROLS))).toEqual([]);
  });

  it.each(Object.keys(CONTROLS))("finds the control for “%s” on its tab", async (item) => {
    const control = CONTROLS[item];
    renderSettings(control.tab);
    const element = await control.find();
    expect(element.hasAttribute("disabled")).toBe(false);
  });
});
