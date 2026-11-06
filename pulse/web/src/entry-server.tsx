// @refresh reload
import { createHandler, StartServer, type StartHandler } from "@solidjs/start/server";

import { dateLocale } from "./lib/date-locale";

const handler: StartHandler = createHandler(
  () => (
    <StartServer
      document={({ assets, children, scripts }) => (
        // `data-date-locale`: the locale this request's dates are written in,
        // which the browser's first render reads back (`lib/date-locale.ts`).
        <html lang="en" data-date-locale={dateLocale()}>
          <head>
            <meta charset="utf-8" />
            <meta name="viewport" content="width=device-width, initial-scale=1" />
            <title>Pulse</title>
            {assets}
          </head>
          <body>
            <div id="root">{children}</div>
            {scripts}
          </body>
        </html>
      )}
    />
  ),
  // Runs for page renders only; API routes answer before it.
  (event) => {
    // A page can hold the signed-in user's own data, and which user is decided
    // by the cookie, so no shared cache may keep it or serve it to another.
    event.response.headers.set("Cache-Control", "private, no-store");
    event.response.headers.append("Vary", "Cookie");
    // `async` waits for every resource and writes it inline. `stream` would
    // send Suspense content as a `<template>` swapped in by script, which a
    // reader without JavaScript never sees.
    return { mode: "async" };
  },
);

export default handler;
