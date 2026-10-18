import { memo, useMemo, useState } from 'react'
import { Line, LineChart, ReferenceLine, XAxis, YAxis } from 'recharts'

import { ChartContainer, type ChartConfig } from '@/components/ui/chart'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import type { Signals } from '@/lib/api'

const MAX_POINTS = 300

type LineSpec = { label: string; color: string; dashed?: boolean }
type View = {
  id: string
  label: string
  lines: LineSpec[]
  rows: { name: string; values: number[][] }[]
  // Each line on its own scale (x/y/z positions differ by metres; state vs action share one).
  perLineScale?: boolean
}

// Robot: measured state vs commanded action. Human (e.g. EgoDex): each tracked joint's 3D position.
const POSITION: LineSpec[] = [
  { label: 'observation.state', color: 'var(--chart-1)' },
  { label: 'action', color: 'var(--chart-3)', dashed: true },
]
const XYZ: LineSpec[] = [
  { label: 'x', color: 'var(--chart-1)' },
  { label: 'y', color: 'var(--chart-2)' },
  { label: 'z', color: 'var(--chart-3)' },
]

function buildViews(signals: Signals): View[] {
  const views: View[] = []
  const state = signals.series['observation.state']
  const action = signals.series['action']
  const base = state ?? action
  if (base) {
    views.push({
      id: 'position',
      label: 'state / action',
      lines: state && action ? POSITION : [{ ...POSITION[state ? 0 : 1], dashed: false }],
      rows: base.names.map((name, j) => ({
        name,
        values: [state?.values[j], action?.values[j]].filter((v): v is number[] => !!v),
      })),
    })
  }
  const poses = Object.entries(signals.series).filter(([, s]) => s.kind === 'pose')
  if (poses.length) {
    views.push({
      id: 'poses',
      label: 'positions xyz',
      lines: XYZ,
      perLineScale: true,
      // Arms and hands first: that's what manipulation is about.
      rows: poses
        .map(([key, s]) => ({ name: key.replace(/^observation\.state\./, ''), values: s.values }))
        .sort((a, b) => Number(!/^(left|right)/.test(a.name)) - Number(!/^(left|right)/.test(b.name))),
    })
  }
  for (const [key, s] of Object.entries(signals.series)) {
    if (key === 'observation.state' || key === 'action' || s.kind === 'pose') continue
    views.push({
      id: key,
      label: key.replace(/^observation\./, ''),
      lines: [{ label: key, color: 'var(--chart-1)' }],
      rows: s.names.map((name, j) => ({ name, values: [s.values[j]] })),
    })
  }
  return views
}

/** One row per joint: name and range, its lines over the episode, values at the cursor. */
export function SignalRows({ signals, t, onSeek }: { signals: Signals; t: number; onSeek: (t: number) => void }) {
  const views = useMemo(() => buildViews(signals), [signals])
  const [viewId, setViewId] = useState<string | null>(null)
  const view = views.find((v) => v.id === viewId) ?? views[0]

  const rows = useMemo(() => {
    if (!view) return []
    const t0 = signals.timestamps[0] ?? 0
    const stride = Math.max(1, Math.ceil(signals.timestamps.length / MAX_POINTS))
    const idx = signals.timestamps.map((_, i) => i).filter((i) => i % stride === 0)
    return view.rows.map((r) => {
      const all = r.values.flat()
      const bounds = r.values.map((v) => [Math.min(...v), Math.max(...v)])
      return {
        ...r,
        min: Math.min(...all),
        max: Math.max(...all),
        points: idx.map((i) => {
          const p: Record<string, number> = { t: signals.timestamps[i] - t0 }
          r.values.forEach((v, k) => {
            const [lo, hi] = bounds[k]
            p[`l${k}`] = !view.perLineScale ? v[i] : hi > lo ? (v[i] - lo) / (hi - lo) : 0.5
          })
          return p
        }),
      }
    })
  }, [signals, view])

  const frame = useMemo(() => {
    const t0 = signals.timestamps[0] ?? 0
    let lo = 0
    let hi = signals.timestamps.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (signals.timestamps[mid] - t0 <= t) lo = mid
      else hi = mid - 1
    }
    return lo
  }, [signals, t])

  if (!view) return <div className="px-5 py-4 text-sm text-muted-foreground">No numeric signals in this dataset.</div>

  return (
    <div>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-b px-5 py-3 text-sm">
        <span className="font-medium">Joints</span>
        {view.lines.map((l) => (
          <Legend key={l.label} {...l} />
        ))}
        {views.length > 1 && (
          <ToggleGroup
            type="single"
            variant="outline"
            size="sm"
            value={view.id}
            onValueChange={(v) => v && setViewId(v)}
            className="ml-auto"
          >
            {views.map((v) => (
              <ToggleGroupItem key={v.id} value={v.id} className="px-2.5 font-mono text-xs">
                {v.label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        )}
      </div>
      <div className="divide-y">
        {rows.map((r) => (
          <JointRow
            key={r.name}
            name={r.name}
            min={r.min}
            max={r.max}
            domain={view.perLineScale ? [0, 1] : [r.min, r.max]}
            points={r.points}
            lines={view.lines}
            current={r.values.map((v) => v[frame])}
            t={t}
            onSeek={onSeek}
          />
        ))}
      </div>
    </div>
  )
}

function Legend({ label, color, dashed }: LineSpec) {
  return (
    <span className="flex items-center gap-1.5 font-mono text-xs text-muted-foreground">
      {dashed ? (
        <span className="flex gap-0.5">
          {[0, 1, 2].map((i) => (
            <span key={i} className="h-0.5 w-1 rounded" style={{ background: color }} />
          ))}
        </span>
      ) : (
        <span className="h-0.5 w-4 rounded" style={{ background: color }} />
      )}
      {label}
    </span>
  )
}

const fmt = (v: number | undefined) =>
  v == null ? '—' : Math.abs(v) >= 100 ? v.toFixed(1) : Math.abs(v) >= 1 ? v.toFixed(2) : v.toFixed(3)

const JointRow = memo(function JointRow(props: {
  name: string
  min: number
  max: number
  domain: [number, number]
  points: Record<string, number>[]
  lines: LineSpec[]
  current: (number | undefined)[]
  t: number
  onSeek: (t: number) => void
}) {
  const config: ChartConfig = Object.fromEntries(props.lines.map((l, k) => [`l${k}`, { label: l.label, color: l.color }]))
  return (
    <div className="grid grid-cols-[10rem_1fr_4.5rem] items-center gap-4 px-5 py-2 sm:grid-cols-[13rem_1fr_5.5rem]">
      <div className="min-w-0">
        <div className="truncate font-mono text-sm" title={props.name}>
          {props.name}
        </div>
        <div className="font-mono text-xs text-muted-foreground tabular-nums">
          {fmt(props.min)} – {fmt(props.max)}
        </div>
      </div>
      <ChartContainer config={config} className="aspect-auto h-12 w-full cursor-pointer">
        <LineChart
          data={props.points}
          margin={{ top: 4, right: 0, bottom: 4, left: 0 }}
          onClick={(e) => e?.activeLabel != null && props.onSeek(Number(e.activeLabel))}
        >
          <XAxis dataKey="t" type="number" domain={['dataMin', 'dataMax']} hide />
          <YAxis domain={props.domain} hide />
          {props.lines.map((l, k) => (
            <Line
              key={k}
              dataKey={`l${k}`}
              stroke={`var(--color-l${k})`}
              strokeWidth={l.dashed ? 1.5 : 2}
              strokeDasharray={l.dashed ? '4 3' : undefined}
              dot={false}
              isAnimationActive={false}
            />
          ))}
          <ReferenceLine x={props.t} stroke="var(--muted-foreground)" strokeOpacity={0.6} />
        </LineChart>
      </ChartContainer>
      <div className="text-right font-mono text-sm leading-tight tabular-nums">
        {props.current.map((v, k) => (
          <div key={k} className={k > 0 && props.lines.length === 2 ? 'text-muted-foreground' : undefined}>
            {props.lines.length === 3 && <span className="mr-1 text-xs text-muted-foreground">{props.lines[k].label}</span>}
            {fmt(v)}
          </div>
        ))}
      </div>
    </div>
  )
})
