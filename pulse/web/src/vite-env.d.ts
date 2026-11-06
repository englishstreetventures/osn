/// <reference types="vite/client" />

declare namespace App {
  interface RequestEventLocals {
    /** The request's date locale, worked out once per request (`src/lib/date-locale.ts`). */
    pulseDateLocale?: string;
  }
}
