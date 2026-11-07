import { createContext, useContext, type ParentProps } from "solid-js";

import { createGraphClient, type GraphClient } from "../graph";
import { useAuth } from "./context";

const GraphContext = createContext<GraphClient>();

/** A graph client on the enclosing `AuthProvider`'s `authFetch`. */
export function GraphProvider(props: ParentProps & { issuerUrl: string }) {
  const { authFetch } = useAuth();
  // Read once: the issuer does not change while the page is open.
  const issuerUrl = props.issuerUrl;
  const client = createGraphClient({ issuerUrl, authFetch });
  return <GraphContext.Provider value={client}>{props.children}</GraphContext.Provider>;
}

export function useGraph(): GraphClient {
  const ctx = useContext(GraphContext);
  if (!ctx) throw new Error("useGraph must be used within <GraphProvider>");
  return ctx;
}
