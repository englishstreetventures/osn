import { AuthProvider } from "@osn/client/solid";
import { Toaster } from "solid-toast";
import { MagicLinkHandler } from "@osn/ui/auth/MagicLinkHandler";
import { OSN_ISSUER_URL, OSN_CLIENT_ID } from "./lib/auth";
import { loginClient } from "./lib/authClients";
import { CallbackHandler } from "./components/CallbackHandler";
import { EventList } from "./components/EventList";
import "./App.css";

export default function App() {
  return (
    <AuthProvider config={{ issuerUrl: OSN_ISSUER_URL, clientId: OSN_CLIENT_ID }}>
      {/* Third-party OAuth redirect callback (legacy / hosted HTML flow). */}
      <CallbackHandler />
      {/* First-party magic-link deep-link handler — no-op unless the URL
          carries a ?token=… from an emailed sign-in link. */}
      <MagicLinkHandler client={loginClient} />
      <EventList />
      <Toaster position="bottom-right" />
    </AuthProvider>
  );
}
