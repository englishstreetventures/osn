import { describe, it, expect, beforeEach } from "vitest";
import { createEventsRoutes } from "../../src/routes/events";
import { createTestLayer } from "../helpers/db";

const FUTURE = "2030-06-01T10:00:00.000Z";

const json = (body: unknown) => JSON.stringify(body);
const post = (app: ReturnType<typeof createEventsRoutes>, path: string, body: unknown) =>
  app.handle(
    new Request(`http://localhost${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: json(body),
    }),
  );
const patch = (app: ReturnType<typeof createEventsRoutes>, path: string, body: unknown) =>
  app.handle(
    new Request(`http://localhost${path}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: json(body),
    }),
  );
const del = (app: ReturnType<typeof createEventsRoutes>, path: string) =>
  app.handle(new Request(`http://localhost${path}`, { method: "DELETE" }));

describe("events routes", () => {
  let app: ReturnType<typeof createEventsRoutes>;

  beforeEach(() => {
    app = createEventsRoutes(createTestLayer());
  });

  it("GET /events returns 200 empty list", async () => {
    const res = await app.handle(new Request("http://localhost/events"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ events: [] });
  });

  it("GET /events/today returns 200 empty list", async () => {
    const res = await app.handle(new Request("http://localhost/events/today"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ events: [] });
  });

  it("GET /events/:id returns 404 for missing event", async () => {
    const res = await app.handle(new Request("http://localhost/events/nonexistent"));
    expect(res.status).toBe(404);
  });

  it("POST /events creates event and returns 201", async () => {
    const res = await post(app, "/events", { title: "Concert", startTime: FUTURE });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { event: { id: string; title: string } };
    expect(body.event.id).toMatch(/^evt_/);
    expect(body.event.title).toBe("Concert");
  });

  it("POST /events returns 422 for missing title", async () => {
    const res = await post(app, "/events", { startTime: FUTURE });
    expect(res.status).toBe(422);
  });

  it("POST /events returns 422 for empty title", async () => {
    const res = await post(app, "/events", { title: "", startTime: FUTURE });
    expect(res.status).toBe(422);
  });

  it("POST /events returns 422 for invalid imageUrl", async () => {
    const res = await post(app, "/events", {
      title: "Concert",
      startTime: FUTURE,
      imageUrl: "not-a-url",
    });
    expect(res.status).toBe(422);
  });

  it("POST /events accepts valid imageUrl", async () => {
    const res = await post(app, "/events", {
      title: "Concert",
      startTime: FUTURE,
      imageUrl: "https://example.com/image.jpg",
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { event: { imageUrl: string } };
    expect(body.event.imageUrl).toBe("https://example.com/image.jpg");
  });

  it("PATCH /events/:id updates event and returns 200", async () => {
    const createRes = await post(app, "/events", { title: "Original", startTime: FUTURE });
    const { event } = (await createRes.json()) as { event: { id: string } };
    const res = await patch(app, `/events/${event.id}`, { title: "Updated" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { event: { title: string } };
    expect(body.event.title).toBe("Updated");
  });

  it("PATCH /events/:id returns 404 for nonexistent event", async () => {
    const res = await patch(app, "/events/nonexistent", { title: "Updated" });
    expect(res.status).toBe(404);
  });

  it("PATCH /events/:id returns 422 for invalid imageUrl", async () => {
    const createRes = await post(app, "/events", { title: "Original", startTime: FUTURE });
    const { event } = (await createRes.json()) as { event: { id: string } };
    const res = await patch(app, `/events/${event.id}`, { imageUrl: "not-a-url" });
    expect(res.status).toBe(422);
  });

  it("DELETE /events/:id returns 204", async () => {
    const createRes = await post(app, "/events", { title: "To Delete", startTime: FUTURE });
    const { event } = (await createRes.json()) as { event: { id: string } };
    const res = await del(app, `/events/${event.id}`);
    expect(res.status).toBe(204);
  });

  it("DELETE /events/:id returns 404 for nonexistent event", async () => {
    const res = await del(app, "/events/nonexistent");
    expect(res.status).toBe(404);
  });
});
