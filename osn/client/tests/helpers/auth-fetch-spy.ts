import { expect, vi, type Mock } from "vitest";

import type { AuthFetch } from "../../src/runtime";

/**
 * An `authFetch` for a client test: it passes each call to the stubbed global
 * `fetch` and records it. A request a client sent with `fetch` directly would
 * carry no token, and on a page every such call answers 401; the record is
 * what lets a test tell the two apart.
 */
export function authFetchSpy(): Mock<AuthFetch> {
  return vi.fn<AuthFetch>((input, init) => fetch(input, init));
}

/**
 * Every request the stubbed `fetch` saw for an authenticated route came through
 * `authFetch`, in order, with the `credentials` the client must send — and
 * nothing else did. `authenticated` picks the routes that need the token; a
 * client with unauthenticated methods too passes it, and a call from one of
 * those through `authFetch` fails the check as well.
 *
 * Call it in `afterEach`, before the globals are unstubbed. It clears the spy.
 */
export function expectAllThroughAuthFetch(
  authFetch: Mock<AuthFetch>,
  credentials: RequestCredentials,
  authenticated: (url: string) => boolean = () => true,
): void {
  const stub = globalThis.fetch;
  const sent = vi.isMockFunction(stub)
    ? stub.mock.calls.map(([input]) => String(input)).filter(authenticated)
    : [];
  const calls = [...authFetch.mock.calls];
  authFetch.mockClear();

  expect(calls.map(([url]) => url)).toEqual(sent);
  for (const [, init] of calls) expect(init?.credentials).toBe(credentials);
}
