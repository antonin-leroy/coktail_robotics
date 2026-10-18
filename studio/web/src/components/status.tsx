import { Badge } from '@/components/ui/badge'
import type { DatasetKind, RunStatus } from '@/lib/api'
import { cn } from '@/lib/utils'

const RUN_STYLE: Record<RunStatus, string> = {
  queued: 'bg-muted text-muted-foreground',
  submitting: 'bg-chart-3/15 text-chart-3',
  running: 'bg-chart-1/12 text-chart-1',
  succeeded: 'bg-chart-2/15 text-chart-2',
  failed: 'bg-destructive/12 text-destructive',
  canceled: 'bg-muted text-muted-foreground',
}

export function RunStatusBadge({ status }: { status: RunStatus }) {
  return (
    <Badge variant="secondary" className={cn('gap-1.5 capitalize', RUN_STYLE[status])}>
      {(status === 'running' || status === 'submitting') && (
        <span className="size-1.5 animate-pulse rounded-full bg-current" />
      )}
      {status}
    </Badge>
  )
}

const KIND_STYLE: Record<DatasetKind, string> = {
  teleop: 'bg-chart-1/12 text-chart-1',
  egocentric: 'bg-chart-4/12 text-chart-4',
  sim: 'bg-chart-3/15 text-chart-3',
  other: 'bg-muted text-muted-foreground',
}

export const KIND_LABEL: Record<DatasetKind, string> = {
  teleop: 'Teleop',
  egocentric: 'Egocentric',
  sim: 'Simulation',
  other: 'Other',
}

export function KindBadge({ kind }: { kind: DatasetKind }) {
  return (
    <Badge variant="secondary" className={KIND_STYLE[kind]}>
      {KIND_LABEL[kind]}
    </Badge>
  )
}

export function Sparkline({ values, className }: { values: number[]; className?: string }) {
  if (values.length < 2) return <div className={cn('h-6 w-28', className)} />
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min || 1
  const points = values
    .map((v, i) => `${(i / (values.length - 1)) * 100},${22 - ((v - min) / span) * 20}`)
    .join(' ')
  return (
    <svg viewBox="0 0 100 24" preserveAspectRatio="none" className={cn('h-6 w-28 text-chart-1', className)}>
      <polyline points={points} fill="none" stroke="currentColor" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  )
}

export function StatusDot({ className, style }: { className?: string; style?: React.CSSProperties }) {
  return <span className={cn('inline-block size-2.5 rounded-full', className)} style={style} />
}
