// @refresh reload
import { createHandler, StartServer, type StartHandler } from "@solidjs/start/server";

const handler: StartHandler = createHandler(() => (
  <StartServer
    document={({ assets, children, scripts }) => (
      <html lang="en">
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <title>Pulse</title>
          <link rel="preconnect" href="https://fonts.googleapis.com" />
          <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="anonymous" />
          <link
            rel="stylesheet"
            href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&family=Geist+Mono:wght@400;500&family=Instrument+Serif:ital@0;1&display=swap"
          />
          {assets}
        </head>
        <body>
          <div id="root">{children}</div>
          {scripts}
        </body>
      </html>
    )}
  />
));

export default handler;
