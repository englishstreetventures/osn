// @vitest-environment happy-dom
import { OsnApiError, type PasskeySummary } from "@osn/client";
import { AuthContext } from "@osn/client/solid";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { createRoot, createSignal, Show } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Settings → Security through the page cache, one test for each way it can
 * show a row a write may have changed, as listed in the branch's plan
 * (F2, F4–F13, F16, F17, F19). The real section, the real `@osn/auth-ui` views and the
 * real cache; only the clients are fakes, answering from `server`, which a
 * test changes as the API would. Each read answers what the server held when
 * it was sent, so a read held across a write answers the rows before it.
 *
 * The cross-account and scope cases are in `SecurityCacheScope.browser.test.tsx`,
 * through the real `AuthProvider`.
 */

const server = vi.hoisted(() => ({
  passkeys: [] as PasskeySummary[],
  totp: { enrolled: false, label: null, lastUsedAt: null, createdAt: null } as {
    enrolled: boolean;
    label: string | null;
    lastUsedAt: number | null;
    createdAt: number | null;
  },
  recovery: { active: 0, total: 0, generatedAt: null } as {
    active: number;
    total: number;
    generatedAt: number | null;
  },
  /** Reads held until `release`, by name: `passkeys`, `totp`, `recovery`. */
  hold: new Set<string>(),
  held: [] as { name: string; go: () => void }[],
  /** A read that fails, by name, with this error. */
  failRead: new Map<string, unknown>(),
  /** Writes held until `releaseWrites`. */
  holdWrites: false,
  heldWrites: [] as (() => void)[],
  /** The next write throws this; `commit` says whether it changed the server first. */
  writeError: null as null | { error: unknown; commit: boolean },
  reads: { passkeys: 0, totp: 0, recovery: 0 } as Record<string, number>,
  nextId: 0,
}));

vi.mock("../../src/lib/authClients", () => {
  const snapshot = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
  async function read<T>(name: string, value: () => T): Promise<T> {
    server.reads[name] = (server.reads[name] ?? 0) + 1;
    const answer = snapshot(value());
    const failure = server.failRead.get(name);
    if (server.hold.has(name)) {
      await new Promise<void>((go) => server.held.push({ name, go }));
    }
    if (failure !== undefined) throw failure;
    return answer;
  }
  async function write<T>(change: () => T): Promise<T> {
    if (server.holdWrites) await new Promise<void>((go) => server.heldWrites.push(go));
    const failure = server.writeError;
    server.writeError = null;
    if (failure) {
      if (failure.commit) change();
      throw failure.error;
    }
    return change();
  }
  return {
    passkeysClient: {
      list: () => read("passkeys", () => ({ passkeys: server.passkeys })),
      rename: ({ id, label }: { id: string; label: string }) =>
        write(() => {
          server.passkeys = server.passkeys.map((p) => (p.id === id ? { ...p, label } : p));
          return { success: true };
        }),
      delete: ({ id }: { id: string }) =>
        write(() => {
          server.passkeys = server.passkeys.filter((p) => p.id !== id);
          return { success: true, remaining: server.passkeys.length };
        }),
      registerBegin: () => Promise.resolve({ challenge: "abc" }),
      registerComplete: () =>
        write(() => {
          server.nextId += 1;
          const id = `pk_new${server.nextId}`;
          server.passkeys = [...server.passkeys, passkey(id, `New key ${server.nextId}`)];
          return { passkeyId: id };
        }),
    },
    totpClient: {
      status: () => read("totp", () => server.totp),
      enrollBegin: () =>
        Promise.resolve({
          otpauthUri: `otpauth://totp/Musubi:a?secret=${SECRET}`,
          totpSecret: SECRET,
        }),
      enrollComplete: ({ label }: { label?: string }) =>
        write(() => {
          server.totp = {
            enrolled: true,
            label: label ?? null,
            lastUsedAt: null,
            createdAt: 1_700_000_000,
          };
          return { enrolled: true };
        }),
      disable: () =>
        write(() => {
          server.totp = { enrolled: false, label: null, lastUsedAt: null, createdAt: null };
          return { success: true };
        }),
    },
    recoveryClient: {
      getRecoveryCodesStatus: () => read("recovery", () => server.recovery),
      generateRecoveryCodes: () =>
        write(() => {
          server.recovery = { active: 10, total: 10, generatedAt: 1_800_000_000 };
          return { codes: CODES };
        }),
    },
    stepUpClient: {
      passkeyBegin: () => Promise.resolve({ options: { challenge: "abc" } }),
      passkeyComplete: () => Promise.resolve({ token: "stpup_x", expiresIn: 300 }),
      emailBegin: vi.fn(),
      emailStatus: vi.fn(),
      emailResend: vi.fn(),
      totpComplete: vi.fn(),
    },
  };

  function passkey(id: string, label: string): PasskeySummary {
    return {
      id,
      label,
      aaguid: null,
      transports: null,
      backupEligible: false,
      backupState: false,
      createdAt: 1_700_000_000,
      lastUsedAt: null,
    };
  }
});
vi.mock("../../src/lib/webauthn-ceremony", () => ({
  runPasskeyCeremony: () => Promise.resolve({ id: "cred", rawId: "cred" }),
}));
vi.mock("../../src/lib/webauthn-registration", () => ({
  runPasskeyRegistration: () => Promise.resolve({ id: "new", rawId: "new" }),
}));
vi.mock("@shared/toast", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const SECRET = vi.hoisted(() => "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP");
const CODES = vi.hoisted(() =>
  Array.from({ length: 10 }, (_, i) => `abcd-efgh-ijkl-${String(i).padStart(4, "0")}`),
);

import SecuritySection from "../../src/components/SecuritySection";
import { authenticatorStatus, passkeyList, recoveryCodesStatus } from "../../src/lib/security-data";

const key = (id: string, label: string): PasskeySummary => ({
  id,
  label,
  aaguid: null,
  transports: null,
  backupEligible: false,
  backupState: false,
  createdAt: 1_700_000_000,
  lastUsedAt: null,
});

// The session `AuthProvider` would hold. A getter reads the signal, so a new
// object binds a new scope (`useSessionScope` reads `state` and `latest`).
const [session, setSession] = createSignal<object | null>(null);
const auth = {
  session: Object.defineProperties(() => session(), {
    state: { get: () => "ready" },
    latest: { get: () => session() },
    loading: { get: () => false },
    error: { get: () => undefined },
  }),
};

const [shown, setShown] = createSignal(true);

/** The tab, as Settings mounts it while Security is selected. */
function mountTab() {
  render(() => (
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the slice of AuthContext the cache reads
    <AuthContext.Provider value={auth as any}>
      <Show when={shown()}>
        <SecuritySection profileId="prof_1" />
      </Show>
    </AuthContext.Provider>
  ));
}

/** Another tab, then Security again. */
function leave() {
  setShown(false);
}
function comeBack() {
  setShown(true);
}

/** Answers every held read, or those of `name`. */
async function release(name?: string) {
  for (const read of server.held.filter((r) => name === undefined || r.name === name)) {
    server.held.splice(server.held.indexOf(read), 1);
    read.go();
  }
  await settle();
}

async function releaseWrites() {
  for (const go of server.heldWrites.splice(0)) go();
  await settle();
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * Every text drawn from now on: nodes added and text rewritten in place. The
 * observer reports late, so `drew` files what it has first.
 */
function watchDrawn() {
  const seen: string[] = [];
  const file = (records: MutationRecord[]) => {
    for (const record of records) {
      if (record.type === "characterData") seen.push(record.target.textContent ?? "");
      for (const node of record.addedNodes) seen.push(node.textContent ?? "");
    }
  };
  const observer = new MutationObserver(file);
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  return {
    drew(text: string) {
      file(observer.takeRecords());
      return seen.some((s) => s.includes(text));
    },
    stop: () => observer.disconnect(),
  };
}

/** Presses the step-up sheet's passkey factor. */
async function passStepUp() {
  const sheet = await screen.findByRole("dialog");
  fireEvent.click(await within(sheet).findByRole("button", { name: /Use passkey/i }));
}

/** The landed tab: passkey rows, the authenticator, the recovery line. */
async function landed() {
  await release();
  await waitFor(() => expect(screen.getByRole("heading", { name: "Passkeys" })).toBeTruthy());
}

let style: HTMLStyleElement | undefined;
beforeEach(() => {
  // Every animation off, as under reduced motion: a closed sheet unmounts at once.
  style = document.createElement("style");
  style.textContent = "* { animation-name: none; }";
  document.head.append(style);
  server.passkeys = [key("pk_a", "Work laptop"), key("pk_b", "Phone")];
  server.totp = { enrolled: false, label: null, lastUsedAt: null, createdAt: null };
  server.recovery = { active: 8, total: 10, generatedAt: 1_700_000_000 };
  server.hold.clear();
  server.held.length = 0;
  server.failRead.clear();
  server.holdWrites = false;
  server.heldWrites.length = 0;
  server.writeError = null;
  server.reads = { passkeys: 0, totp: 0, recovery: 0 };
  server.nextId = 0;
  setShown(true);
  // A session object of this test's own: a new scope, an empty cache.
  setSession({});
});

afterEach(async () => {
  cleanup();
  style?.remove();
  await release();
  await releaseWrites();
});

describe("Settings → Security, shown again", () => {
  it("F2: draws the rows it had at once and replaces them with the read behind them", async () => {
    mountTab();
    await landed();
    await screen.findByText("Work laptop");

    server.passkeys = [key("pk_a", "Work laptop (renamed elsewhere)")];
    server.recovery = { active: 7, total: 10, generatedAt: 1_700_000_000 };
    server.hold.add("passkeys").add("recovery");
    leave();
    comeBack();
    // Drawn from memory, the reads still held.
    expect(screen.getByText("Work laptop")).toBeTruthy();
    expect(screen.getByText(/8 of 10 codes unused/)).toBeTruthy();
    await release();
    await screen.findByText("Work laptop (renamed elsewhere)");
    expect(screen.queryByText("Phone")).toBeNull();
    expect(screen.getByText(/7 of 10 codes unused/)).toBeTruthy();
  });
});

describe("a write, then the tab shown again before its reads land", () => {
  async function leaveAndReturnHeld() {
    server.hold.add("passkeys").add("totp").add("recovery");
    leave();
    const watch = watchDrawn();
    comeBack();
    await settle();
    return watch;
  }

  it("F4: a deleted passkey is never drawn again", async () => {
    mountTab();
    await landed();
    fireEvent.click(await screen.findByRole("button", { name: "Remove Work laptop" }));
    server.hold.add("passkeys");
    await passStepUp();
    await waitFor(() => expect(server.passkeys).toHaveLength(1));
    const watch = await leaveAndReturnHeld();
    expect(watch.drew("Work laptop")).toBe(false);
    expect(screen.getByText("Phone")).toBeTruthy();
    watch.stop();
  });

  it("F4: after a passkey is added, the list without it is never drawn again", async () => {
    mountTab();
    await landed();
    fireEvent.click(await screen.findByRole("button", { name: "Add a passkey" }));
    server.hold.add("passkeys");
    await passStepUp();
    await waitFor(() => expect(server.passkeys).toHaveLength(3));
    const watch = await leaveAndReturnHeld();
    // Nothing of the list before: a first load.
    expect(watch.drew("Work laptop")).toBe(false);
    expect(watch.drew("Phone")).toBe(false);
    await release();
    await screen.findByText("New key 1");
    watch.stop();
  });

  it("F4: after an authenticator is added, Add an authenticator app is never drawn again", async () => {
    mountTab();
    await landed();
    fireEvent.click(await screen.findByRole("button", { name: "Add an authenticator app" }));
    await passStepUp();
    await screen.findByText(SECRET);
    const boxes = screen.getAllByLabelText(/^Digit \d$/);
    for (const [i, ch] of [..."123456"].entries()) {
      fireEvent.input(boxes[i]!, { target: { value: ch } });
    }
    server.hold.add("totp");
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(server.totp.enrolled).toBe(true));
    const watch = await leaveAndReturnHeld();
    expect(watch.drew("Add an authenticator app")).toBe(false);
    await release();
    await screen.findByRole("button", { name: "Remove Authenticator app" });
    watch.stop();
  });

  it("F4: after the authenticator is removed, its row is never drawn again", async () => {
    server.totp = { enrolled: true, label: "iPhone", lastUsedAt: null, createdAt: 1_700_000_000 };
    mountTab();
    await landed();
    fireEvent.click(await screen.findByRole("button", { name: "Remove iPhone" }));
    server.hold.add("totp");
    await passStepUp();
    await waitFor(() => expect(server.totp.enrolled).toBe(false));
    const watch = await leaveAndReturnHeld();
    expect(watch.drew("iPhone")).toBe(false);
    watch.stop();
  });

  it("F4: after a new set of recovery codes, the old set's count is never drawn again", async () => {
    mountTab();
    await landed();
    await screen.findByText(/8 of 10 codes unused/);
    fireEvent.click(screen.getByRole("button", { name: "Generate new codes" }));
    fireEvent.click(await screen.findByRole("button", { name: "Generate new set" }));
    server.hold.add("recovery");
    await passStepUp();
    await screen.findByText(CODES[0]!);
    // Left with the codes on screen, as the page's guard allows once confirmed.
    const watch = await leaveAndReturnHeld();
    expect(watch.drew("8 of 10")).toBe(false);
    await release();
    await screen.findByText(/10 of 10 codes unused/);
    watch.stop();
  });

  it("F6: a delete that answers after the tab has gone leaves no deleted row for the next visit", async () => {
    mountTab();
    await landed();
    server.holdWrites = true;
    fireEvent.click(await screen.findByRole("button", { name: "Remove Work laptop" }));
    await passStepUp();
    await waitFor(() => expect(server.heldWrites).toHaveLength(1));
    leave();
    await releaseWrites();
    server.hold.add("passkeys");
    const watch = watchDrawn();
    comeBack();
    await settle();
    expect(watch.drew("Work laptop")).toBe(false);
    watch.stop();
  });

  it("F6: a delete that answers after the tab is shown again takes its row off at once", async () => {
    mountTab();
    await landed();
    server.holdWrites = true;
    fireEvent.click(await screen.findByRole("button", { name: "Remove Work laptop" }));
    await passStepUp();
    await waitFor(() => expect(server.heldWrites).toHaveLength(1));
    leave();
    comeBack();
    // The delete has not answered: the page knows of no change yet.
    expect(screen.getByText("Work laptop")).toBeTruthy();
    server.hold.add("passkeys");
    await releaseWrites();
    await waitFor(() => expect(screen.queryByText("Work laptop")).toBeNull());
    expect(screen.getByText("Phone")).toBeTruthy();
  });
});

describe("the screen that wrote", () => {
  it("F5: a rename shows the new name at once, the list read again behind it", async () => {
    mountTab();
    await landed();
    fireEvent.click(await screen.findByRole("button", { name: "Rename Work laptop" }));
    fireEvent.input(screen.getByRole("textbox", { name: "Passkey name" }), {
      target: { value: "Desk laptop" },
    });
    server.hold.add("passkeys");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await passStepUp();
    await screen.findByText("Desk laptop");
    const watch = watchDrawn();
    expect(screen.queryByText("Work laptop")).toBeNull();
    expect(server.held.some((r) => r.name === "passkeys")).toBe(true);
    // The old name is not drawn back while the re-read is out.
    await settle();
    expect(watch.drew("Work laptop")).toBe(false);
    watch.stop();
  });

  it("F5: a delete takes its row off at once", async () => {
    mountTab();
    await landed();
    fireEvent.click(await screen.findByRole("button", { name: "Remove Work laptop" }));
    server.hold.add("passkeys");
    await passStepUp();
    await waitFor(() => expect(screen.queryByText("Work laptop")).toBeNull());
    expect(screen.getByText("Phone")).toBeTruthy();
    expect(server.held.some((r) => r.name === "passkeys")).toBe(true);
  });

  it("F5: an added passkey puts the list's placeholder up, never the list without it", async () => {
    mountTab();
    await landed();
    fireEvent.click(await screen.findByRole("button", { name: "Add a passkey" }));
    server.hold.add("passkeys");
    await passStepUp();
    await waitFor(() => expect(screen.queryByText("Work laptop")).toBeNull());
    // As many rows' placeholders as the list last held, so nothing below jumps.
    const region = screen.getByRole("heading", { name: "Passkeys" }).parentElement!.parentElement!;
    // One block per width for each of the two rows.
    expect(region.querySelectorAll('[aria-busy="true"] [aria-hidden="true"]')).toHaveLength(4);
    await release("passkeys");
    await screen.findByText("New key 1");
    expect(screen.getByText("Work laptop")).toBeTruthy();
  });

  it.each([
    ["no answer", 0],
    ["a 500", 500],
    ["a 503", 503],
  ])(
    "F7: a delete that ends with %s forgets the rows at once and reads them again",
    async (_, status) => {
      mountTab();
      await landed();
      server.writeError = { error: new OsnApiError("lost", status), commit: true };
      server.hold.add("passkeys");
      fireEvent.click(await screen.findByRole("button", { name: "Remove Work laptop" }));
      await passStepUp();
      await waitFor(() => expect(screen.queryByText("Work laptop")).toBeNull());
      expect(screen.queryByText("Phone")).toBeNull();
      await release("passkeys");
      await screen.findByText("Phone");
      expect(screen.queryByText("Work laptop")).toBeNull();
    },
  );

  it("F8: a refused rename keeps the rows and its line under the field", async () => {
    mountTab();
    await landed();
    fireEvent.click(await screen.findByRole("button", { name: "Rename Work laptop" }));
    fireEvent.input(screen.getByRole("textbox", { name: "Passkey name" }), {
      target: { value: "Desk laptop" },
    });
    server.writeError = { error: new OsnApiError("bad", 400, "invalid_label"), commit: false };
    server.hold.add("passkeys");
    const before = server.reads.passkeys!;
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await passStepUp();
    const alert = await screen.findByRole("alert");
    const field = screen.getByRole("textbox", { name: "Passkey name" });
    expect(field.getAttribute("aria-describedby")?.split(" ")).toContain(alert.id);
    expect(screen.getByText("Phone")).toBeTruthy();
    // Read again behind the rows: a refusal can mean they were already wrong.
    await waitFor(() => expect(server.reads.passkeys).toBe(before + 1));
  });

  it("F9: a read sent before an add, answering after it, never draws the list without the new key", async () => {
    mountTab();
    await landed();
    // Shown again: the read behind the rows is held, with the two keys in it.
    server.hold.add("passkeys");
    leave();
    comeBack();
    await settle();
    const stale = server.held.find((r) => r.name === "passkeys")!;
    // Add waits on no row, so it runs while that read is out.
    fireEvent.click(screen.getByRole("button", { name: "Add a passkey" }));
    await passStepUp();
    await waitFor(() => expect(server.passkeys).toHaveLength(3));
    await waitFor(() => expect(screen.queryByText("Work laptop")).toBeNull());
    // The old read answers last, with the list before the add.
    server.held.splice(server.held.indexOf(stale), 1);
    stale.go();
    await settle();
    expect(screen.queryByText("Work laptop")).toBeNull();
    await release("passkeys");
    await screen.findByText("New key 1");
  });
});

describe("a failed read", () => {
  it("F10: is never drawn as nothing there", async () => {
    server.failRead.set("passkeys", new OsnApiError("down", 503));
    server.failRead.set("totp", new OsnApiError("down", 503));
    server.failRead.set("recovery", new OsnApiError("down", 503));
    mountTab();
    await screen.findByText(/Your passkeys didn't load/);
    await screen.findByText(/Your authenticator app didn't load/);
    await screen.findByText(/Your recovery codes didn't load/);
    expect(screen.queryByRole("button", { name: "Add an authenticator app" })).toBeNull();
    expect(screen.queryByText(/You don't have any recovery codes yet/)).toBeNull();
    expect(screen.queryByRole("button", { name: /^Rename / })).toBeNull();
  });

  it("F11: behind rows drawn from memory, takes them down", async () => {
    mountTab();
    await landed();
    await screen.findByText("Work laptop");
    server.failRead.set("passkeys", new OsnApiError("gone", 403));
    leave();
    comeBack();
    await screen.findByText(/Your passkeys didn't load/);
    expect(screen.queryByText("Work laptop")).toBeNull();
    expect(screen.queryByText("Phone")).toBeNull();
  });
});

describe("an action pressed while the tab reads behind its rows", () => {
  it("F12: Remove waits, says so, and acts on nothing the read took off", async () => {
    mountTab();
    await landed();
    server.passkeys = [key("pk_b", "Phone")];
    server.hold.add("passkeys");
    leave();
    comeBack();
    await settle();
    const remove = screen.getByRole("button", { name: "Remove Work laptop" });
    fireEvent.click(remove);
    // Busy from the press, before the read answers.
    expect(remove.getAttribute("aria-busy")).toBe("true");
    expect(remove.textContent).toContain("Checking…");
    await release("passkeys");
    await waitFor(() => expect(screen.queryByText("Work laptop")).toBeNull());
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("F12: Generate on a remembered 'none' warns once the read says there are codes", async () => {
    server.recovery = { active: 0, total: 0, generatedAt: null };
    mountTab();
    await landed();
    await screen.findByText(/You don't have any recovery codes yet/);
    server.recovery = { active: 10, total: 10, generatedAt: 1_700_000_000 };
    server.hold.add("recovery");
    leave();
    comeBack();
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Generate recovery codes" }));
    await release("recovery");
    expect(await screen.findByText("Generate a new set?")).toBeTruthy();
  });

  it("F12: Generate whose read fails meanwhile still warns", async () => {
    server.recovery = { active: 0, total: 0, generatedAt: null };
    mountTab();
    await landed();
    await screen.findByText(/You don't have any recovery codes yet/);
    server.hold.add("recovery");
    server.failRead.set("recovery", new OsnApiError("down", 503));
    leave();
    comeBack();
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Generate recovery codes" }));
    await release("recovery");
    expect(await screen.findByText("Generate a new set?")).toBeTruthy();
  });

  it("F13: a second Remove while the first waits is refused, and the sheet names the first", async () => {
    mountTab();
    await landed();
    server.hold.add("passkeys");
    leave();
    comeBack();
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Remove Work laptop" }));
    const other = screen.getByRole("button", { name: "Remove Phone" }) as HTMLButtonElement;
    expect(other.disabled).toBe(true);
    fireEvent.click(other);
    await release("passkeys");
    const sheet = await screen.findByRole("dialog");
    expect(within(sheet).getByText("Remove Work laptop?")).toBeTruthy();
  });
});

describe("the session changing while a write runs", () => {
  it("F16: a delete that answers after a profile switch never leaves the deleted row", async () => {
    mountTab();
    await landed();
    server.holdWrites = true;
    fireEvent.click(await screen.findByRole("button", { name: "Remove Work laptop" }));
    await passStepUp();
    await waitFor(() => expect(server.heldWrites).toHaveLength(1));
    // A profile switch: a new session object, the tab still mounted. Its reads
    // land before the delete does, with the passkey still there.
    setSession({});
    await screen.findByText("Work laptop");
    server.hold.add("passkeys");
    await releaseWrites();
    await waitFor(() => expect(screen.queryByText("Work laptop")).toBeNull());
    await release("passkeys");
    expect(screen.getByText("Phone")).toBeTruthy();
    expect(screen.queryByText("Work laptop")).toBeNull();
  });
});

describe("a row read again", () => {
  it("F19: keeps its element, so a Remove pressed while the read was out keeps focus", async () => {
    mountTab();
    await landed();
    server.passkeys = server.passkeys.map((p) =>
      p.id === "pk_a" ? { ...p, lastUsedAt: 1_700_009_000 } : p,
    );
    server.hold.add("passkeys");
    leave();
    comeBack();
    await settle();
    const remove = screen.getByRole("button", { name: "Remove Work laptop" });
    remove.focus();
    fireEvent.click(remove);
    await release("passkeys");
    await screen.findByRole("dialog");
    expect(remove.isConnected).toBe(true);
  });
});

describe("what never enters the cache", () => {
  /** What a fresh reader of `query` would draw from memory. */
  function held<T>(query: { use: (args: () => [] | undefined) => () => T | undefined }) {
    return createRoot((dispose) => {
      let value: T | undefined;
      AuthContext.Provider({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the slice of AuthContext the cache reads
        value: auth as any,
        get children() {
          value = query.use(() => [])();
          return null;
        },
      });
      dispose();
      return JSON.stringify(value ?? null);
    });
  }

  it("F17: the authenticator's setup key and new recovery codes", async () => {
    mountTab();
    await landed();
    fireEvent.click(await screen.findByRole("button", { name: "Add an authenticator app" }));
    await passStepUp();
    await screen.findByText(SECRET);
    const boxes = screen.getAllByLabelText(/^Digit \d$/);
    for (const [i, ch] of [..."123456"].entries()) {
      fireEvent.input(boxes[i]!, { target: { value: ch } });
    }
    // The reads each write starts are held: what the cache holds then is what
    // the write left in it, before any answer could replace it.
    server.hold.add("totp").add("recovery").add("passkeys");
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(server.totp.enrolled).toBe(true));
    await settle();
    expect(held(authenticatorStatus)).not.toContain(SECRET);
    server.hold.clear();
    await release();
    await screen.findByRole("button", { name: "Remove Authenticator app" });

    fireEvent.click(screen.getByRole("button", { name: "Generate new codes" }));
    fireEvent.click(await screen.findByRole("button", { name: "Generate new set" }));
    server.hold.add("totp").add("recovery").add("passkeys");
    await passStepUp();
    await screen.findByText(CODES[0]!);
    await settle();
    const memory = [held(authenticatorStatus), held(recoveryCodesStatus), held(passkeyList)].join();
    for (const code of CODES) expect(memory).not.toContain(code);
  });
});
