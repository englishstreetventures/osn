import { render, cleanup } from "@solidjs/testing-library";
// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from "vitest";

import { ExploreMap } from "../../src/explore/ExploreMap";

const eventsWithGeo = [
  {
    id: "evt_1",
    title: "Jazz Night",
    status: "upcoming" as const,
    startTime: "2030-06-01T19:30:00.000Z",
    category: "music",
    venue: "The Vessel",
    latitude: 40.725,
    longitude: -73.985,
  },
  {
    id: "evt_2",
    title: "Ceramics Studio",
    status: "upcoming" as const,
    startTime: "2030-06-01T18:00:00.000Z",
    category: "art",
    venue: "Clayroom",
    latitude: 40.676,
    longitude: -73.988,
  },
];

const eventNoGeo = {
  id: "evt_3",
  title: "Online Talk",
  status: "upcoming" as const,
  startTime: "2030-06-01T20:00:00.000Z",
  category: "talks",
};

describe("ExploreMap", () => {
  afterEach(cleanup);

  it("renders the map wrapper", () => {
    const { container } = render(() => <ExploreMap events={eventsWithGeo} />);
    expect(container.firstChild).toBeTruthy();
  });

  it("renders SVG base map", () => {
    const { container } = render(() => <ExploreMap events={eventsWithGeo} />);
    const svg = container.querySelector("svg");
    expect(svg).toBeTruthy();
  });

  it("renders a canvas for heatmap overlay", () => {
    const { container } = render(() => <ExploreMap events={eventsWithGeo} />);
    const canvas = container.querySelector("canvas");
    expect(canvas).toBeTruthy();
  });

  it("renders event pins for events with coordinates", () => {
    const { container } = render(() => <ExploreMap events={eventsWithGeo} />);
    // Each pin has an SVG with a pin path
    const pinSvgs = container.querySelectorAll("svg[viewBox='0 0 34 42']");
    expect(pinSvgs.length).toBe(2);
  });

  it("does not render pins for events without coordinates", () => {
    const { container } = render(() => <ExploreMap events={[eventNoGeo]} />);
    const pinSvgs = container.querySelectorAll("svg[viewBox='0 0 34 42']");
    expect(pinSvgs.length).toBe(0);
  });

  it("renders time scrubber with 'HEAT AT' label", () => {
    const { getByText } = render(() => <ExploreMap events={eventsWithGeo} />);
    expect(getByText("HEAT AT")).toBeTruthy();
  });

  it("renders time scrubber range input", () => {
    const { container } = render(() => <ExploreMap events={eventsWithGeo} />);
    const slider = container.querySelector("input[type='range']") as HTMLInputElement;
    expect(slider).toBeTruthy();
    expect(slider.min).toBe("0");
    expect(slider.max).toBe("23");
  });

  it("renders time tick labels", () => {
    const { getByText } = render(() => <ExploreMap events={eventsWithGeo} />);
    expect(getByText("12AM")).toBeTruthy();
    expect(getByText("NOON")).toBeTruthy();
    expect(getByText("11PM")).toBeTruthy();
  });

  it("renders legend with heat scale labels", () => {
    const { getByText } = render(() => <ExploreMap events={eventsWithGeo} />);
    expect(getByText("Heat · people here")).toBeTruthy();
    expect(getByText("quiet")).toBeTruthy();
    expect(getByText("bustling")).toBeTruthy();
    expect(getByText("packed")).toBeTruthy();
  });

  it("renders zoom/layer control buttons", () => {
    const { container } = render(() => <ExploreMap events={eventsWithGeo} />);
    expect(container.querySelector("[title='Zoom in']")).toBeTruthy();
    expect(container.querySelector("[title='Layers']")).toBeTruthy();
  });

  it("renders neighborhood labels in SVG", () => {
    const { container } = render(() => <ExploreMap events={eventsWithGeo} />);
    const texts = Array.from(container.querySelectorAll("svg text"));
    const labels = texts.map((t) => t.textContent);
    expect(labels).toContain("WILLIAMSBURG");
    expect(labels).toContain("PROSPECT PARK");
    expect(labels).toContain("PARK SLOPE");
    expect(labels).toContain("BED–STUY");
  });

  it("mixes geo and non-geo events — only pins for geo events", () => {
    const mixed = [...eventsWithGeo, eventNoGeo];
    const { container } = render(() => <ExploreMap events={mixed} />);
    const pinSvgs = container.querySelectorAll("svg[viewBox='0 0 34 42']");
    expect(pinSvgs.length).toBe(2);
  });

  it("renders with empty event list without crashing", () => {
    const { container } = render(() => <ExploreMap events={[]} />);
    expect(container.querySelector("svg")).toBeTruthy(); // base map still renders
    const pinSvgs = container.querySelectorAll("svg[viewBox='0 0 34 42']");
    expect(pinSvgs.length).toBe(0);
  });
});
