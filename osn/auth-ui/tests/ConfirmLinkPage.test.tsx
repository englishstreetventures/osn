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
 * The page an emailed link opens. The host reads the link and the numbers to
 * pick from, and makes the confirm call; what is covered here is what the page
 * alone decides: that it never confirms without a tap, sends the number tapped
 * once, draws the numbers as given, refuses a set it cannot offer, what each
 * answer shows and says aloud, where focus goes, and that its one timer dies
 * with it.
 *
 * Fake timers throughout, so the slow-confirm line can be stepped.
 */

const EMAIL = "ada@example.com";

const CANDIDATES = ["4821", "0730", "1956"] as const;

const PICK_LINE = "Pick the number shown on the screen where you started.";
const ERROR_LINE = "We couldn't confirm this email just now.";
const SLOW_LINE = "This is taking longer than usual. Keep this page open.";
const EXPIRED_HEADING = "This link no longer works";
const EXPIRED_BODY =
  "It has expired or was already used. If you confirmed it already, go back to where you started and carry on. If not, go back and ask for a new link.";

type OnConfirm = (pick: string | null) => Promise<ConfirmOutcome>;

function candidate(number: string): HTMLButtonElement {
  return screen.getByRole("button", { name: number }) as HTMLButtonElement;
}

function candidates(): HTMLButtonElement[] {
  const group = screen.queryByRole("group");
  return group ? ([...group.querySelectorAll("button")] as HTMLButtonElement[]) : [];
}

function decline(): HTMLButtonElement {
  return screen.getByRole("button", { name: "I didn't ask for this" }) as HTMLButtonElement;
}

function tryAgain(): HTMLButtonElement {
  return screen.getByRole("button", { name: "Try again" }) as HTMLButtonElement;
}

function heading(): HTMLElement {
  return screen.getByRole("heading", { level: 1 });
}

/**
 * A paragraph on the page that reads `text` in full, a number or an address
 * inside it included. The spoken `<output>` repeats some lines, and is not a
 * paragraph.
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

function page(onConfirm: OnConfirm, extra: { purpose?: ConfirmLinkPurpose } = {}) {
  return render(() => (
    <ConfirmLinkPage
      purpose={extra.purpose ?? "sign-up"}
      email={EMAIL}
      candidates={[...CANDIDATES]}
      onConfirm={onConfirm}
    />
  ));
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("ConfirmLinkPage — only a tap confirms", () => {
  it("never calls onConfirm on mount, on a prop change, or as time passes", async () => {
    const first = vi.fn<OnConfirm>();
    const second = vi.fn<OnConfirm>();
    const [purpose, setPurpose] = createSignal<ConfirmLinkPurpose>("sign-up");
    const [email, setEmail] = createSignal<string | undefined>(EMAIL);
    const [set, setSet] = createSignal<string[]>([...CANDIDATES]);
    const [onConfirm, setOnConfirm] = createSignal<OnConfirm>(first);
    const [onContinue, setOnContinue] = createSignal<(() => void) | undefined>(undefined);
    render(() => (
      <ConfirmLinkPage
        purpose={purpose()}
        email={email()}
        candidates={set()}
        onConfirm={onConfirm()}
        onContinue={onContinue()}
      />
    ));

    await settle();
    setPurpose("recovery");
    setEmail(undefined);
    setSet(["12", "34", "56", "78"]);
    setOnConfirm(() => second);
    setOnContinue(() => () => {});
    await vi.advanceTimersByTimeAsync(60_000);

    expect(first).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();
    expect(candidates().map((b) => b.textContent)).toEqual(["12", "34", "56", "78"]);
    expect(candidates().every((b) => !b.disabled)).toBe(true);
  });

  it("sends exactly the number tapped, once, and disables every number while it runs", () => {
    const pending = deferred<ConfirmOutcome>();
    const onConfirm = vi.fn<OnConfirm>(() => pending.promise);
    page(onConfirm);

    fireEvent.click(candidate("0730"));
    fireEvent.click(candidate("0730"));
    fireEvent.click(candidate("4821"));
    fireEvent.click(candidate("1956"));

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledWith("0730");
    expect(candidates()).toHaveLength(3);
    for (const button of candidates()) expect(button.disabled).toBe(true);
    expect(decline().disabled).toBe(true);
    fireEvent.click(decline());
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(paragraph("You picked 0730. Confirming…")).not.toBeNull();
  });
});

describe("ConfirmLinkPage — the numbers", () => {
  it("draws the numbers as given: in order, as written, under the instruction", () => {
    const given = ["007", "0", "999999", "41", "5"];
    render(() => (
      <ConfirmLinkPage
        purpose="sign-up"
        email={EMAIL}
        candidates={given}
        onConfirm={() => new Promise(() => {})}
      />
    ));

    expect(candidates().map((b) => b.textContent)).toEqual(given);
    const group = screen.getByRole("group", { name: PICK_LINE });
    expect(group.querySelectorAll("button")).toHaveLength(5);
  });

  it("keeps the numbers, and the number picked, out of the browser's page translation", () => {
    page(() => new Promise(() => {}));

    for (const number of CANDIDATES) {
      expect(screen.getByText(number).getAttribute("translate")).toBe("no");
    }
    fireEvent.click(candidate("1956"));
    const line = paragraph("You picked 1956. Confirming…");
    expect(line?.querySelector("[translate='no']")?.textContent).toBe("1956");
  });

  it.each([
    ["no numbers", []],
    ["two numbers", ["12", "34"]],
    ["six numbers", ["1", "2", "3", "4", "5", "6"]],
    ["a number twice", ["12", "34", "12"]],
    ["a letter", ["12", "34", "12a"]],
    ["seven digits", ["12", "34", "1234567"]],
    ["an empty string", ["12", "34", ""]],
    ["a non-ASCII digit", ["12", "34", "١٢"]],
  ])("shows the expired page, and asks for nothing, when given %s", async (_, given) => {
    const onConfirm = vi.fn<OnConfirm>();
    const { container } = render(() => (
      <ConfirmLinkPage purpose="sign-up" email={EMAIL} candidates={given} onConfirm={onConfirm} />
    ));
    await settle();

    expect(heading().textContent).toBe(EXPIRED_HEADING);
    expect(paragraph(EXPIRED_BODY)).not.toBeNull();
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(screen.queryByRole("group")).toBeNull();
    expect(announcer(container).textContent).toBe("");
    expect(onConfirm).not.toHaveBeenCalled();
  });
});

describe("ConfirmLinkPage — what each answer shows", () => {
  it("shows a refused pick exactly as it shows a set it cannot offer, with nothing to try again", async () => {
    const onConfirm = vi.fn<OnConfirm>(() => Promise.resolve<ConfirmOutcome>("expired"));
    const picked = page(onConfirm);
    fireEvent.click(candidate("4821"));
    await settle();

    expect(heading().textContent).toBe(EXPIRED_HEADING);
    expect(paragraph(EXPIRED_BODY)).not.toBeNull();
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(onConfirm).toHaveBeenCalledTimes(1);
    const afterPick = picked.container.querySelector("h1")?.parentElement?.textContent;
    cleanup();

    render(() => (
      <ConfirmLinkPage
        purpose="sign-up"
        email={EMAIL}
        candidates={[]}
        onConfirm={() => new Promise(() => {})}
      />
    ));
    expect(heading().parentElement?.textContent).toBe(afterPick);
  });

  it("never says a pick was wrong, in any state", async () => {
    const WRONG = /wrong|incorrect|match|mistake|didn't pick|not the number/i;
    const answers: (ConfirmOutcome | "throws")[] = ["throws", "expired", "confirmed"];
    for (const answer of answers) {
      const pending = deferred<ConfirmOutcome>();
      const { container } = page(() => pending.promise);
      expect(container.textContent).not.toMatch(WRONG);
      fireEvent.click(candidate("0730"));
      expect(container.textContent).not.toMatch(WRONG);
      if (answer === "throws") pending.reject(new Error("wrong number"));
      else pending.resolve(answer);
      await settle();
      expect(container.textContent).not.toMatch(WRONG);
      cleanup();
    }
  });

  it("turns a thrown error into a fixed line and a Try again that sends the same number, never showing the error's own text", async () => {
    const retry = deferred<ConfirmOutcome>();
    const onConfirm = vi
      .fn<OnConfirm>()
      .mockRejectedValueOnce(new Error("Failed to fetch"))
      .mockReturnValueOnce(retry.promise);
    const { container } = page(onConfirm);

    fireEvent.click(candidate("1956"));
    await settle();

    expect(heading().textContent).toBe("Confirm this email");
    expect(shown(ERROR_LINE)).toHaveLength(1);
    expect(announcer(container).textContent).toBe(ERROR_LINE);
    expect(container.textContent).not.toContain("Failed to fetch");
    expect(paragraph("You picked 1956.")).not.toBeNull();
    for (const button of candidates()) expect(button.disabled).toBe(true);
    expect(decline().disabled).toBe(true);
    expect(tryAgain().disabled).toBe(false);

    fireEvent.click(candidate("4821"));
    fireEvent.click(decline());
    expect(onConfirm).toHaveBeenCalledTimes(1);

    fireEvent.click(tryAgain());
    expect(onConfirm).toHaveBeenCalledTimes(2);
    expect(onConfirm).toHaveBeenLastCalledWith("1956");
    expect(shown(ERROR_LINE)).toHaveLength(0);

    retry.resolve("confirmed");
    await settle();
    expect(heading().textContent).toBe("Confirmed");
  });

  it("treats an onConfirm that throws before returning a promise as an error", async () => {
    const onConfirm = vi.fn<OnConfirm>(() => {
      throw new Error("no client");
    });
    page(onConfirm);

    fireEvent.click(candidate("4821"));
    await settle();

    expect(shown(ERROR_LINE)).toHaveLength(1);
    expect(tryAgain().disabled).toBe(false);
  });

  // A host's async function with a missing `return` resolves `undefined`; one
  // typed through `any` can resolve a truthy value such as a `Response`.
  it.each([undefined, "ok", true])(
    "treats an answer that is neither outcome (%s) as an error",
    async (answer) => {
      page(() => Promise.resolve(answer as unknown as ConfirmOutcome));

      fireEvent.click(candidate("4821"));
      await settle();

      expect(shown(ERROR_LINE)).toHaveLength(1);
      expect(tryAgain().disabled).toBe(false);
    },
  );

  it("sends the person back to where they started, and offers Continue only when the host can continue here", async () => {
    const onContinue = vi.fn();
    render(() => (
      <>
        <section aria-label="elsewhere">
          <ConfirmLinkPage
            purpose="sign-up"
            email={EMAIL}
            candidates={[...CANDIDATES]}
            onConfirm={() => Promise.resolve<ConfirmOutcome>("confirmed")}
          />
        </section>
        <section aria-label="here">
          <ConfirmLinkPage
            purpose="sign-up"
            email={EMAIL}
            candidates={["11", "22", "33"]}
            onConfirm={() => Promise.resolve<ConfirmOutcome>("confirmed")}
            onContinue={onContinue}
          />
        </section>
      </>
    ));

    fireEvent.click(candidate("4821"));
    fireEvent.click(candidate("22"));
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
    expect(screen.queryByRole("group")).toBeNull();
  });
});

describe("ConfirmLinkPage — I didn't ask for this", () => {
  it("sends no number, once, and disables every choice while it runs", () => {
    const pending = deferred<ConfirmOutcome>();
    const onConfirm = vi.fn<OnConfirm>(() => pending.promise);
    const { container } = page(onConfirm);

    expect(decline().getAttribute("type")).toBe("button");
    fireEvent.click(decline());
    fireEvent.click(decline());
    fireEvent.click(candidate("4821"));

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledWith(null);
    expect(decline().disabled).toBe(true);
    for (const button of candidates()) expect(button.disabled).toBe(true);
    expect(paragraph("Cancelling…")).not.toBeNull();
    expect(announcer(container).textContent).toBe("Cancelling…");
    expect(container.textContent).not.toContain("You picked");
  });

  it.each([
    ["sign-up", "Nothing was confirmed. You can close this page."],
    [
      "step-up",
      "Nothing was confirmed. Someone else may be signed in to your account, so sign out your other sessions.",
    ],
  ] as const)("shows %s's declined page, with nothing more to press", async (purpose, body) => {
    const { container } = page(() => Promise.resolve<ConfirmOutcome>("declined"), { purpose });

    fireEvent.click(decline());
    await settle();

    expect(heading().textContent).toBe("Cancelled");
    expect(paragraph(body)).not.toBeNull();
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(announcer(container).textContent).toBe(`Cancelled. ${body}`);
    expect(document.activeElement).toBe(heading());
  });

  it.each([
    ["a decline answered confirmed", null, "confirmed"],
    ["a number answered declined", "4821", "declined"],
  ] as const)("treats %s as an error, never as that answer", async (_, attempt, answer) => {
    const onConfirm = vi.fn<OnConfirm>(() => Promise.resolve<ConfirmOutcome>(answer));
    const { container } = page(onConfirm);

    fireEvent.click(attempt === null ? decline() : candidate(attempt));
    await settle();

    expect(heading().textContent).toBe("Confirm this email");
    expect(container.textContent).not.toContain("Cancelled");
    expect(container.textContent).not.toContain("Confirmed");
    expect(tryAgain().disabled).toBe(false);
  });

  it("turns a thrown decline into its own line, and a Try again that sends no number again", async () => {
    const retry = deferred<ConfirmOutcome>();
    const onConfirm = vi
      .fn<OnConfirm>()
      .mockRejectedValueOnce(new Error("down"))
      .mockReturnValueOnce(retry.promise);
    const { container } = page(onConfirm);

    fireEvent.click(decline());
    await settle();

    expect(shown("We couldn't cancel this just now.")).toHaveLength(1);
    expect(announcer(container).textContent).toBe("We couldn't cancel this just now.");
    expect(shown(ERROR_LINE)).toHaveLength(0);
    expect(decline().disabled).toBe(true);

    fireEvent.click(tryAgain());
    expect(onConfirm).toHaveBeenCalledTimes(2);
    expect(onConfirm).toHaveBeenLastCalledWith(null);

    retry.resolve("declined");
    await settle();
    expect(heading().textContent).toBe("Cancelled");
  });

  it("shows a refused decline exactly as any other refusal", async () => {
    page(() => Promise.resolve<ConfirmOutcome>("expired"));
    fireEvent.click(decline());
    await settle();
    const afterDecline = heading().parentElement?.textContent;
    cleanup();

    page(() => Promise.resolve<ConfirmOutcome>("expired"));
    fireEvent.click(candidate("0730"));
    await settle();
    expect(heading().parentElement?.textContent).toBe(afterDecline);
    expect(heading().textContent).toBe(EXPIRED_HEADING);
  });
});

describe("ConfirmLinkPage — opening on an answer", () => {
  it.each([
    ["confirmed", "Confirmed", "Continue to finish signing up.", ["Continue"]],
    ["expired", EXPIRED_HEADING, EXPIRED_BODY, []],
  ] as const)(
    "opens on %s with no numbers, and calls nothing",
    async (opening, title, body, labels) => {
      const onConfirm = vi.fn<OnConfirm>();
      const onContinue = vi.fn();
      const { container } = render(() => (
        <ConfirmLinkPage
          purpose="sign-up"
          initialOutcome={opening}
          onConfirm={onConfirm}
          onContinue={onContinue}
        />
      ));
      await vi.advanceTimersByTimeAsync(60_000);

      expect(heading().textContent).toBe(title);
      expect(paragraph(body)).not.toBeNull();
      expect(document.activeElement).toBe(heading());
      expect(screen.queryByRole("group")).toBeNull();
      expect(announcer(container).textContent).toBe("");
      expect(onConfirm).not.toHaveBeenCalled();
      const buttons = screen.queryAllByRole("button");
      expect(buttons.map((b) => b.textContent)).toEqual(labels);
      for (const button of buttons) fireEvent.click(button);
      expect(onContinue).toHaveBeenCalledTimes(labels.length);
    },
  );

  it("will not type-check with neither numbers nor an opening answer", () => {
    render(() => (
      // @ts-expect-error -- a page needs `candidates`, or `initialOutcome` in their place.
      <ConfirmLinkPage purpose="sign-up" onConfirm={() => new Promise(() => {})} />
    ));
    expect(heading().textContent).toBe(EXPIRED_HEADING);
  });

  it("ignores an opening answer it does not know, and shows the expired page", () => {
    const onConfirm = vi.fn<OnConfirm>();
    render(() => (
      <ConfirmLinkPage
        purpose="sign-up"
        initialOutcome={"declined" as "expired"}
        onConfirm={onConfirm}
      />
    ));

    expect(heading().textContent).toBe(EXPIRED_HEADING);
    expect(paragraph(EXPIRED_BODY)).not.toBeNull();
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });
});

describe("ConfirmLinkPage — the words for each flow", () => {
  const FLOWS: [ConfirmLinkPurpose, string, string, string][] = [
    [
      "sign-up",
      `Confirming lets the device that asked finish signing up with ${EMAIL}.`,
      "If you didn't, choose “I didn't ask for this” below.",
      "finish signing up",
    ],
    [
      "recovery",
      "Confirming lets the device that asked back into your account. It also signs out every other device.",
      "If you didn't, choose “I didn't ask for this” below.",
      "get back into your account",
    ],
    [
      "step-up",
      "Confirming lets the device that asked go ahead with something sensitive, such as adding a passkey or deleting the account.",
      "If you didn't, someone else may be signed in to your account. Choose “I didn't ask for this” below, then sign out your other sessions.",
      "finish what you were doing",
    ],
    [
      "email-change",
      `Confirming sets ${EMAIL} as the email of the account that asked.`,
      "If you didn't, choose “I didn't ask for this” below.",
      "finish changing your email",
    ],
  ];

  it.each(FLOWS)(
    "%s says what confirming lets the asking device do, and what to do if you did not ask",
    async (purpose, ready, ifNot, finish) => {
      page(() => Promise.resolve<ConfirmOutcome>("confirmed"), { purpose });

      expect(heading().textContent).toBe("Confirm this email");
      expect(paragraph(ready)).not.toBeNull();
      expect(paragraph(`Only confirm if you asked for this. ${ifNot}`)).not.toBeNull();
      const others = FLOWS.filter(([other]) => other !== purpose).map(([, line]) => line);
      expect(others).toHaveLength(3);
      for (const line of others) expect(paragraph(line)).toBeNull();

      fireEvent.click(candidate("4821"));
      await settle();

      expect(
        paragraph(`Go back to where you started to ${finish}. You can close this page.`),
      ).not.toBeNull();
    },
  );

  it("says 'this address' when it is given none", () => {
    render(() => (
      <>
        <ConfirmLinkPage
          purpose="sign-up"
          candidates={[...CANDIDATES]}
          onConfirm={() => new Promise(() => {})}
        />
        <ConfirmLinkPage
          purpose="email-change"
          candidates={[...CANDIDATES]}
          onConfirm={() => new Promise(() => {})}
        />
      </>
    ));

    expect(
      paragraph("Confirming lets the device that asked finish signing up with this address."),
    ).not.toBeNull();
    expect(
      paragraph("Confirming sets this address as the email of the account that asked."),
    ).not.toBeNull();
  });

  it.each(["sign-up", "email-change"] as const)(
    "%s keeps the address out of the browser's page translation",
    (purpose) => {
      page(() => new Promise(() => {}), { purpose });

      expect(screen.getByText(EMAIL).getAttribute("translate")).toBe("no");
    },
  );
});

describe("ConfirmLinkPage — focus and what is said aloud", () => {
  it("puts focus on its heading on mount and when the tap disables the focused number", () => {
    page(() => new Promise(() => {}));

    // A heading with no tabindex cannot take focus in a browser, though
    // happy-dom lets it: the attribute is half of the guarantee.
    expect(heading().getAttribute("tabindex")).toBe("-1");
    expect(document.activeElement).toBe(heading());

    candidate("0730").focus();
    expect(document.activeElement).toBe(candidate("0730"));
    fireEvent.click(candidate("0730"));
    expect(candidate("0730").disabled).toBe(true);
    expect(document.activeElement).toBe(heading());
  });

  it.each([
    ["confirmed", "Confirmed"],
    ["expired", EXPIRED_HEADING],
    ["error", "Confirm this email"],
  ] as const)(
    "brings focus back to the heading when the answer is %s, wherever it was moved meanwhile",
    async (answer, title) => {
      const pending = deferred<ConfirmOutcome>();
      render(() => (
        <>
          <button type="button">elsewhere</button>
          <ConfirmLinkPage
            purpose="sign-up"
            email={EMAIL}
            candidates={[...CANDIDATES]}
            onConfirm={() => pending.promise}
          />
        </>
      ));

      fireEvent.click(candidate("4821"));
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
      .fn<OnConfirm>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const { container } = page(onConfirm);

    const region = announcer(container);
    expect(region.getAttribute("aria-live")).toBe("polite");
    expect(region.getAttribute("aria-atomic")).toBe("true");
    expect(region.textContent).toBe("");

    fireEvent.click(candidate("4821"));
    expect(announcer(container)).toBe(region);
    expect(region.textContent).toBe("Confirming…");

    first.reject(new Error("down"));
    await settle();
    expect(announcer(container)).toBe(region);
    expect(region.textContent).toBe(ERROR_LINE);

    fireEvent.click(tryAgain());
    expect(region.textContent).toBe("Confirming…");
    second.resolve("expired");
    await settle();
    expect(announcer(container)).toBe(region);
    expect(region.isConnected).toBe(true);
    expect(region.textContent).toBe(`${EXPIRED_HEADING}. ${EXPIRED_BODY}`);

    cleanup();
    const again = render(() => (
      <ConfirmLinkPage
        purpose="recovery"
        candidates={[...CANDIDATES]}
        onConfirm={() => third.promise}
      />
    ));
    const regionAgain = announcer(again.container);
    fireEvent.click(candidate("1956"));
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
      .fn<OnConfirm>()
      .mockReturnValueOnce(slow.promise)
      .mockReturnValueOnce(quick.promise);
    const { container } = page(onConfirm);

    fireEvent.click(candidate("4821"));
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
    fireEvent.click(tryAgain());
    await vi.advanceTimersByTimeAsync(5_000);
    quick.reject(new Error("down"));
    await settle();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(paragraph(SLOW_LINE)).toBeNull();
  });

  it("stops its timer when it unmounts mid-confirm", () => {
    const { unmount } = page(() => new Promise(() => {}));

    fireEvent.click(candidate("4821"));
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("ConfirmLinkPage — around the page", () => {
  it("submits no form it sits inside", async () => {
    const onSubmit = vi.fn((e: SubmitEvent) => e.preventDefault());
    const onConfirm = vi
      .fn<OnConfirm>()
      .mockRejectedValueOnce(new Error("down"))
      .mockResolvedValueOnce("confirmed");
    render(() => (
      <form onSubmit={onSubmit}>
        <ConfirmLinkPage
          purpose="sign-up"
          email={EMAIL}
          candidates={[...CANDIDATES]}
          onConfirm={onConfirm}
          onContinue={() => {}}
        />
      </form>
    ));

    fireEvent.click(candidate("4821"));
    await settle();
    fireEvent.click(tryAgain());
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    cleanup();
    render(() => (
      <form onSubmit={onSubmit}>
        <ConfirmLinkPage
          purpose="sign-up"
          candidates={[...CANDIDATES]}
          onConfirm={() => Promise.resolve<ConfirmOutcome>("declined")}
        />
      </form>
    ));
    fireEvent.click(decline());
    await settle();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("writes nothing to the console across a whole run, an unmount mid-confirm included", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => {}),
    );
    const late = deferred<ConfirmOutcome>();
    const onConfirm = vi
      .fn<OnConfirm>()
      .mockRejectedValueOnce(new Error("down"))
      .mockReturnValueOnce(late.promise);
    const { unmount } = render(() => (
      <ConfirmLinkPage
        purpose="recovery"
        email={EMAIL}
        candidates={[...CANDIDATES]}
        onConfirm={onConfirm}
        onContinue={() => {}}
      />
    ));

    fireEvent.click(candidate("4821"));
    await settle();
    fireEvent.click(tryAgain());
    await vi.advanceTimersByTimeAsync(12_000);
    unmount();
    late.resolve("confirmed");
    await settle();

    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
});
