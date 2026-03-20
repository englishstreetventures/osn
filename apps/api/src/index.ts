// Cloudflare Workers entry point — D1 integration pending.
// For local development, use: bun run dev:local
export default {
  fetch(): Response {
    return new Response(
      JSON.stringify({ error: "D1 integration pending — use dev:local" }),
      { status: 503, headers: { "Content-Type": "application/json" } },
    )
  },
}
