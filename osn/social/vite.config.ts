import tailwindcss from "@tailwindcss/vite";
import { defineConfig, type Plugin } from "vite";
import solid from "vite-plugin-solid";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

/**
 * AZ-P-I1. `/authorize` is a cold cross-origin landing: the browser arrives
 * from the relying party with no warm connection to the OSN issuer, so
 * `GET /authorize/context` pays DNS + TCP + TLS before a byte moves. A
 * `preconnect` overlaps that handshake with the JS parse instead.
 *
 * The origin comes from `VITE_OSN_ISSUER_URL`, the same build input the
 * client uses, so a per-environment issuer can never be preconnected to the
 * wrong host. `crossorigin` is required: the context read is
 * `credentials: "include"`, and a preconnect opened in the wrong CORS mode is
 * a second connection rather than a reused one.
 *
 * The value is read off the resolved config rather than `process.env`, so it
 * sees exactly what the app's `import.meta.env` will — `.env` files included.
 * A malformed or missing URL emits no tag rather than a dead one.
 */
export function issuerPreconnect(): Plugin {
  let issuerUrl: string | undefined;
  return {
    name: "osn-issuer-preconnect",
    configResolved(resolved) {
      issuerUrl = resolved.env.VITE_OSN_ISSUER_URL as string | undefined;
    },
    transformIndexHtml() {
      let origin: string;
      try {
        origin = new URL(issuerUrl ?? "").origin;
      } catch {
        return [];
      }
      return [
        {
          tag: "link",
          // `use-credentials`, NOT a bare `crossorigin` — an empty value means
          // anonymous mode, and the connection-pool key includes the
          // credentials flag. The call this warms (`GET /authorize/context`) is
          // `credentials: "include"`, so an anonymous preconnect lands in a
          // different pool bucket: the handshake is not reused AND an extra
          // idle TLS connection is opened. That is strictly worse than
          // shipping no tag at all.
          attrs: { rel: "preconnect", href: origin, crossorigin: "use-credentials" },
          injectTo: "head-prepend" as const,
        },
      ];
    },
  };
}

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [tailwindcss(), solid(), issuerPreconnect()],

  clearScreen: false,
  server: {
    port: 1422,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1423,
        }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
}));
