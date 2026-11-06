/**
 * The base of every error this package's REST clients throw for a request the
 * server refused, answered with a body the client could not use, or never
 * answered. `describeAuthError` reads `status` and `code` and nothing else.
 *
 * This module imports nothing. Every client module extends the class, so an
 * import of Effect here would reach each of them and move Effect into a new
 * chunk on every app's first paint; keep it beside, not in, `./errors.ts`.
 *
 * Subclasses set `name` and declare no fields of their own: with
 * `useDefineForClassFields` a redeclared field is reset to `undefined` after
 * `super()` returns. A subclass that narrows a field's type uses `declare`.
 */
export class OsnApiError extends Error {
  /** The response's HTTP status; `0` when no response arrived. */
  readonly status: number;
  /** The server's `error` code, when it sent one in the form `errorCode` accepts. */
  readonly code: string | undefined;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = "OsnApiError";
    this.status = status;
    this.code = code;
  }
}
