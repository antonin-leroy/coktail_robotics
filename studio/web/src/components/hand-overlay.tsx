import type { Keypoints } from '@/lib/api'

// MediaPipe-style: one color per finger, so a left/right or finger swap is easy to spot.
const GROUP_COLORS: Record<string, string> = {
  arm: '#e5e7eb',
  palm: '#e5e7eb',
  thumb: '#f97316',
  index: '#a855f7',
  middle: '#facc15',
  ring: '#22c55e',
  little: '#3b82f6',
}

/** Skeleton of one frame drawn over a video whose box has the image's aspect ratio. */
export function HandOverlay({
  keypoints,
  frame,
  width,
  height,
}: {
  keypoints: Extract<Keypoints, { available: true }>
  frame: number
  width: number
  height: number
}) {
  const points = keypoints.frames[Math.min(Math.max(frame, 0), keypoints.frames.length - 1)] ?? []
  const at = (i: number) => {
    const p = points[i]
    return p && [p[0] * width, p[1] * height]
  }
  const stroke = width / 320
  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="pointer-events-none absolute inset-0 size-full">
      {keypoints.edges.map(([i, j, group], k) => {
        const a = at(i)
        const b = at(j)
        if (!a || !b) return null
        return (
          <line
            key={k}
            x1={a[0]}
            y1={a[1]}
            x2={b[0]}
            y2={b[1]}
            stroke={GROUP_COLORS[group] ?? '#fff'}
            strokeWidth={stroke}
            strokeLinecap="round"
          />
        )
      })}
      {points.map((p, i) =>
        p ? (
          <circle
            key={i}
            cx={p[0] * width}
            cy={p[1] * height}
            r={stroke * 1.4}
            fill={keypoints.joints[i].startsWith('left') ? '#ef4444' : '#0ea5e9'}
            stroke="#fff"
            strokeWidth={stroke / 2}
          />
        ) : null,
      )}
    </svg>
  )
}
