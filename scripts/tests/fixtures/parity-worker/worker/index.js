// A Worker that makes the calls the guest site makes: a GET and a JSON POST
// with a query to cire-api (`env.API_ORIGIN`), and a GET to another origin
// (`env.OTHER_ORIGIN`). The GET sets no user agent and the POST sets one, so
// the test can check what the reference reports of each. guest-route-parity-
// wrangler.e2e.ts sets both origins in a copy of wrangler.json and reads what
// each call answered from `/subrequests`.

export default {
  async fetch(request, env) {
    if (new URL(request.url).pathname !== "/subrequests") {
      return new Response("not found", { status: 404 });
    }
    const get = await fetch(`${env.API_ORIGIN}/api/invite/cire-wedding?from=get`);
    const post = await fetch(`${env.API_ORIGIN}/api/invite/resolve?from=post`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "parity-fixture",
        "x-fixture": "post",
      },
      body: JSON.stringify({ slug: "cire-wedding" }),
    });
    const other = await fetch(`${env.OTHER_ORIGIN}/other?from=worker`, {
      headers: { "x-fixture": "other" },
    });
    return Response.json({
      get: { status: get.status, body: await get.json() },
      post: { status: post.status, body: await post.json() },
      other: { status: other.status, body: await other.text() },
    });
  },
};
