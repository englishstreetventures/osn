/**
 * Musubi: create an account with a passkey, sign out, sign back in with the
 * passkey, keep the session across a reload, add and remove an authenticator
 * app behind passkey step-ups, keep the session past its access token's
 * expiry, list the connected apps, sign the page out when the issuer refuses
 * to renew it, sign out a reload that has no cookie, and sign in to Pulse
 * through Musubi's `/authorize`. Signed in, before the authenticator steps, it
 * measures and shoots Musubi's base styles (`musubi-surfaces.ts`).
 *
 * Musubi is served as it deploys, its Content-Security-Policy included
 * (`appSpecs` in `src/stack.ts`): the flow checks the policy it is served and
 * that no Musubi page logs a refusal under it, Turnstile's widget among them.
 * Access tokens live only in the page's memory; the flow checks that storage
 * never holds one.
 *
 * The session cookie is set by osn-api (`localhost:4000`) on responses to
 * Musubi's (`localhost:1422`) cross-origin fetches, so it only lands — and only
 * rides on later calls — when those fetches pass `credentials: "include"`.
 */

import type { Request, Response } from "@playwright/test";

import { ORIGINS, PEOPLE, TURNSTILE_ORIGIN } from "../../src/config";
import {
  addVirtualAuthenticator,
  cookieNamed,
  expect,
  mailFor,
  otpFor,
  test,
  totpCode,
} from "../support/fixtures";
import { musubiSurfaces } from "../support/musubi-surfaces";

const ada = PEOPLE.musubi;

/** Where `@osn/client` keeps the stored account: never a token. */
const ACCOUNT_KEY = "@osn/client:account_session";

/** The stored account: whether a session is held and the profile the page is on, nothing else. */
const STORED_ACCOUNT = /^\{"hasSession":true,"activeProfileId":"usr_[a-z0-9_]+"\}$/;

/** A JSON Web Token, as any access or ID token osn-api issues is written. */
const JWT = /eyJ[\w-]+\.[\w-]+\./;

/**
 * The access-token lifetime osn-api issues on this stack, which sets no
 * `OSN_ACCESS_TOKEN_TTL` (`osn/api/src/build-deps.ts`).
 */
const ACCESS_TOKEN_TTL_MS = 300_000;

/**
 * The policy the build writes (`contentSecurityPolicy` in
 * `musubi/social/vite.config.ts`), with each inline-script hash written as
 * `'sha256-…'`: scripts from Musubi itself, its two inline scripts and
 * Turnstile; connections to Musubi itself and osn-api.
 */
const MUSUBI_POLICY = `frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'self'; script-src 'self' 'sha256-…' 'sha256-…' ${TURNSTILE_ORIGIN}; connect-src 'self' ${ORIGINS.osnApi}`;

test("musubi-passkey", async ({ page, context, flow }) => {
  const authenticator = await addVirtualAuthenticator(page);
  // The virtual authenticator answers a conditional-UI (autofill) request on
  // its own, which a person never does: it would sign in the moment the dialog
  // opens, racing the "@handle → Continue" path this flow drives. Report
  // conditional mediation as unavailable, as on a browser without it.
  await page.addInitScript(() => {
    PublicKeyCredential.isConditionalMediationAvailable = () => Promise.resolve(false);
  });

  let servedPolicy = "";
  await flow.step("open Musubi", async () => {
    const response = await page.goto(ORIGINS.musubi);
    servedPolicy = (await response?.headerValue("content-security-policy")) ?? "";
    await expect(page.getByRole("button", { name: "Create account" }).first()).toBeVisible();
  });
  flow.check("tab title", "Musubi", await page.title());
  flow.check(
    "Musubi is served the policy its build wrote",
    MUSUBI_POLICY,
    servedPolicy.replace(/'sha256-[A-Za-z0-9+/]+=*'/g, "'sha256-…'"),
  );

  // Every value Musubi keeps in the browser's storage, none of which may be a token.
  const storedValues = () =>
    page.evaluate(() => [...Object.values(localStorage), ...Object.values(sessionStorage)]);
  const storedAccount = () => page.evaluate((key) => localStorage.getItem(key) ?? "", ACCOUNT_KEY);

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
  flow.check(
    "signed in, no stored value holds a token",
    false,
    (await storedValues()).some((v) => JWT.test(v)),
  );
  flow.check(
    "the stored account is its two fields",
    true,
    STORED_ACCOUNT.test(await storedAccount()),
  );

  const grantsBeforeReload = flow.count("POST osn-api /token 200");
  await flow.step("reload restores the session from the cookie alone", async () => {
    // The stored account holds no token, so the only way back to a session is
    // the HttpOnly cookie riding on a credentialed `POST /token`.
    await page.reload();
    await expect(page.getByRole("button", { name: `@${ada.handle}` })).toBeVisible();
  });
  flow.check(
    "one POST /token restores the session",
    1,
    flow.count("POST osn-api /token 200") - grantsBeforeReload,
  );

  // Signed in, after the check above has read the request log: the surfaces
  // reload the page for the legal routes, and each reload posts to /token.
  await musubiSurfaces(flow, page);

  const settingsTab = (name: string) =>
    page
      .getByRole("navigation", { name: "Settings sections" })
      .getByRole("button", { name, exact: true });

  // Each step-up below is a passkey assertion the virtual authenticator
  // answers. The code is computed from the setup key the page shows, on the
  // suite clock the servers run on.
  await flow.step("add an authenticator app", async () => {
    await page.getByRole("link", { name: "Settings" }).first().click();
    await settingsTab("Security").click();
    await page.getByRole("button", { name: "Add an authenticator app" }).click();
    await page.getByRole("button", { name: "Use passkey" }).click();
    const secret = (await page.getByLabel("Or enter this setup key by hand").textContent()) ?? "";
    await page.getByLabel("Digit 1").pressSequentially(totpCode(secret));
    await page.getByRole("button", { name: "Confirm" }).click();
    await expect(page.getByRole("button", { name: "Remove" })).toBeVisible();
  });
  flow.check(
    "the authenticator app was enrolled",
    true,
    flow.saw("POST osn-api /totp/enroll/complete 200"),
  );

  await flow.step("remove the authenticator app", async () => {
    page.once("dialog", (dialog) => void dialog.accept());
    await page.getByRole("button", { name: "Remove" }).click();
    await page.getByRole("button", { name: "Use passkey" }).click();
    await expect(page.getByRole("button", { name: "Add an authenticator app" })).toBeVisible();
    // Leave the Security tab, so the next step's visit mounts its views again.
    await settingsTab("Profile").click();
  });
  flow.check("the authenticator app was removed", true, flow.saw("DELETE osn-api /totp 200"));
  flow.check(
    "each step-up passed with the passkey",
    2,
    flow.count("POST osn-api /step-up/passkey/complete 200"),
  );

  // From here the page's clock runs ahead of the servers'. osn-api still takes
  // the old access token, so only the client can know it is stale. Each step
  // moves the page past its token's expiry and opens the Security tab, whose
  // three views each make an authenticated GET. The checks are counts and
  // sets, never request order across the three, which varies by run.
  const SECURITY_GETS = ["/passkeys", "/totp/status", "/recovery/status"];
  const securityGets = (suffix = "") =>
    SECURITY_GETS.map((path) => flow.count(`GET osn-api ${path}${suffix}`));
  const sum = (counts: number[]) => counts.reduce((a, b) => a + b, 0);
  // The token lives only in the page's memory, so its expiry cannot be read;
  // any token the page holds was issued at or before the page's now.
  const pastExpiry = () => page.clock.fastForward(ACCESS_TOKEN_TTL_MS + 60_000);
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

  await flow.step("list the connected apps", async () => {
    await settingsTab("Connected apps").click();
    await expect(
      page.getByText("You haven't connected any apps to your Musubi account yet."),
    ).toBeVisible();
  });
  flow.check(
    "connected apps listed through authFetch",
    true,
    flow.saw("GET osn-api /oidc/connections 200"),
  );
  // What the page stores while signed in, kept for the no-cookie reload below.
  const signedInAccount = await storedAccount();
  flow.check(
    "renewed, no stored value holds a token",
    false,
    (await storedValues()).some((v) => JWT.test(v)),
  );
  flow.check("still the stored account's two fields", true, STORED_ACCOUNT.test(signedInAccount));

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
  flow.check("the stored account is gone", "", await storedAccount());

  const refusedBeforeReload = flow.count("POST osn-api /token 400");
  await flow.step(
    "without the cookie, a reload with the stored account is signed out",
    async () => {
      await context.clearCookies();
      // What the page stored while signed in: an account and no token.
      await page.evaluate(([key, value]) => localStorage.setItem(key, value), [
        ACCOUNT_KEY,
        signedInAccount,
      ] as const);
      await page.reload();
      await expect(page.getByRole("button", { name: "Sign in" }).first()).toBeVisible();
    },
  );
  flow.check(
    "signed out with no cookie",
    false,
    await page.getByRole("button", { name: `@${ada.handle}` }).isVisible(),
  );
  flow.check(
    "the reload's grant was refused once",
    1,
    flow.count("POST osn-api /token 400") - refusedBeforeReload,
  );
  flow.check("the refused reload forgot the stored account", "", await storedAccount());

  // Pulse is a first-party app, so osn-api sends a browser with no session to
  // Musubi's `/authorize` to sign in, then on to consent, and back to Pulse.
  const authorizePages: string[] = [];
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame() && frame.url().startsWith(`${ORIGINS.musubi}/authorize`)) {
      authorizePages.push(frame.url());
    }
  });
  const contextReadsBefore = flow.count("GET osn-api /authorize/context 200");
  const turnstileBefore = flow.turnstileServed();
  await flow.step("sign in to Pulse through Musubi's /authorize", async () => {
    await page.goto(ORIGINS.pulseWeb);
    await page.getByRole("button", { name: "Continue with musubi" }).click();
    await page.getByLabel("Email or @handle").fill(`@${ada.handle}`);
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByText("Verified by Musubi")).toBeVisible();
    await page.getByRole("button", { name: "Allow" }).click();
    await expect(page).toHaveURL(`${ORIGINS.pulseWeb}/welcome`);
  });
  const turnstileAfter = flow.turnstileServed();
  flow.check("Musubi's /authorize page shown", true, authorizePages.length > 0);
  flow.check(
    "the consent screen read its context",
    true,
    flow.count("GET osn-api /authorize/context 200") > contextReadsBefore,
  );
  flow.check(
    "/authorize loaded Turnstile's script and frame",
    true,
    turnstileAfter.script > turnstileBefore.script && turnstileAfter.frame > turnstileBefore.frame,
  );
  flow.check(
    "no Content-Security-Policy message on a Musubi page",
    "",
    flow.cspMessages(ORIGINS.musubi).join("\n"),
  );
});
