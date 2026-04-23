import type { JSX } from "solid-js";

const common = {
  fill: "none",
  stroke: "currentColor",
  "stroke-width": "1.75",
  "stroke-linecap": "round" as const,
  "stroke-linejoin": "round" as const,
};

export function Icon(props: { name: string; size?: number }) {
  const s = () => ({ width: props.size ?? 16, height: props.size ?? 16 });

  const icons: Record<string, () => JSX.Element> = {
    search: () => (
      <svg {...s()} viewBox="0 0 24 24" {...common}>
        <circle cx="11" cy="11" r="7" />
        <path d="m20 20-3-3" />
      </svg>
    ),
    clock: () => (
      <svg {...s()} viewBox="0 0 24 24" {...common}>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5l3 2" />
      </svg>
    ),
    "map-pin": () => (
      <svg {...s()} viewBox="0 0 24 24" {...common}>
        <path d="M12 22s-7-7-7-12a7 7 0 0 1 14 0c0 5-7 12-7 12z" />
        <circle cx="12" cy="10" r="2.5" />
      </svg>
    ),
    bell: () => (
      <svg {...s()} viewBox="0 0 24 24" {...common}>
        <path d="M6 8a6 6 0 0 1 12 0c0 7 3 8 3 8H3s3-1 3-8" />
        <path d="M10 21a2 2 0 0 0 4 0" />
      </svg>
    ),
    filter: () => (
      <svg {...s()} viewBox="0 0 24 24" {...common}>
        <path d="M3 5h18M6 12h12M10 19h4" />
      </svg>
    ),
    plus: () => (
      <svg {...s()} viewBox="0 0 24 24" {...common}>
        <path d="M12 5v14M5 12h14" />
      </svg>
    ),
    "chevron-right": () => (
      <svg {...s()} viewBox="0 0 24 24" {...common}>
        <path d="m9 18 6-6-6-6" />
      </svg>
    ),
    layers: () => (
      <svg {...s()} viewBox="0 0 24 24" {...common}>
        <path d="m12 3 9 5-9 5-9-5 9-5z" />
        <path d="m3 13 9 5 9-5" />
      </svg>
    ),
    heart: () => (
      <svg {...s()} viewBox="0 0 24 24" {...common}>
        <path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.6l-1-1a5.5 5.5 0 0 0-7.8 7.8l1 1L12 21l7.8-7.8 1-1a5.5 5.5 0 0 0 0-7.6z" />
      </svg>
    ),
    zap: () => (
      <svg {...s()} viewBox="0 0 24 24" {...common}>
        <path d="M13 3 4 14h7l-1 7 9-11h-7l1-7z" />
      </svg>
    ),
  };

  return <>{icons[props.name]?.() ?? null}</>;
}
