// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ConfirmLinkPage,
  type ConfirmLinkPurpose,
  type ConfirmOutcome,
} from "../src/ConfirmLinkPage";

/**
 * The page an emailed link opens. The host reads the link and makes the
 * confirm call; what is covered here is what the page alone decides: that it
 * never confirms without a press, confirms once per press, what each answer
 * shows and says aloud, where focus goes, and that its one timer dies with it.
 *
 * Fake timers throughout, so the slow-confirm line can be stepped.
 */

const EMAIL = "ada@example.com";

const ERROR_LINE = "We couldn't confirm this email just now.";
const SLOW_LINE = "This is taking longer than usual. Keep this page open.";
const EXPIRED_BODY =
  "It has expired or was already used. If you confirmed it already, go back to where you started and carry on. If not, go back and ask for a new link.";

/** The one Confirm control, whatever it says this moment. */
function confirmButton(): HTMLButtonElement {
  return screen.getByRole("button", {
    name: /^(Confirm|Confirming…|Try again)$/,
  }) as HTMLButtonElement;
}

function queryConfirmButton(): HTMLElement | null {
  return screen.queryByRole("button", { name: /^(Confirm|Confirming…|Try again)$/ });
}

function heading(): HTMLElement {
  return screen.getByRole("heading", { level: 1 });
}

/**
 * A paragraph on the page that reads `text` in full, an address inside it
 * included. The spoken `<output>` repeats some lines, and is not a paragraph.
 */
function paragraph(text: string): HTMLElement | null {
  return (
    screen.queryAllByText((_, el) => el?.tagName === "P" && el.textContent === text)[0] ?? null
  );
}

/** Elements outside the spoken `<output>` whose own text reads `text`. */
function shown(text: string): HTMLElement[] {
  return screen.queryAllByText(text).filter((el) => !el.closest("output"));
}

function announcer(container: HTMLElement): HTMLOutputElement {
  const output = container.querySelector("output");
  if (!output) throw new Error("no <output> in the page");
  return output;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Lets an awaited `onConfirm` settle and Solid write what follows it. */
async function settle() {
  await vi.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("ConfirmLinkPage — only a press confirms", () => {
  it("never calls onConfirm on mount, on a prop change, or as time passes", async () => {
    const first = vi.fn<() => Promise<ConfirmOutcome>>();
    const second = vi.fn<() => Promise<ConfirmOutcome>>();
    const [purpose, setPurpose] = createSignal<ConfirmLinkPurpose>("sign-up");
    const [email, setEmail] = createSignal<string | undefined>(EMAIL);
    const [onConfirm, setOnConfirm] = createSignal<() => Promise<ConfirmOutcome>>(first);
    const [onContinue, setOnContinue] = createSignal<(() => void) | undefined>(undefined);
    render(() => (
      <ConfirmLinkPage
        purpose={purpose()}
        email={email()}
        onConfirm={onConfirm()}
        onContinue={onContinue()}
      />
    ));

    await settle();
    setPurpose("recovery");
    setEmail(undefined);
    setOnConfirm(() => second);
    setOnContinue(() => () => {});
    await vi.advanceTimersByTimeAsync(60_000);

    expect(first).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();
    expect(confirmButton().textContent).toBe("Confirm");
  });

  it("calls onConfirm once however often it is pressed, and disables itself while it runs", () => {
    const pending = deferred<ConfirmOutcome>();
    const onConfirm = vi.fn(() => pending.promise);
    render(() => <ConfirmLinkPage purpose="sign-up" email={EMAIL} onConfirm={onConfirm} />);

    fireEvent.click(confirmButton());
    fireEvent.click(confirmButton());
    fireEvent.click(confirmButton());

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(confirmButton().disabled).toBe(true);
    expect(confirmButton().textContent).toBe("Confirming…");
  });
});

describe("ConfirmLinkPage — what each answer shows", () => {
  it("shows the expired page with no button to try again", async () => {
    const onConfirm = vi.fn(() => Promise.resolve<ConfirmOutcome>("expired"));
    render(() => <ConfirmLinkPage purpose="sign-up" email={EMAIL} onConfirm={onConfirm} />);

    fireEvent.click(confirmButton());
    await settle();

    expect(heading().textContent).toBe("This link no longer works");
    expect(paragraph(EXPIRED_BODY)).not.toBeNull();
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("turns a thrown error into a fixed line and a Try again that calls again, never showing the error's own text", async () => {
    const retry = deferred<ConfirmOutcome>();
    const onConfirm = vi
      .fn<() => Promise<ConfirmOutcome>>()
      .mockRejectedValueOnce(new Error("Failed to fetch"))
      .mockReturnValueOnce(retry.promise);
    const { container } = render(() => (
      <ConfirmLinkPage purpose="sign-up" email={EMAIL} onConfirm={onConfirm} />
    ));

    fireEvent.click(confirmButton());
    await settle();

    expect(heading().textContent).toBe("Confirm this email");
    expect(shown(ERROR_LINE)).toHaveLength(1);
    expect(announcer(container).textContent).toBe(ERROR_LINE);
    expect(container.textContent).not.toContain("Failed to fetch");
    expect(confirmButton().textContent).toBe("Try again");
    expect(confirmButton().disabled).toBe(false);

    fireEvent.click(confirmButton());
    expect(onConfirm).toHaveBeenCalledTimes(2);
    expect(shown(ERROR_LINE)).toHaveLength(0);

    retry.resolve("confirmed");
    await settle();
    expect(heading().textContent).toBe("Confirmed");
  });

  it("treats an onConfirm that throws before returning a promise as an error", async () => {
    const onConfirm = vi.fn((): Promise<ConfirmOutcome> => {
      throw new Error("no client");
    });
    render(() => <ConfirmLinkPage purpose="sign-up" email={EMAIL} onConfirm={onConfirm} />);

    fireEvent.click(confirmButton());
    await settle();

    expect(shown(ERROR_LINE)).toHaveLength(1);
    expect(confirmButton().textContent).toBe("Try again");
    expect(confirmButton().disabled).toBe(false);
  });

  it("treats an answer that is neither outcome as an error", async () => {
    // A host's async function with a missing `return` resolves `undefined`.
    const onConfirm = vi.fn(() => Promise.resolve(undefined as unknown as ConfirmOutcome));
    render(() => <ConfirmLinkPage purpose="sign-up" email={EMAIL} onConfirm={onConfirm} />);

    fireEvent.click(confirmButton());
    await settle();

    expect(shown(ERROR_LINE)).toHaveLength(1);
    expect(confirmButton().textContent).toBe("Try again");
  });

  it("sends the person back to where they started, and offers Continue only when the host can continue here", async () => {
    const onContinue = vi.fn();
    render(() => (
      <>
        <section aria-label="elsewhere">
          <ConfirmLinkPage
            purpose="sign-up"
            email={EMAIL}
            onConfirm={() => Promise.resolve<ConfirmOutcome>("confirmed")}
          />
        </section>
        <section aria-label="here">
          <ConfirmLinkPage
            purpose="sign-up"
            email={EMAIL}
            onConfirm={() => Promise.resolve<ConfirmOutcome>("confirmed")}
            onContinue={onContinue}
          />
        </section>
      </>
    ));

    for (const button of screen.getAllByRole("button", { name: "Confirm" })) {
      fireEvent.click(button);
    }
    await settle();

    const [elsewhere, here] = screen.getAllByRole("region");
    expect(elsewhere?.querySelector("h1")?.textContent).toBe("Confirmed");
    expect(elsewhere?.textContent).toContain(
      "Go back to where you started to finish signing up. You can close this page.",
    );
    expect(elsewhere?.querySelectorAll("button")).toHaveLength(0);

    expect(here?.querySelector("h1")?.textContent).toBe("Confirmed");
    expect(here?.textContent).toContain("Continue to finish signing up.");
    expect(here?.textContent).not.toContain("Go back");
    const buttons = here?.querySelectorAll("button") ?? [];
    expect(buttons).toHaveLength(1);
    expect(buttons[0]?.textContent).toBe("Continue");

    fireEvent.click(buttons[0] as HTMLElement);
    expect(onContinue).toHaveBeenCalledTimes(1);
    expect(queryConfirmButton()).toBeNull();
  });
});

describe("ConfirmLinkPage — the words for each flow", () => {
  const FLOWS: [ConfirmLinkPurpose, string, string, string][] = [
    [
      "sign-up",
      `Confirming lets the device that asked finish signing up with ${EMAIL}.`,
      "If you didn't, close this page and nothing will change.",
      "finish signing up",
    ],
    [
      "recovery",
      "Confirming lets the device that asked back into your account. It also signs out every other device.",
      "If you didn't, close this page and nothing will change.",
      "get back into your account",
    ],
    [
      "step-up",
      "Confirming lets the device that asked go ahead with something sensitive, such as adding a passkey or deleting the account.",
      "If you didn't, someone else may be signed in to your account. Close this page and sign out your other sessions.",
      "finish what you were doing",
    ],
    [
      "email-change",
      `Confirming sets ${EMAIL} as the email of the account that asked.`,
      "If you didn't, close this page and nothing will change.",
      "finish changing your email",
    ],
  ];

  it.each(FLOWS)(
    "%s says what confirming lets the asking device do, and what to do if you did not ask",
    async (purpose, ready, ifNot, finish) => {
      render(() => (
        <ConfirmLinkPage
          purpose={purpose}
          email={EMAIL}
          onConfirm={() => Promise.resolve<ConfirmOutcome>("confirmed")}
        />
      ));

      expect(heading().textContent).toBe("Confirm this email");
      expect(paragraph(ready)).not.toBeNull();
      expect(paragraph(`Only confirm if you asked for this. ${ifNot}`)).not.toBeNull();
      const others = FLOWS.filter(([other]) => other !== purpose).map(([, line]) => line);
      expect(others).toHaveLength(3);
      for (const line of others) expect(paragraph(line)).toBeNull();

      fireEvent.click(confirmButton());
      await settle();

      expect(
        paragraph(`Go back to where you started to ${finish}. You can close this page.`),
      ).not.toBeNull();
    },
  );

  it("says 'this address' when it is given none", () => {
    render(() => (
      <>
        <ConfirmLinkPage purpose="sign-up" onConfirm={() => new Promise(() => {})} />
        <ConfirmLinkPage purpose="email-change" onConfirm={() => new Promise(() => {})} />
      </>
    ));

    expect(
      paragraph("Confirming lets the device that asked finish signing up with this address."),
    ).not.toBeNull();
    expect(
      paragraph("Confirming sets this address as the email of the account that asked."),
    ).not.toBeNull();
  });
});

describe("ConfirmLinkPage — focus and what is said aloud", () => {
  it("puts focus on its heading on mount and when the press disables the focused button", () => {
    render(() => (
      <ConfirmLinkPage purpose="sign-up" email={EMAIL} onConfirm={() => new Promise(() => {})} />
    ));

    // A heading with no tabindex cannot take focus in a browser, though
    // happy-dom lets it: the attribute is half of the guarantee.
    expect(heading().getAttribute("tabindex")).toBe("-1");
    expect(document.activeElement).toBe(heading());

    confirmButton().focus();
    expect(document.activeElement).toBe(confirmButton());
    fireEvent.click(confirmButton());
    expect(confirmButton().disabled).toBe(true);
    expect(document.activeElement).toBe(heading());
  });

  it.each([
    ["confirmed", "Confirmed"],
    ["expired", "This link no longer works"],
    ["error", "Confirm this email"],
  ] as const)(
    "brings focus back to the heading when the answer is %s, wherever it was moved meanwhile",
    async (answer, title) => {
      const pending = deferred<ConfirmOutcome>();
      render(() => (
        <>
          <button type="button">elsewhere</button>
          <ConfirmLinkPage purpose="sign-up" email={EMAIL} onConfirm={() => pending.promise} />
        </>
      ));

      fireEvent.click(confirmButton());
      const elsewhere = screen.getByRole("button", { name: "elsewhere" });
      elsewhere.focus();
      expect(document.activeElement).toBe(elsewhere);

      if (answer === "error") pending.reject(new Error("down"));
      else pending.resolve(answer);
      await settle();

      expect(heading().textContent).toBe(title);
      expect(document.activeElement).toBe(heading());
    },
  );

  it("says each change aloud through one polite region that stays mounted", async () => {
    const first = deferred<ConfirmOutcome>();
    const second = deferred<ConfirmOutcome>();
    const third = deferred<ConfirmOutcome>();
    const onConfirm = vi
      .fn<() => Promise<ConfirmOutcome>>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const { container } = render(() => (
      <ConfirmLinkPage purpose="sign-up" email={EMAIL} onConfirm={onConfirm} />
    ));

    const region = announcer(container);
    expect(region.getAttribute("aria-live")).toBe("polite");
    expect(region.getAttribute("aria-atomic")).toBe("true");
    expect(region.textContent).toBe("");

    fireEvent.click(confirmButton());
    expect(announcer(container)).toBe(region);
    expect(region.textContent).toBe("Confirming…");

    first.reject(new Error("down"));
    await settle();
    expect(announcer(container)).toBe(region);
    expect(region.textContent).toBe(ERROR_LINE);

    fireEvent.click(confirmButton());
    expect(region.textContent).toBe("Confirming…");
    second.resolve("expired");
    await settle();
    expect(announcer(container)).toBe(region);
    expect(region.isConnected).toBe(true);
    expect(region.textContent).toBe(`This link no longer works. ${EXPIRED_BODY}`);

    cleanup();
    const again = render(() => (
      <ConfirmLinkPage purpose="recovery" onConfirm={() => third.promise} />
    ));
    const regionAgain = announcer(again.container);
    fireEvent.click(confirmButton());
    third.resolve("confirmed");
    await settle();
    expect(announcer(again.container)).toBe(regionAgain);
    expect(regionAgain.textContent).toBe(
      "Confirmed. Go back to where you started to get back into your account. You can close this page.",
    );
  });

  it("says a slow confirm is still working after 10 s, and stops saying it once the answer comes", async () => {
    // Both answers are errors, because the error page keeps the lines the slow
    // one sits among: it must leave them by itself, not with the page.
    const slow = deferred<ConfirmOutcome>();
    const quick = deferred<ConfirmOutcome>();
    const onConfirm = vi
      .fn<() => Promise<ConfirmOutcome>>()
      .mockReturnValueOnce(slow.promise)
      .mockReturnValueOnce(quick.promise);
    const { container } = render(() => (
      <ConfirmLinkPage purpose="sign-up" email={EMAIL} onConfirm={onConfirm} />
    ));

    fireEvent.click(confirmButton());
    await vi.advanceTimersByTimeAsync(9_999);
    expect(paragraph(SLOW_LINE)).toBeNull();
    expect(announcer(container).textContent).toBe("Confirming…");

    await vi.advanceTimersByTimeAsync(1);
    expect(paragraph(SLOW_LINE)).not.toBeNull();
    expect(announcer(container).textContent).toBe(SLOW_LINE);

    slow.reject(new Error("down"));
    await settle();
    expect(paragraph(SLOW_LINE)).toBeNull();

    // An answer inside the 10 s: the line never comes, then or later.
    fireEvent.click(confirmButton());
    await vi.advanceTimersByTimeAsync(5_000);
    quick.reject(new Error("down"));
    await settle();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(paragraph(SLOW_LINE)).toBeNull();
  });

  it("stops its timer when it unmounts mid-confirm", () => {
    const { unmount } = render(() => (
      <ConfirmLinkPage purpose="sign-up" email={EMAIL} onConfirm={() => new Promise(() => {})} />
    ));

    fireEvent.click(confirmButton());
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("ConfirmLinkPage — around the page", () => {
  it("submits no form it sits inside", async () => {
    const onSubmit = vi.fn((e: SubmitEvent) => e.preventDefault());
    render(() => (
      <form onSubmit={onSubmit}>
        <ConfirmLinkPage
          purpose="sign-up"
          email={EMAIL}
          onConfirm={() => Promise.resolve<ConfirmOutcome>("confirmed")}
          onContinue={() => {}}
        />
      </form>
    ));

    fireEvent.click(confirmButton());
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("writes nothing to the console across a whole run, an unmount mid-confirm included", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => {}),
    );
    const late = deferred<ConfirmOutcome>();
    const onConfirm = vi
      .fn<() => Promise<ConfirmOutcome>>()
      .mockRejectedValueOnce(new Error("down"))
      .mockReturnValueOnce(late.promise);
    const { unmount } = render(() => (
      <ConfirmLinkPage
        purpose="recovery"
        email={EMAIL}
        onConfirm={onConfirm}
        onContinue={() => {}}
      />
    ));

    fireEvent.click(confirmButton());
    await settle();
    fireEvent.click(confirmButton());
    await vi.advanceTimersByTimeAsync(12_000);
    unmount();
    late.resolve("confirmed");
    await settle();

    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
});
