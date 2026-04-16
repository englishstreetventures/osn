import { createContext, useContext, type ParentProps } from "solid-js";

import { createGraphClient, type GraphClient, type GraphClientConfig } from "../graph";

const GraphContext = createContext<GraphClient>();

export function GraphProvider(props: ParentProps & { config: GraphClientConfig }) {
  const client = createGraphClient(props.config);
  return <GraphContext.Provider value={client}>{props.children}</GraphContext.Provider>;
}

export function useGraph(): GraphClient {
  const ctx = useContext(GraphContext);
  if (!ctx) throw new Error("useGraph must be used within <GraphProvider>");
  return ctx;
}
