import { createClient } from "@pulse/api/client";

const BASE_URL = import.meta.env.VITE_API_URL ?? "http://localhost:3001";

export const api: ReturnType<typeof createClient> = createClient(BASE_URL);
