/**
 * Musubi: create an account with a passkey, sign out, sign back in with the
 * passkey, keep the session across a reload and past its access token's
 * expiry, and sign the page out when the issuer refuses to renew it.
 *
 * The session cookie is set by osn-api (`localhost:4000`) on responses to
 * Musubi's (`localhost:1422`) cross-origin fetches, so it only lands — and only
 * rides on later calls — when those fetches pass `credentials: "include"`.
 */

import type { Request, Response } from "@playwright/test";

import { ORIGINS, PEOPLE } from "../../src/config";
import {
  addVirtualAuthenticator,
  cookieNamed,
  expect,
  mailFor,
  otpFor,
  test,
} from "../support/fixtures";

const ada = PEOPLE.musubi;

test("musubi-passkey", async ({ page, context, flow }) => {
  const authenticator = await addVirtualAuthenticator(page);
  // The virtual authenticator answers a conditional-UI (autofill) request on
  // its own, which a person never does: it would sign in the moment the dialog
  // opens, racing the "@handle → Continue" path this flow drives. Report
  // conditional mediation as unavailable, as on a browser without it.
  await page.addInitScript(() => {
    PublicKeyCredential.isConditionalMediationAvailable = () => Promise.resolve(false);
  });

  await flow.step("open Musubi", async () => {
    await page.goto(ORIGINS.musubi);
    await expect(page.getByRole("button", { name: "Create account" }).first()).toBeVisible();
  });
  flow.check("tab title", "Musubi", await page.title());

  // The narrowest phone: the signed-out top bar must hold the wordmark, the
  // theme toggle, "Sign in" and "Create account" without running off the right
  // edge.
  const viewport = page.viewportSize();
  let createAccountRight = Number.POSITIVE_INFINITY;
  await flow.step("signed-out top bar at 320px", async () => {
    await page.setViewportSize({ width: 320, height: 640 });
    const box = await page
      .getByRole("button", { name: "Create account" })
      .filter({ visible: true })
      .boundingBox();
    createAccountRight = box ? box.x + box.width : createAccountRight;
    if (viewport) await page.setViewportSize(viewport);
  });
  flow.check("Create account fits a 320px screen", true, createAccountRight <= 320);

  await flow.step("register: details", async () => {
    await page.getByRole("button", { name: "Create account" }).first().click();
    await page.getByLabel("Email").fill(ada.email);
    await page.getByLabel("Handle").fill(ada.handle);
    await page.getByLabel("Date of birth").fill("1990-01-01");
    await page.getByLabel("Display name (optional)").fill(ada.name);
    await page.getByRole("button", { name: "Send verification code" }).click();
  });

  await flow.step("register: verify email", async () => {
    const code = await otpFor(ada.email);
    await page.getByLabel("Digit 1").pressSequentially(code);
    await page.getByRole("button", { name: "Verify email" }).click();
  });
  const [verification] = await mailFor(ada.email);
  flow.check("registration email subject", "Verify your Musubi email", verification?.subject ?? "");

  await flow.step("register: enroll passkey", async () => {
    await page.getByRole("button", { name: "Enroll credential" }).click();
    await expect(page.getByRole("button", { name: `@${ada.handle}` })).toBeVisible();
  });

  const notices = await mailFor(ada.email, (m) => m.subject.startsWith("A passkey was added"));
  flow.check(
    "passkey-added notice subject",
    "A passkey was added to your Musubi account",
    notices.find((m) => m.subject.startsWith("A passkey was added"))?.subject ?? "",
  );

  const credentials = await authenticator.credentials();
  flow.check("authenticator holds one passkey", 1, credentials.length);
  flow.check("passkey RP ID", "localhost", credentials[0]?.rpId ?? "");

  await flow.step("sign out", async () => {
    await page.getByRole("button", { name: `@${ada.handle}` }).click();
    await page.getByRole("menuitem", { name: "Log out" }).click();
    await expect(page.getByRole("button", { name: "Sign in" }).first()).toBeVisible();
  });
  flow.check(
    "session cookie cleared on sign-out",
    false,
    (await cookieNamed(context, ORIGINS.osnApi, "osn_session")) !== undefined,
  );

  await flow.step("sign in with passkey", async () => {
    await page.getByRole("button", { name: "Sign in" }).first().click();
    await page.getByLabel("Email or @handle").fill(`@${ada.handle}`);
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByRole("button", { name: `@${ada.handle}` })).toBeVisible();
  });

  const cookie = await cookieNamed(context, ORIGINS.osnApi, "osn_session");
  flow.check("osn_session cookie set by osn-api", true, cookie !== undefined);
  flow.check("osn_session is HttpOnly", true, cookie?.httpOnly ?? false);
  flow.check("osn_session is SameSite=Lax", "Lax", cookie?.sameSite ?? "");

  await flow.step("reload restores the session from the cookie alone", async () => {
    // Drop the client's cached account, so the only way back to a session is
    // the HttpOnly cookie riding on a credentialed `POST /token`.
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await expect(page.getByRole("button", { name: `@${ada.handle}` })).toBeVisible();
  });
  flow.check("session restored through POST /token", true, flow.saw("POST osn-api /token 200"));

  // From here the page's clock runs ahead of the servers'. osn-api still takes
  // the old access token, so only the client can know it is stale. Each step
  // moves the page past the stored token's expiry and opens the Security tab,
  // whose three views each make an authenticated GET. The checks are counts
  // and sets, never request order across the three, which varies by run.
  const SECURITY_GETS = ["/passkeys", "/totp/status", "/recovery/status"];
  const securityGets = (suffix = "") =>
    SECURITY_GETS.map((path) => flow.count(`GET osn-api ${path}${suffix}`));
  const sum = (counts: number[]) => counts.reduce((a, b) => a + b, 0);
  const pastExpiry = async () => {
    // The number only; no token leaves the page.
    const expiresAt = await page.evaluate(() => {
      const raw = localStorage.getItem("@osn/client:account_session");
      if (!raw) return null;
      const account = JSON.parse(raw) as {
        activeProfileId: string;
        profileTokens: Record<string, { expiresAt: number }>;
      };
      return account.profileTokens[account.activeProfileId]?.expiresAt ?? null;
    });
    if (expiresAt === null) throw new Error("no stored access token");
    const now = await page.evaluate(() => Date.now());
    await page.clock.fastForward(expiresAt - now + 60_000);
  };
  const settingsTab = (name: string) =>
    page
      .getByRole("navigation", { name: "Settings sections" })
      .getByRole("button", { name, exact: true });

  const grantsBefore = flow.count("POST osn-api /token 200");
  const okBefore = securityGets(" 200");
  const refusedGetsBefore = sum(securityGets(" 401"));
  // Whether the grant answered before any of the three GETs left the page.
  const seen: string[] = [];
  const onRequest = (request: Request) => {
    const url = new URL(request.url());
    if (url.origin === ORIGINS.osnApi && SECURITY_GETS.includes(url.pathname)) seen.push("get");
  };
  const onResponse = (response: Response) => {
    const url = new URL(response.url());
    if (url.origin === ORIGINS.osnApi && url.pathname === "/token") seen.push("grant");
  };
  await flow.step("the session outlives its access token", async () => {
    page.on("request", onRequest);
    page.on("response", onResponse);
    await pastExpiry();
    await page.getByRole("link", { name: "Settings" }).first().click();
    await settingsTab("Security").click();
    await expect(page.getByRole("button", { name: "Rename" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Recovery codes" })).toBeVisible();
    page.off("request", onRequest);
    page.off("response", onResponse);
  });
  flow.check(
    "one grant renews the stale token",
    1,
    flow.count("POST osn-api /token 200") - grantsBefore,
  );
  flow.check(
    "each Security GET answered 200",
    true,
    securityGets(" 200").every((n, i) => n > okBefore[i]!),
  );
  flow.check("no Security GET refused", 0, sum(securityGets(" 401")) - refusedGetsBefore);
  flow.check("the grant answered before any GET left", "grant", seen[0] ?? "");

  const refusedGrantsBefore = flow.count("POST osn-api /token 400");
  const sentBefore = sum(securityGets());
  await flow.step("a refused refresh signs the page out", async () => {
    // The issuer no longer holds a session for this browser; the page still
    // holds the account and its stale token.
    await context.clearCookies({ name: "osn_session" });
    await pastExpiry();
    await settingsTab("Profile").click();
    await settingsTab("Security").click();
    await expect(page.getByText("Sign in to manage your settings.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Sign in" }).first()).toBeVisible();
  });
  flow.check(
    "the refused grant was sent once",
    1,
    flow.count("POST osn-api /token 400") - refusedGrantsBefore,
  );
  flow.check("no Security GET sent after the refusal", 0, sum(securityGets()) - sentBefore);
  flow.check(
    "the stored account is gone",
    true,
    await page.evaluate(() => localStorage.getItem("@osn/client:account_session") === null),
  );

  await flow.step("without the cookie, the reload is signed out", async () => {
    await context.clearCookies();
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await expect(page.getByRole("button", { name: "Sign in" }).first()).toBeVisible();
  });
  flow.check(
    "signed out with no cookie",
    false,
    await page.getByRole("button", { name: `@${ada.handle}` }).isVisible(),
  );
});
