interface WaxSealProps {
  size?: number
  class?: string
}

export function WaxSeal(props: WaxSealProps) {
  const size = props.size ?? 200
  const cx = size / 2
  const cy = size / 2
  const r = size * 0.42

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      class={props.class}
      aria-hidden="true"
    >
      <defs>
        {/* Drop shadow */}
        <filter id="wax-shadow" x="-20%" y="-20%" width="140%" height="160%">
          <feDropShadow
            dx="0"
            dy="10"
            stdDeviation="14"
            flood-color="#000"
            flood-opacity="0.7"
          />
        </filter>

        {/* Radial gradient for wax */}
        <radialGradient id="wax-grad" cx="42%" cy="38%" r="58%">
          <stop offset="0%" stop-color="#2d5e35" />
          <stop offset="45%" stop-color="#1a3d20" />
          <stop offset="100%" stop-color="#0e2213" />
        </radialGradient>

        {/* Noise / turbulence texture */}
        <filter id="wax-texture" x="0%" y="0%" width="100%" height="100%">
          <feTurbulence
            type="fractalNoise"
            baseFrequency="0.85"
            numOctaves="4"
            seed="3"
            result="noise"
          />
          <feColorMatrix type="saturate" values="0" in="noise" result="grey" />
          <feBlend
            in="SourceGraphic"
            in2="grey"
            mode="overlay"
            result="blended"
          />
          <feComponentTransfer in="blended">
            <feFuncA type="linear" slope="0.04" />
          </feComponentTransfer>
          <feComposite in="SourceGraphic" operator="over" />
        </filter>

        {/* Stamped monogram depth */}
        <filter id="stamp-depth" x="-10%" y="-10%" width="120%" height="120%">
          <feOffset dx="0" dy="1.5" result="shadow" />
          <feFlood flood-color="#0a1a0c" flood-opacity="0.8" result="color" />
          <feComposite
            in="color"
            in2="shadow"
            operator="in"
            result="darkShadow"
          />
          <feBlend in="SourceGraphic" in2="darkShadow" mode="multiply" />
        </filter>
      </defs>

      {/* Wax blob — irregular circle with drips */}
      <g filter="url(#wax-shadow)">
        <path
          d={`
            M ${cx} ${cy - r}
            C ${cx + r * 0.35} ${cy - r * 1.06},
              ${cx + r * 1.06} ${cy - r * 0.35},
              ${cx + r * 1.04} ${cy + r * 0.05}
            C ${cx + r * 1.08} ${cy + r * 0.48},
              ${cx + r * 0.62} ${cy + r * 0.95},
              ${cx + r * 0.18} ${cy + r * 1.02}
            C ${cx + r * 0.08} ${cy + r * 1.18},
              ${cx + r * 0.04} ${cy + r * 1.32},
              ${cx} ${cy + r * 1.28}
            C ${cx - r * 0.04} ${cy + r * 1.32},
              ${cx - r * 0.08} ${cy + r * 1.2},
              ${cx - r * 0.15} ${cy + r * 1.05}
            C ${cx - r * 0.55} ${cy + r * 1.0},
              ${cx - r * 1.06} ${cy + r * 0.52},
              ${cx - r * 1.04} ${cy + r * 0.04}
            C ${cx - r * 1.08} ${cy - r * 0.38},
              ${cx - r * 0.35} ${cy - r * 1.07},
              ${cx} ${cy - r}
            Z
          `}
          fill="url(#wax-grad)"
        />
      </g>

      {/* Texture overlay on wax blob */}
      <path
        d={`
          M ${cx} ${cy - r}
          C ${cx + r * 0.35} ${cy - r * 1.06},
            ${cx + r * 1.06} ${cy - r * 0.35},
            ${cx + r * 1.04} ${cy + r * 0.05}
          C ${cx + r * 1.08} ${cy + r * 0.48},
            ${cx + r * 0.62} ${cy + r * 0.95},
            ${cx + r * 0.18} ${cy + r * 1.02}
          C ${cx + r * 0.08} ${cy + r * 1.18},
            ${cx + r * 0.04} ${cy + r * 1.32},
            ${cx} ${cy + r * 1.28}
          C ${cx - r * 0.04} ${cy + r * 1.32},
            ${cx - r * 0.08} ${cy + r * 1.2},
            ${cx - r * 0.15} ${cy + r * 1.05}
          C ${cx - r * 0.55} ${cy + r * 1.0},
            ${cx - r * 1.06} ${cy + r * 0.52},
            ${cx - r * 1.04} ${cy + r * 0.04}
          C ${cx - r * 1.08} ${cy - r * 0.38},
            ${cx - r * 0.35} ${cy - r * 1.07},
            ${cx} ${cy - r}
          Z
        `}
        fill="white"
        opacity="0.04"
        filter="url(#wax-texture)"
      />

      {/* Light reflection arc top-left */}
      <ellipse
        cx={cx - r * 0.22}
        cy={cy - r * 0.36}
        rx={r * 0.28}
        ry={r * 0.1}
        fill="white"
        opacity="0.12"
        transform={`rotate(-32, ${cx - r * 0.22}, ${cy - r * 0.36})`}
      />

      {/* Outer decorative ring */}
      <circle
        cx={cx}
        cy={cy}
        r={r * 0.81}
        fill="none"
        stroke="rgba(201,169,110,0.20)"
        stroke-width="0.5"
      />

      {/* Inner decorative ring */}
      <circle
        cx={cx}
        cy={cy}
        r={r * 0.74}
        fill="none"
        stroke="rgba(201,169,110,0.40)"
        stroke-width="1.5"
      />

      {/* Compass point dots on inner ring */}
      {[0, 90, 180, 270].map((angle) => {
        const rad = (angle * Math.PI) / 180
        const dotR = r * 0.74
        const dx = cx + dotR * Math.sin(rad)
        const dy = cy - dotR * Math.cos(rad)
        return <circle cx={dx} cy={dy} r={1.8} fill="rgba(201,169,110,0.55)" />
      })}

      {/* Monogram C */}
      <text
        x={cx}
        y={cy + r * 0.24}
        text-anchor="middle"
        font-family="'Cormorant Garamond', Georgia, serif"
        font-size={r * 0.76}
        font-style="italic"
        font-weight="300"
        fill="rgba(201,169,110,0.65)"
        filter="url(#stamp-depth)"
      >
        C
      </text>
    </svg>
  )
}
