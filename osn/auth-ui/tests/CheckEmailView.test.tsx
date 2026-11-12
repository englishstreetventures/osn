// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CheckEmailView,
  type CheckEmailPurpose,
  type CheckEmailStatus,
} from "../src/CheckEmailView";

/**
 * The waiting view a flow shows after it emails a link. The parent owns the
 * sending and the status; what is covered here is what the view alone decides:
 * when Resend may be pressed, what the live region says and when, where focus
 * goes, and that its timer lives and dies with it.
 *
 * Fake timers throughout, Date included, so the wait can be stepped and the
 * clock can jump without a tick (a tab left in the background).
 */

const EMAIL = "ada@example.com";

/** The one Resend control, whatever it is called this second. */
function resend(): HTMLButtonElement {
  return screen.getByRole("button", {
    name: /^(Resend|Sending|Send a new link)/,
  }) as HTMLButtonElement;
}

function region(): HTMLElement {
  return screen.getByRole("status");
}

function heading(): HTMLElement {
  return screen.getByRole("heading", { level: 3 });
}

/** The error line, an alert of its own; absent when there is none. */
function errorLine(): HTMLElement | null {
  return screen.queryByRole("alert");
}

function deferred() {
  let resolve!: () => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Lets an awaited `onResend` settle and Solid write what follows it. */
async function settle() {
  await vi.advanceTimersByTimeAsync(0);
}

const CAPTION = "Pick this number on the page the link opens.";

/** The paragraph that draws the number, found by all of its text. */
function numberParagraph(code: string): HTMLParagraphElement | undefined {
  return Array.from(document.querySelectorAll("p")).find(
    (p) => p.textContent === `Your number: ${code}`,
  );
}

/** Every attribute in the document whose value holds `value`, as `TAG[name]`. */
function attributesHolding(value: string): string[] {
  const hits: string[] = [];
  for (const element of document.querySelectorAll("*")) {
    for (const attribute of element.attributes) {
      if (attribute.value.includes(value)) hits.push(`${element.tagName}[${attribute.name}]`);
    }
  }
  return hits;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("CheckEmailView — the wait before Resend", () => {
  it("keeps Resend disabled for the default 30 s, showing the seconds left, then enables it", () => {
    render(() => (
      <CheckEmailView email={EMAIL} purpose="sign-up" status="waiting" onResend={() => {}} />
    ));

    expect(resend().disabled).toBe(true);
    expect(resend().textContent).toContain("30s");

    // The label is one element, since the button is a flex row that spaces
    // each child of its own. An empty text node takes no room in the row.
    const shown = Array.from(resend().childNodes).filter(
      (node) => node.nodeType !== Node.TEXT_NODE || node.textContent !== "",
    );
    expect(shown).toHaveLength(1);
    expect(shown[0]?.nodeType).toBe(Node.ELEMENT_NODE);
    const seconds = resend().querySelector(".tabular-nums");
    expect(seconds?.textContent).toBe("30");
    expect(seconds?.parentElement).not.toBe(resend());

    vi.advanceTimersByTime(29_000);
    expect(resend().disabled).toBe(true);
    expect(resend().textContent).toContain("1s");

    vi.advanceTimersByTime(1_000);
    expect(resend().disabled).toBe(false);
    expect(resend().textContent).toBe("Resend link");
  });

  it("rounds the time left up, so a late timer never unlocks Resend early", () => {
    render(() => (
      <CheckEmailView email={EMAIL} purpose="sign-up" status="waiting" onResend={() => {}} />
    ));

    // The clock runs 5 ms ahead of the timers, so the last tick lands 995 ms
    // short of the deadline.
    vi.setSystemTime(Date.now() + 5);
    vi.advanceTimersByTime(29_000);
    expect(resend().disabled).toBe(true);
    expect(resend().textContent).toContain("1s");
  });

  it("honours a custom resendWaitSeconds", () => {
    render(() => (
      <CheckEmailView
        email={EMAIL}
        purpose="sign-up"
        status="waiting"
        resendWaitSeconds={5}
        onResend={() => {}}
      />
    ));

    vi.advanceTimersByTime(4_000);
    expect(resend().disabled).toBe(true);
    vi.advanceTimersByTime(1_000);
    expect(resend().disabled).toBe(false);
  });

  it("calls onResend once while a resend is still pending, however often it is clicked", async () => {
    // No wait, so the pending resend is the only thing that can lock the button.
    const pending = deferred();
    const onResend = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue(undefined);
    render(() => (
      <CheckEmailView
        email={EMAIL}
        purpose="sign-up"
        status="waiting"
        resendWaitSeconds={0}
        onResend={onResend}
      />
    ));

    fireEvent.click(resend());
    fireEvent.click(resend());
    fireEvent.click(resend());
    expect(onResend).toHaveBeenCalledTimes(1);

    pending.resolve();
    await settle();
    fireEvent.click(resend());
    expect(onResend).toHaveBeenCalledTimes(2);
  });

  it("marks Resend busy while it sends, keeping focus, and disables Use a different email", async () => {
    const pending = deferred();
    render(() => (
      <CheckEmailView
        email={EMAIL}
        purpose="sign-up"
        status="waiting"
        resendWaitSeconds={0}
        onResend={() => pending.promise}
        onChangeEmail={() => {}}
      />
    ));

    const change = () =>
      screen.getByRole("button", { name: "Use a different email" }) as HTMLButtonElement;
    expect(resend().getAttribute("aria-busy")).toBeNull();
    expect(change().disabled).toBe(false);

    resend().focus();
    fireEvent.click(resend());
    expect(resend().textContent).toBe("Sending…");
    expect(resend().getAttribute("aria-busy")).toBe("true");
    expect(resend().getAttribute("aria-disabled")).toBe("true");
    expect(resend().disabled).toBe(false);
    expect(document.activeElement).toBe(resend());
    expect(change().disabled).toBe(true);

    pending.resolve();
    await settle();
    expect(resend().getAttribute("aria-busy")).toBeNull();
    expect(change().disabled).toBe(false);
  });

  it("starts the wait again after a resend", async () => {
    const onResend = vi.fn().mockResolvedValue(undefined);
    render(() => (
      <CheckEmailView email={EMAIL} purpose="sign-up" status="waiting" onResend={onResend} />
    ));

    vi.advanceTimersByTime(30_000);
    fireEvent.click(resend());
    await settle();
    expect(onResend).toHaveBeenCalledTimes(1);
    expect(resend().disabled).toBe(true);

    vi.advanceTimersByTime(29_000);
    expect(resend().disabled).toBe(true);
    vi.advanceTimersByTime(1_000);
    expect(resend().disabled).toBe(false);
  });

  it("updates the seconds in place, building the label once per wait", () => {
    render(() => (
      <CheckEmailView email={EMAIL} purpose="sign-up" status="waiting" onResend={() => {}} />
    ));

    const label = resend().firstElementChild;
    const seconds = resend().querySelector(".tabular-nums");
    expect(seconds?.textContent).toBe("30");

    vi.advanceTimersByTime(3_000);
    expect(resend().firstElementChild).toBe(label);
    expect(resend().querySelector(".tabular-nums")).toBe(seconds);
    expect(seconds?.textContent).toBe("27");
  });

  it("keeps the countdown out of the live region", () => {
    render(() => (
      <CheckEmailView email={EMAIL} purpose="sign-up" status="waiting" onResend={() => {}} />
    ));

    vi.advanceTimersByTime(3_000);
    expect(resend().textContent).toContain("27s");
    expect(region().textContent).not.toContain("27s");
    expect(region().contains(resend())).toBe(false);
  });

  it("reads the time left from the clock, so a tab back from the background is not behind", () => {
    render(() => (
      <CheckEmailView email={EMAIL} purpose="sign-up" status="waiting" onResend={() => {}} />
    ));

    // The browser held every timer while the tab was hidden: two minutes pass
    // with no tick, then one tick lands.
    vi.setSystemTime(Date.now() + 120_000);
    vi.advanceTimersByTime(1_000);
    expect(resend().disabled).toBe(false);
  });

  it("runs one wait at a time when Resend is pressed while a wait is still running", async () => {
    const [status, setStatus] = createSignal<CheckEmailStatus>("expired");
    const onResend = vi.fn().mockResolvedValue(undefined);
    render(() => (
      <CheckEmailView email={EMAIL} purpose="sign-up" status={status()} onResend={onResend} />
    ));

    vi.advanceTimersByTime(10_000);
    fireEvent.click(resend());
    await settle();
    setStatus("waiting");

    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(29_000);
    expect(resend().disabled).toBe(true);
    vi.advanceTimersByTime(1_000);
    expect(resend().disabled).toBe(false);
  });

  it("treats a wait that is not a number of seconds as no wait", () => {
    render(() => (
      <>
        <CheckEmailView
          email={EMAIL}
          purpose="sign-up"
          status="waiting"
          resendWaitSeconds={Number.NaN}
          onResend={() => {}}
        />
        <CheckEmailView
          email={EMAIL}
          purpose="sign-up"
          status="waiting"
          resendWaitSeconds={-5}
          onResend={() => {}}
        />
      </>
    ));

    const buttons = screen.getAllByRole("button", { name: /^Resend/ }) as HTMLButtonElement[];
    expect(buttons).toHaveLength(2);
    for (const button of buttons) {
      expect(button.disabled).toBe(false);
      expect(button.textContent).toBe("Resend link");
    }
  });

  it("stops its timer when it unmounts", () => {
    const { unmount } = render(() => (
      <CheckEmailView email={EMAIL} purpose="sign-up" status="waiting" onResend={() => {}} />
    ));

    vi.advanceTimersByTime(5_000);
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("CheckEmailView — what the live region says", () => {
  it("says a new link is being sent, then that it was sent, every time, and drops the claim when a resend fails", async () => {
    const first = deferred();
    const second = deferred();
    const third = deferred();
    const onResend = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
      .mockReturnValueOnce(third.promise);
    render(() => (
      <CheckEmailView
        email={EMAIL}
        purpose="sign-up"
        status="waiting"
        resendWaitSeconds={0}
        onResend={onResend}
      />
    ));

    expect(region().textContent).toContain(`We sent a link to ${EMAIL}.`);

    fireEvent.click(resend());
    expect(resend().textContent).toBe("Sending…");
    expect(region().textContent).toContain("Sending a new link…");
    first.resolve();
    await settle();
    expect(region().textContent).toContain(`We sent a new link to ${EMAIL}.`);

    fireEvent.click(resend());
    expect(region().textContent).toContain("Sending a new link…");
    second.resolve();
    await settle();
    expect(region().textContent).toContain(`We sent a new link to ${EMAIL}.`);

    fireEvent.click(resend());
    third.reject(new Error("rate limited"));
    await settle();
    expect(region().textContent).toContain(`We sent a link to ${EMAIL}.`);
    expect(region().textContent).not.toContain("new link");
  });

  it("offers a new link at once when the link has expired, and drops the waiting copy", () => {
    const onResend = vi.fn().mockReturnValue(deferred().promise);
    render(() => (
      <CheckEmailView email={EMAIL} purpose="sign-up" status="expired" onResend={onResend} />
    ));

    expect(heading().textContent).toBe("Your link has expired");
    expect(region().textContent).toContain(`Ask for a new link to ${EMAIL}.`);
    expect(region().textContent).not.toContain("We sent");
    expect(screen.queryByText(/This page will update/)).toBeNull();

    expect(resend().disabled).toBe(false);
    expect(resend().textContent).toBe("Send a new link");
    fireEvent.click(resend());
    expect(onResend).toHaveBeenCalledTimes(1);
    expect(region().textContent).toContain("Sending a new link…");
    expect(region().textContent).not.toContain("Ask for a new link");
  });

  it("shows the error as an alert of its own under the sentence, with a fallback when none is given", () => {
    const [message, setMessage] = createSignal<string | undefined>(
      "Too many requests. Try again later.",
    );
    render(() => (
      <CheckEmailView
        email={EMAIL}
        purpose="sign-up"
        status="error"
        errorMessage={message()}
        onResend={() => {}}
      />
    ));

    expect(errorLine()?.textContent).toContain("Too many requests. Try again later.");
    // Its own live region, not inside the status one, so it is read once.
    expect(region().contains(errorLine())).toBe(false);
    expect(region().textContent).toContain(`We sent a link to ${EMAIL}.`);
    // Under the sentence: the region comes first in the page's order.
    expect(
      region().compareDocumentPosition(errorLine() as Node) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    setMessage(undefined);
    expect(errorLine()?.textContent).toContain("Something went wrong. Try again in a moment.");
    setMessage("   ");
    expect(errorLine()?.textContent).toContain("Something went wrong. Try again in a moment.");
  });

  it("clears the error while Resend sends, so a second failure is announced again", async () => {
    const [status, setStatus] = createSignal<CheckEmailStatus>("error");
    const pending = deferred();
    render(() => (
      <CheckEmailView
        email={EMAIL}
        purpose="sign-up"
        status={status()}
        errorMessage="Too many requests. Try again later."
        resendWaitSeconds={0}
        onResend={() => pending.promise}
      />
    ));

    const first = errorLine();
    expect(first?.textContent).toContain("Too many requests. Try again later.");
    fireEvent.click(resend());
    expect(errorLine()).toBeNull();
    pending.reject(new Error("down"));
    await settle();
    setStatus("error");
    expect(errorLine()?.textContent).toContain("Too many requests. Try again later.");
    expect(errorLine()).not.toBe(first);
  });

  it("shows no error outside the error status, even when a message is given", () => {
    const [status, setStatus] = createSignal<CheckEmailStatus>("error");
    render(() => (
      <CheckEmailView
        email={EMAIL}
        purpose="sign-up"
        status={status()}
        errorMessage="Too many requests. Try again later."
        onResend={() => {}}
      />
    ));

    expect(errorLine()?.textContent).toContain("Too many requests. Try again later.");
    for (const quiet of ["waiting", "expired"] as const) {
      setStatus("error");
      expect(errorLine()?.textContent).toContain("Too many requests. Try again later.");
      setStatus(quiet);
      expect(errorLine()).toBeNull();
      expect(document.body.textContent).not.toContain("Too many requests. Try again later.");
      expect(document.body.textContent).not.toContain(
        "Something went wrong. Try again in a moment.",
      );
    }
  });

  it("shows no fallback sentence outside the error status when no message is given", () => {
    const [status, setStatus] = createSignal<CheckEmailStatus>("error");
    render(() => (
      <CheckEmailView email={EMAIL} purpose="sign-up" status={status()} onResend={() => {}} />
    ));

    expect(errorLine()?.textContent).toContain("Something went wrong. Try again in a moment.");
    for (const quiet of ["waiting", "expired"] as const) {
      setStatus("error");
      setStatus(quiet);
      expect(document.body.textContent).not.toContain(
        "Something went wrong. Try again in a moment.",
      );
    }
  });
});

describe("CheckEmailView — the words for each flow", () => {
  const LINES: [CheckEmailPurpose, string][] = [
    ["sign-up", "Open it on any device to finish signing up."],
    ["recovery", "Open it on any device to get back into your account."],
    ["step-up", "Open it on any device to confirm it's you."],
    ["email-change", "Open it on any device to confirm your new address."],
  ];

  it.each(LINES)("%s says what opening the link does", (purpose, line) => {
    render(() => (
      <CheckEmailView email={EMAIL} purpose={purpose} status="waiting" onResend={() => {}} />
    ));

    screen.getByText(`${line} This page will update when you do.`);
    const others = LINES.filter(([other]) => other !== purpose).map(([, otherLine]) => otherLine);
    for (const otherLine of others) {
      expect(screen.queryByText(new RegExp(otherLine))).toBeNull();
    }
  });

  it("does not promise recovery sent anything, since recovery answers the same for every address", async () => {
    const onResend = vi.fn().mockResolvedValue(undefined);
    render(() => (
      <CheckEmailView
        email={EMAIL}
        purpose="recovery"
        status="waiting"
        resendWaitSeconds={0}
        onResend={onResend}
      />
    ));

    expect(region().textContent).toContain(`If ${EMAIL} has an account, a link is on its way.`);
    expect(region().textContent).not.toContain("We sent");
    fireEvent.click(resend());
    await settle();
    expect(region().textContent).toContain(`If ${EMAIL} has an account, a new link is on its way.`);
    expect(region().textContent).not.toContain("We sent");
  });

  it.each([
    ["sign-up", "waiting"],
    ["recovery", "waiting"],
    ["sign-up", "expired"],
  ] as const)(
    "keeps the address out of the browser's page translation (%s, %s)",
    (purpose, status) => {
      render(() => (
        <CheckEmailView email={EMAIL} purpose={purpose} status={status} onResend={() => {}} />
      ));

      expect(screen.getByText(EMAIL).getAttribute("translate")).toBe("no");
    },
  );

  it("names no address when it is given none", () => {
    render(() => (
      <>
        <CheckEmailView purpose="step-up" status="waiting" onResend={() => {}} />
        <CheckEmailView purpose="recovery" status="waiting" onResend={() => {}} />
      </>
    ));

    const [stepUp, recovery] = screen.getAllByRole("status");
    expect(stepUp?.textContent).toContain("We sent a link to your email address.");
    expect(recovery?.textContent).toContain(
      "If that address has an account, a link is on its way.",
    );
  });
});

describe("CheckEmailView — the number", () => {
  it("shows the number and its caption when given one, and neither when not", () => {
    render(() => (
      <CheckEmailView
        email={EMAIL}
        purpose="sign-up"
        status="waiting"
        pairingCode="47"
        onResend={() => {}}
      />
    ));

    expect(numberParagraph("47")).toBeDefined();
    screen.getByText(CAPTION);

    cleanup();
    render(() => (
      <CheckEmailView email={EMAIL} purpose="sign-up" status="waiting" onResend={() => {}} />
    ));

    expect(screen.queryByText(/Your number/)).toBeNull();
    expect(screen.queryByText(CAPTION)).toBeNull();
  });

  const TYPE_CAPTION = "Type this number on the page the link opens.";

  it.each([
    ["sign-up", CAPTION, TYPE_CAPTION],
    ["recovery", TYPE_CAPTION, CAPTION],
    ["step-up", TYPE_CAPTION, CAPTION],
    ["email-change", CAPTION, TYPE_CAPTION],
  ] as const)(
    "%s's caption says what the page the link opens asks for",
    (purpose, caption, other) => {
      render(() => (
        <CheckEmailView
          email={EMAIL}
          purpose={purpose}
          status="waiting"
          pairingCode="47"
          onResend={() => {}}
        />
      ));

      screen.getByText(caption);
      expect(screen.queryByText(other)).toBeNull();
    },
  );

  it("keeps the number and its caption out of the live region", () => {
    render(() => (
      <CheckEmailView
        email={EMAIL}
        purpose="sign-up"
        status="waiting"
        pairingCode="47"
        onResend={() => {}}
      />
    ));

    const number = numberParagraph("47") as HTMLParagraphElement;
    expect(region().contains(number)).toBe(false);
    expect(region().contains(screen.getByText(CAPTION))).toBe(false);
    expect(region().textContent).not.toContain("Your number");
    expect(region().textContent).not.toContain("47");
  });

  it("puts the hidden label before the digits in one paragraph, and keeps the digits out of page translation", () => {
    render(() => (
      <CheckEmailView
        email={EMAIL}
        purpose="sign-up"
        status="waiting"
        pairingCode="47"
        onResend={() => {}}
      />
    ));

    const number = numberParagraph("47") as HTMLParagraphElement;
    const label = number.firstChild as HTMLElement;
    expect(label.textContent).toBe("Your number:");
    expect(label.classList.contains("sr-only")).toBe(true);

    const digits = number.querySelector('[translate="no"]') as HTMLElement;
    expect(digits.textContent).toBe("47");
    expect(digits.contains(label)).toBe(false);
    expect(label.closest('[translate="no"]')).toBeNull();
  });

  it.each(["", " "])("shows nothing for %j", (value) => {
    render(() => (
      <CheckEmailView
        email={EMAIL}
        purpose="sign-up"
        status="waiting"
        pairingCode={value}
        onResend={() => {}}
      />
    ));

    expect(screen.queryByText(/Your number/)).toBeNull();
    expect(screen.queryByText(CAPTION)).toBeNull();
  });

  it.each(["9a", " 47", "47 ", "1234567", "-905", "4.7", "٤٧", "４７", "<b>12</b>"])(
    "shows nothing for %j, which is not one to six digits, and writes it nowhere",
    (value) => {
      render(() => (
        <CheckEmailView
          email={EMAIL}
          purpose="sign-up"
          status="waiting"
          pairingCode={value}
          onResend={() => {}}
        />
      ));

      expect(screen.queryByText(/Your number/)).toBeNull();
      expect(screen.queryByText(CAPTION)).toBeNull();
      expect(document.body.textContent).not.toContain(value.trim());
      expect(attributesHolding(value.trim())).toEqual([]);
    },
  );

  it.each(["0", "123456"])("shows %s, at the edge of the format", (code) => {
    render(() => (
      <CheckEmailView
        email={EMAIL}
        purpose="sign-up"
        status="waiting"
        pairingCode={code}
        onResend={() => {}}
      />
    ));

    expect(numberParagraph(code)).toBeDefined();
  });

  it("hides the number while the link is expired, and shows the next request's once it is live", () => {
    const [status, setStatus] = createSignal<CheckEmailStatus>("waiting");
    const [code, setCode] = createSignal("47");
    render(() => (
      <CheckEmailView
        email={EMAIL}
        purpose="sign-up"
        status={status()}
        pairingCode={code()}
        onResend={() => {}}
      />
    ));

    expect(numberParagraph("47")).toBeDefined();
    setStatus("expired");
    expect(screen.queryByText(/Your number/)).toBeNull();
    expect(screen.queryByText(CAPTION)).toBeNull();

    setCode("83");
    setStatus("waiting");
    expect(numberParagraph("83")).toBeDefined();
    expect(document.body.textContent).not.toContain("47");
  });

  it("shows a new number in place of the old one", () => {
    const [code, setCode] = createSignal("47");
    render(() => (
      <CheckEmailView
        email={EMAIL}
        purpose="sign-up"
        status="waiting"
        pairingCode={code()}
        onResend={() => {}}
      />
    ));

    setCode("83");
    expect(numberParagraph("83")).toBeDefined();
    expect(document.body.textContent).not.toContain("47");
  });

  it("writes the number into no attribute", () => {
    render(() => (
      <CheckEmailView
        email={EMAIL}
        purpose="sign-up"
        status="waiting"
        pairingCode="905172"
        onResend={() => {}}
        onChangeEmail={() => {}}
      />
    ));

    expect(numberParagraph("905172")).toBeDefined();
    expect(attributesHolding("905172")).toEqual([]);
  });

  it("keeps the number on screen in the error state and while a resend is pending", () => {
    const [status, setStatus] = createSignal<CheckEmailStatus>("error");
    render(() => (
      <CheckEmailView
        email={EMAIL}
        purpose="sign-up"
        status={status()}
        pairingCode="47"
        resendWaitSeconds={0}
        onResend={() => deferred().promise}
      />
    ));

    expect(numberParagraph("47")).toBeDefined();
    setStatus("waiting");
    fireEvent.click(resend());
    expect(region().textContent).toContain("Sending a new link…");
    expect(numberParagraph("47")).toBeDefined();
  });

  it.each([
    ["sign-up", `We sent a new link to ${EMAIL}. Check the number again.`],
    ["recovery", `If ${EMAIL} has an account, a new link is on its way. Check the number again.`],
  ] as const)(
    "%s sends the person back to the number after a resend",
    async (purpose, sentence) => {
      render(() => (
        <CheckEmailView
          email={EMAIL}
          purpose={purpose}
          status="waiting"
          pairingCode="47"
          resendWaitSeconds={0}
          onResend={() => Promise.resolve()}
        />
      ));

      expect(region().textContent).not.toContain("Check the number");
      fireEvent.click(resend());
      await settle();
      expect(region().textContent).toContain(sentence);
    },
  );

  it("says nothing about a number after a resend when there is none", async () => {
    render(() => (
      <CheckEmailView
        email={EMAIL}
        purpose="sign-up"
        status="waiting"
        resendWaitSeconds={0}
        onResend={() => Promise.resolve()}
      />
    ));

    fireEvent.click(resend());
    await settle();
    expect(region().textContent).toContain(`We sent a new link to ${EMAIL}.`);
    expect(region().textContent).not.toContain("number");
  });
});

describe("CheckEmailView — controls and focus", () => {
  it("calls onChangeEmail, and draws no button when there is none", () => {
    const onChangeEmail = vi.fn();
    render(() => (
      <>
        <CheckEmailView
          email={EMAIL}
          purpose="sign-up"
          status="waiting"
          onResend={() => {}}
          onChangeEmail={onChangeEmail}
        />
        <CheckEmailView purpose="step-up" status="waiting" onResend={() => {}} />
      </>
    ));

    const buttons = screen.getAllByRole("button", { name: "Use a different email" });
    expect(buttons).toHaveLength(1);
    fireEvent.click(buttons[0] as HTMLElement);
    expect(onChangeEmail).toHaveBeenCalledTimes(1);
  });

  it("submits no form it sits inside", () => {
    const onSubmit = vi.fn((e: SubmitEvent) => e.preventDefault());
    render(() => (
      <form onSubmit={onSubmit}>
        <CheckEmailView
          email={EMAIL}
          purpose="sign-up"
          status="waiting"
          resendWaitSeconds={0}
          onResend={() => {}}
          onChangeEmail={() => {}}
        />
      </form>
    ));

    fireEvent.click(resend());
    fireEvent.click(screen.getByRole("button", { name: "Use a different email" }));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("puts focus on its heading when it appears, and again when Resend disables itself after a send", async () => {
    const pending = deferred();
    render(() => (
      <CheckEmailView
        email={EMAIL}
        purpose="sign-up"
        status="waiting"
        resendWaitSeconds={5}
        onResend={() => pending.promise}
      />
    ));

    // A heading with no tabindex cannot take focus in a browser, though
    // happy-dom lets it: the attribute is half of the guarantee.
    expect(heading().getAttribute("tabindex")).toBe("-1");
    expect(document.activeElement).toBe(heading());

    vi.advanceTimersByTime(5_000);
    resend().focus();
    expect(document.activeElement).toBe(resend());
    fireEvent.click(resend());
    // Busy through the send, so it keeps focus.
    expect(document.activeElement).toBe(resend());
    pending.resolve();
    await settle();
    expect(resend().disabled).toBe(true);
    expect(document.activeElement).toBe(heading());
  });

  it("leaves focus where it is when Resend did not hold it", async () => {
    const pending = deferred();
    render(() => (
      <>
        <CheckEmailView
          email={EMAIL}
          purpose="sign-up"
          status="waiting"
          resendWaitSeconds={5}
          onResend={() => pending.promise}
        />
        <input aria-label="elsewhere" />
      </>
    ));

    // The send ends with the wait disabling Resend, as in the case above.
    vi.advanceTimersByTime(5_000);
    fireEvent.click(resend());
    const elsewhere = screen.getByRole("textbox", { name: "elsewhere" });
    elsewhere.focus();
    pending.resolve();
    await settle();
    expect(resend().disabled).toBe(true);
    expect(document.activeElement).toBe(elsewhere);
  });

  it("writes nothing to the console across a whole run", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => {}),
    );
    const [status, setStatus] = createSignal<CheckEmailStatus>("waiting");
    const onResend = vi.fn().mockRejectedValueOnce(new Error("down")).mockResolvedValue(undefined);
    const { unmount } = render(() => (
      <CheckEmailView
        email={EMAIL}
        purpose="sign-up"
        status={status()}
        pairingCode="47"
        onResend={onResend}
        onChangeEmail={() => {}}
      />
    ));

    expect(numberParagraph("47")).toBeDefined();
    vi.advanceTimersByTime(30_000);
    fireEvent.click(resend());
    await settle();
    setStatus("error");
    vi.advanceTimersByTime(30_000);
    fireEvent.click(resend());
    await settle();
    expect(numberParagraph("47")).toBeDefined();
    setStatus("expired");
    unmount();

    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
});
