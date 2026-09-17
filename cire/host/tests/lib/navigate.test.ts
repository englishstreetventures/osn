// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";

import { navigateTo } from "../../src/lib/api";

/**
 * `navigateTo` is a script-execution sink if it does not check the scheme:
 * assigning a `javascript:` URL to `location.href` from same-origin script runs
 * it in this origin. Its one caller today passes a Stripe Checkout URL that the
 * API validated only as a string, and it is exported from the module every
 * component imports for `apiUrl` — so the check has to live in the function
 * rather than in each caller.
 */

const assigned: string[] = [];
const originalHref = "https://host.test/dashboard";

function stubLocation() {
  Object.defineProperty(window, "location", {
    configurable: true,
    value: {
      get href() {
        return originalHref;
      },
      set href(value: string) {
        assigned.push(value);
      },
    },
  });
}

afterEach(() => {
  assigned.length = 0;
  vi.restoreAllMocks();
});

describe("navigateTo", () => {
  it("navigates to an https URL", () => {
    stubLocation();
    navigateTo("https://pay.test/cs_1");
    expect(assigned).toEqual(["https://pay.test/cs_1"]);
  });

  it("navigates to an http URL, which local dev needs", () => {
    stubLocation();
    navigateTo("http://localhost:4322/x");
    expect(assigned).toEqual(["http://localhost:4322/x"]);
  });

  it("refuses a javascript: URL rather than executing it", () => {
    stubLocation();
    navigateTo("javascript:alert(document.cookie)");
    expect(assigned).toEqual([]);
  });

  it("refuses data: and other schemes", () => {
    stubLocation();
    navigateTo("data:text/html,<script>1</script>");
    navigateTo("vbscript:msgbox");
    navigateTo("file:///etc/passwd");
    expect(assigned).toEqual([]);
  });

  it("refuses a string that is not a URL at all", () => {
    stubLocation();
    navigateTo("");
    navigateTo("://////");
    expect(assigned).toEqual([]);
  });
});
