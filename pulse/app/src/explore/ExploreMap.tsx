import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";

import type { EventItem } from "../lib/types";
import { Icon } from "./icons";

// NYC bounding box for coordinate projection
const BBOX = { minLng: -74.03, maxLng: -73.88, minLat: 40.63, maxLat: 40.76 };

function proj(lat: number, lng: number, w: number, h: number): [number, number] {
  const x = ((lng - BBOX.minLng) / (BBOX.maxLng - BBOX.minLng)) * w;
  const y = (1 - (lat - BBOX.minLat) / (BBOX.maxLat - BBOX.minLat)) * h;
  return [x, y];
}

// Category → pin color
const PIN_COLORS: Record<string, string> = {
  music: "oklch(0.68 0.18 38)",
  art: "oklch(0.62 0.16 280)",
  food: "oklch(0.68 0.17 60)",
  outdoor: "oklch(0.65 0.16 145)",
  sports: "oklch(0.65 0.16 200)",
  talks: "oklch(0.6 0.12 260)",
  late: "oklch(0.55 0.18 320)",
};

const CATEGORY_GLYPH: Record<string, string> = {
  music: "\u263C",
  art: "\u25A3",
  outdoor: "\u25B3",
  food: "\u2318",
  talks: "\u275D",
  sports: "\u25C7",
  late: "\u263E",
};

function fmtTime(d: Date) {
  let h = d.getHours();
  const m = d.getMinutes();
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return `${h}:${m.toString().padStart(2, "0")} ${ampm}`;
}

// Stylized SVG map background
function StyleMap(props: { width: number; height: number }) {
  const w = () => props.width;
  const h = () => props.height;
  const isDark = () =>
    document.documentElement.classList.contains("dark") || document.body.classList.contains("dark");

  const landFill = () => (isDark() ? "oklch(0.22 0.01 60)" : "oklch(0.97 0.008 80)");
  const waterFill = () => (isDark() ? "oklch(0.17 0.015 220)" : "oklch(0.94 0.03 230)");
  const parkFill = () => (isDark() ? "oklch(0.28 0.05 150)" : "oklch(0.93 0.06 140)");
  const roadStroke = () => (isDark() ? "oklch(0.3 0.008 60)" : "oklch(0.91 0.006 70)");
  const minorStroke = () => (isDark() ? "oklch(0.26 0.008 60)" : "oklch(0.95 0.006 70)");
  const labelColor = () => (isDark() ? "oklch(0.6 0.005 60)" : "oklch(0.55 0.01 60)");

  const vLines = () => {
    const lines: number[] = [];
    for (let x = 60; x < w() - 40; x += 34) lines.push(x);
    return lines;
  };
  const hLines = () => {
    const lines: number[] = [];
    for (let y = 60; y < h() - 40; y += 30) lines.push(y);
    return lines;
  };
  const avenues = () => vLines().filter((_, i) => i % 3 === 0);
  const streets = () => hLines().filter((_, i) => i % 3 === 0);

  return (
    <svg
      width={w()}
      height={h()}
      viewBox={`0 0 ${w()} ${h()}`}
      style={{ display: "block", background: landFill() }}
    >
      {/* Water: east river */}
      <path
        d={`M ${w() * 0.82} 0 C ${w() * 0.78} ${h() * 0.25} ${w() * 0.9} ${h() * 0.5} ${w() * 0.82} ${h()} L ${w()} ${h()} L ${w()} 0 Z`}
        fill={waterFill()}
      />
      {/* Water: harbor */}
      <path
        d={`M 0 ${h() * 0.78} C ${w() * 0.2} ${h() * 0.86} ${w() * 0.35} ${h() * 0.82} ${w() * 0.42} ${h()} L 0 ${h()} Z`}
        fill={waterFill()}
      />
      {/* Park */}
      <path
        d={`M ${w() * 0.22} ${h() * 0.45} Q ${w() * 0.28} ${h() * 0.4} ${w() * 0.36} ${h() * 0.44} Q ${w() * 0.42} ${h() * 0.5} ${w() * 0.4} ${h() * 0.62} Q ${w() * 0.3} ${h() * 0.68} ${w() * 0.22} ${h() * 0.62} Z`}
        fill={parkFill()}
        opacity="0.9"
      />
      {/* Minor streets */}
      <For each={hLines()}>
        {(y) => (
          <line x1="0" y1={y} x2={w() * 0.82} y2={y + 12} stroke={minorStroke()} stroke-width="1" />
        )}
      </For>
      <For each={vLines()}>
        {(x) => <line x1={x} y1="0" x2={x + 6} y2={h()} stroke={minorStroke()} stroke-width="1" />}
      </For>
      {/* Major roads */}
      <For each={streets()}>
        {(y) => (
          <line
            x1="0"
            y1={y}
            x2={w() * 0.82}
            y2={y + 12}
            stroke={roadStroke()}
            stroke-width="2.2"
          />
        )}
      </For>
      <For each={avenues()}>
        {(x) => <line x1={x} y1="0" x2={x + 6} y2={h()} stroke={roadStroke()} stroke-width="2.2" />}
      </For>
      {/* Labels */}
      <g
        fill={labelColor()}
        font-size="10"
        font-family="var(--font-mono)"
        letter-spacing="1.2"
        opacity="0.7"
      >
        <text x={w() * 0.15} y={h() * 0.18}>
          WILLIAMSBURG
        </text>
        <text x={w() * 0.12} y={h() * 0.35}>
          GREENPOINT
        </text>
        <text x={w() * 0.3} y={h() * 0.55}>
          PROSPECT PARK
        </text>
        <text x={w() * 0.15} y={h() * 0.68}>
          PARK SLOPE
        </text>
        <text x={w() * 0.55} y={h() * 0.75}>
          GOWANUS
        </text>
        <text x={w() * 0.08} y={h() * 0.82}>
          SUNSET PARK
        </text>
        <text x={w() * 0.5} y={h() * 0.25}>
          BUSHWICK
        </text>
        <text x={w() * 0.6} y={h() * 0.45}>
          BED–STUY
        </text>
      </g>
    </svg>
  );
}

function EventPin(props: { category: string; glyph: string }) {
  const color = () => PIN_COLORS[props.category] ?? "var(--foreground)";
  return (
    <div style={{ filter: "drop-shadow(0 2px 4px oklch(0 0 0 / 0.3))" }}>
      <svg width="34" height="42" viewBox="0 0 34 42" fill="none">
        <path
          d="M17 41 C 17 32, 4 28, 4 16 A13 13 0 1 1 30 16 C 30 28, 17 32, 17 41 Z"
          fill={color()}
        />
        <circle cx="17" cy="16" r="9.5" fill="white" />
        <text
          x="17"
          y="20"
          font-size="12"
          text-anchor="middle"
          font-family="var(--font-serif)"
          fill={color()}
        >
          {props.glyph}
        </text>
      </svg>
    </div>
  );
}

/** Canvas-based heatmap overlay. Intensity derived from event coordinates. */
function HeatmapCanvas(props: {
  events: EventItem[];
  width: number;
  height: number;
  hour: number;
}) {
  let canvasRef: HTMLCanvasElement | undefined;

  createEffect(() => {
    const c = canvasRef;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    const w = props.width;
    const h = props.height;
    c.width = w * dpr;
    c.height = h * dpr;
    c.style.width = w + "px";
    c.style.height = h + "px";
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);
    ctx.globalCompositeOperation = "lighter";

    for (const e of props.events) {
      if (e.latitude == null || e.longitude == null) continue;
      const [x, y] = proj(e.latitude, e.longitude, w, h);
      const eventHour = new Date(e.startTime).getHours();
      const diff = Math.abs(eventHour - props.hour);
      const timeFactor = Math.max(0, 1 - diff / 5);
      const weight = 15 * (0.3 + 0.7 * timeFactor);
      if (weight < 1) continue;

      const r = 50 + weight * 3.5;
      const intensity = Math.min(1, weight / 35);
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, `oklch(0.7 0.22 ${50 - intensity * 30} / ${0.35 + intensity * 0.45})`);
      g.addColorStop(0.4, `oklch(0.78 0.16 ${70 - intensity * 20} / ${0.18 + intensity * 0.22})`);
      g.addColorStop(1, "oklch(0.85 0.1 240 / 0)");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.globalCompositeOperation = "source-over";
  });

  return (
    <canvas
      ref={canvasRef}
      style={{ position: "absolute", inset: "0", "pointer-events": "none" }}
    />
  );
}

function TimeScrubber(props: { hour: number; onHourChange: (h: number) => void }) {
  const displayHour = () => {
    const h = props.hour % 24;
    const ampm = h >= 12 ? "pm" : "am";
    const disp = h % 12 || 12;
    return `${disp}:00 ${ampm}`;
  };
  const label = () => {
    const h = props.hour % 24;
    if (h < 6) return "late night";
    if (h < 11) return "morning";
    if (h < 14) return "lunch";
    if (h < 17) return "afternoon";
    if (h < 21) return "evening";
    return "tonight";
  };
  const pct = () => (props.hour / 23) * 100;

  return (
    <div
      class="rounded-xl border border-white/60 p-3"
      style={{
        background: "color-mix(in oklab, var(--card) 92%, transparent)",
        "backdrop-filter": "blur(14px)",
        "box-shadow": "var(--shadow-sm)",
      }}
    >
      <div class="mb-2.5 flex items-center justify-between text-[11.5px]">
        <span
          class="text-muted-foreground tracking-wider uppercase"
          style={{ "font-family": "var(--font-mono)", "font-size": "11px" }}
        >
          HEAT AT
        </span>
        <span
          style={{
            "font-family": "var(--font-serif)",
            "font-size": "19px",
            "letter-spacing": "-0.01em",
          }}
        >
          {displayHour()}{" "}
          <span
            class="text-muted-foreground text-[12px] italic"
            style={{ "font-family": "var(--font-sans)" }}
          >
            · {label()}
          </span>
        </span>
      </div>
      <input
        type="range"
        min="0"
        max="23"
        step="1"
        value={props.hour}
        onInput={(e) => props.onHourChange(parseInt(e.currentTarget.value))}
        class="explore-slider w-full"
        style={{
          background: `linear-gradient(90deg, var(--foreground) 0%, var(--foreground) ${pct()}%, var(--border) ${pct()}%, var(--border) 100%)`,
        }}
      />
      <div
        class="text-muted-foreground mt-1.5 flex justify-between text-[9.5px] tracking-wider uppercase"
        style={{ "font-family": "var(--font-mono)" }}
      >
        <span>12AM</span>
        <span>6</span>
        <span>NOON</span>
        <span>6</span>
        <span>11PM</span>
      </div>
    </div>
  );
}

function Legend() {
  return (
    <div
      class="absolute bottom-4 left-4 z-[3] min-w-[180px] rounded-xl border border-white/60 p-2.5"
      style={{
        background: "color-mix(in oklab, var(--card) 92%, transparent)",
        "backdrop-filter": "blur(14px)",
        "box-shadow": "var(--shadow-sm)",
      }}
    >
      <div class="text-muted-foreground mb-1.5 text-[10.5px] font-semibold tracking-widest uppercase">
        Heat · people here
      </div>
      <div class="legend-bar" />
      <div
        class="text-muted-foreground mt-[3px] flex justify-between text-[9.5px] tracking-wider"
        style={{ "font-family": "var(--font-mono)" }}
      >
        <span>quiet</span>
        <span>bustling</span>
        <span>packed</span>
      </div>
    </div>
  );
}

export function ExploreMap(props: {
  events: EventItem[];
  hoveredId?: string | null;
  onHoverEvent?: (id: string | null) => void;
}) {
  let wrapRef: HTMLDivElement | undefined;
  const [size, setSize] = createSignal({ w: 700, h: 900 });
  const [hour, setHour] = createSignal(new Date().getHours());
  const [hoveredPin, setHoveredPin] = createSignal<{
    event: EventItem;
    x: number;
    y: number;
  } | null>(null);

  onMount(() => {
    if (!wrapRef) return;
    const ro = new ResizeObserver((entries) => {
      for (const en of entries) {
        setSize({ w: en.contentRect.width, h: en.contentRect.height });
      }
    });
    ro.observe(wrapRef);
    onCleanup(() => ro.disconnect());
  });

  const geoEvents = createMemo(() =>
    props.events.filter((e) => e.latitude != null && e.longitude != null),
  );

  return (
    <div class="relative h-full w-full overflow-hidden" ref={wrapRef}>
      {/* SVG base map */}
      <div class="absolute inset-0">
        <StyleMap width={size().w} height={size().h} />
      </div>

      {/* Heatmap overlay */}
      <HeatmapCanvas events={geoEvents()} width={size().w} height={size().h} hour={hour()} />

      {/* Event pins */}
      <For each={geoEvents()}>
        {(e) => {
          const pos = () => proj(e.latitude!, e.longitude!, size().w, size().h);
          return (
            <div
              style={{
                position: "absolute",
                left: pos()[0] + "px",
                top: pos()[1] + "px",
                transform: "translate(-50%, -100%)",
                "z-index": "4",
                cursor: "pointer",
              }}
              onMouseEnter={() => {
                setHoveredPin({ event: e, x: pos()[0], y: pos()[1] });
                props.onHoverEvent?.(e.id);
              }}
              onMouseLeave={() => {
                setHoveredPin(null);
                props.onHoverEvent?.(null);
              }}
            >
              <EventPin
                category={e.category ?? ""}
                glyph={CATEGORY_GLYPH[e.category ?? ""] ?? "\u25C9"}
              />
            </div>
          );
        }}
      </For>

      {/* Hovered pin popup */}
      <Show when={hoveredPin()}>
        {(pin) => (
          <div
            class="pin-pop border-border bg-card absolute z-[5] rounded-[10px] border px-2.5 py-2 text-xs whitespace-nowrap shadow-lg"
            style={{
              left: pin().x + "px",
              top: pin().y + "px",
              transform: "translate(-50%, calc(-100% - 14px))",
              "pointer-events": "none",
            }}
          >
            <div class="font-semibold">
              {pin().event.title.length > 40
                ? pin().event.title.slice(0, 40) + "\u2026"
                : pin().event.title}
            </div>
            <div
              class="text-muted-foreground mt-0.5 text-[10.5px]"
              style={{ "font-family": "var(--font-mono)" }}
            >
              {pin().event.venue ?? ""} · {fmtTime(new Date(pin().event.startTime))}
            </div>
          </div>
        )}
      </Show>

      {/* Controls overlay */}
      <div class="absolute top-4 right-4 left-4 z-[3]">
        <TimeScrubber hour={hour()} onHourChange={setHour} />
      </div>

      {/* Legend */}
      <Legend />

      {/* Zoom controls */}
      <div class="border-border bg-card absolute right-4 bottom-4 z-[3] flex flex-col overflow-hidden rounded-[10px] border shadow-sm">
        <button
          type="button"
          class="hover:bg-secondary grid h-[34px] w-[34px] place-items-center"
          title="Zoom in"
        >
          <Icon name="plus" size={14} />
        </button>
        <div class="bg-border h-px" />
        <button
          type="button"
          class="hover:bg-secondary grid h-[34px] w-[34px] place-items-center"
          title="Layers"
        >
          <Icon name="layers" size={14} />
        </button>
      </div>
    </div>
  );
}
