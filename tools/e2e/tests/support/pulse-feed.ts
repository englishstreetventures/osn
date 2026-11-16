/**
 * Pulse's explore feed narrowing to what the viewer asks for: the search box,
 * which filters the page the server sent by title, venue, place or host name;
 * the filter rail's chips, each of which asks `GET /events/discover` again
 * with its own query; and "More filters", whose Apply and Clear do the same.
 *
 * `pulse-event-rsvp` calls it on the host's page, signed in on `/` at
 * 1280×720, when the run has made exactly one event: `title`, upcoming, free,
 * with no category or venue. It records each discover call's status and its
 * query, its parameters sorted, never a value the clock decides ("Tonight" is
 * not pressed). Leaves the page on `/` with an empty search, "For you" pressed
 * and no advanced filter.
 */

import type { Page, Response } from "@playwright/test";

import { ORIGINS } from "../../src/config";
import { expect, type Flow } from "./fixtures";

/** The search input's accessible name, its `aria-label`. */
const SEARCH_NAME = "Search events, people, venues";
const DISCOVER = `${ORIGINS.pulseApi}/events/discover`;

/** A discover call's query, its parameters sorted, as `a=1&b=2`; empty for none. */
function sortedQuery(response: Response): string {
  return [...new URL(response.url()).searchParams]
    .map(([key, value]) => `${key}=${value}`)
    .toSorted()
    .join("&");
}

export async function exploreFeed(
  flow: Flow,
  page: Page,
  person: { readonly name: string },
  title: string,
): Promise<void> {
  const card = page.getByRole("link", { name: title });
  const empty = page.getByText("Nothing here yet.", { exact: true });
  const search = page.getByRole("textbox", { name: SEARCH_NAME });

  /** Runs `act`, and returns the discover call it set off. */
  const discover = async (act: () => Promise<void>): Promise<Response> => {
    const answered = page.waitForResponse((r) => {
      const url = new URL(r.url());
      return r.request().method() === "GET" && `${url.origin}${url.pathname}` === DISCOVER;
    });
    await act();
    return answered;
  };
  const recordDiscover = (what: string, response: Response, query: string) => {
    flow.check(`explore feed: ${what}: discover status`, 200, response.status());
    flow.check(`explore feed: ${what}: discover query`, query, sortedQuery(response));
  };

  await flow.step("explore feed: the event's card", async () => {
    await expect(page).toHaveURL(`${ORIGINS.pulseWeb}/`);
    await expect(card).toBeVisible();
  });

  await flow.step("explore feed: search by title, by host, and for nothing", async () => {
    await search.fill("launch");
    await expect(card).toBeVisible();
    await search.fill(person.name.toLowerCase());
    await expect(card).toBeVisible();
    await search.fill("no such event");
    await expect(empty).toBeVisible();
    await expect(card).toHaveCount(0);
    await search.fill("");
    await expect(card).toBeVisible();
  });

  /** A rail chip's button: its glyph, then its label. */
  const chip = (label: string) => page.getByRole("button", { name: new RegExp(`${label}$`) });

  const free = await flow.step('explore feed: press "Free"', async () => {
    const response = await discover(() => chip("Free").click());
    await expect(chip("Free")).toHaveAttribute("aria-pressed", "true");
    await expect(card).toBeVisible();
    return response;
  });
  recordDiscover('"Free"', free, "currency=USD&priceMax=0");

  const music = await flow.step('explore feed: press "Music"', async () => {
    const response = await discover(() => chip("Music").click());
    await expect(chip("Music")).toHaveAttribute("aria-pressed", "true");
    await expect(empty).toBeVisible();
    await expect(card).toHaveCount(0);
    return response;
  });
  recordDiscover('"Music"', music, "category=music");

  const all = await flow.step('explore feed: press "For you"', async () => {
    const response = await discover(() => chip("For you").click());
    await expect(chip("For you")).toHaveAttribute("aria-pressed", "true");
    await expect(card).toBeVisible();
    return response;
  });
  recordDiscover('"For you"', all, "");

  const filters = page.getByRole("dialog", { name: "More filters" });
  const applied = await flow.step("explore feed: More filters, price max 30, Apply", async () => {
    await page.getByRole("button", { name: "More filters" }).click();
    await expect(filters).toBeVisible();
    // The dialog moves focus to its first field on a timer after it opens; a
    // fill that starts before that types into whichever field then has focus.
    await expect
      .poll(() => filters.evaluate((el) => el.contains(document.activeElement)))
      .toBe(true);
    const priceMax = filters.getByLabel("Price max");
    await priceMax.fill("30");
    await expect(priceMax).toHaveValue("30");
    const response = await discover(() =>
      filters.getByRole("button", { name: "Apply", exact: true }).click(),
    );
    await expect(filters).toHaveCount(0);
    await expect(card).toBeVisible();
    return response;
  });
  recordDiscover("More filters, Apply", applied, "currency=USD&priceMax=30");

  const cleared = await flow.step("explore feed: More filters, Clear", async () => {
    await page.getByRole("button", { name: "More filters" }).click();
    await expect(filters).toBeVisible();
    const response = await discover(() =>
      filters.getByRole("button", { name: "Clear", exact: true }).click(),
    );
    await expect(filters).toHaveCount(0);
    await expect(card).toBeVisible();
    return response;
  });
  recordDiscover("More filters, Clear", cleared, "");
}
