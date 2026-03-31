import { AuthProvider } from "@osn/client/solid";
import { Toaster } from "solid-toast";
import { OSN_ISSUER_URL, OSN_CLIENT_ID } from "./lib/auth";
import { CallbackHandler } from "./components/CallbackHandler";
import { EventList } from "./components/EventList";
import "./App.css";

export default function App() {
  return (
    <AuthProvider config={{ issuerUrl: OSN_ISSUER_URL, clientId: OSN_CLIENT_ID }}>
      <CallbackHandler />
      <EventList />
      <Toaster position="bottom-right" />
    </AuthProvider>
  );
}
