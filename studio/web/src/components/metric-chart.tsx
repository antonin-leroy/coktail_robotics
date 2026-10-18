import { CartesianGrid, Line, LineChart, XAxis, YAxis } from 'recharts'

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart'
import { fmtNumber } from '@/lib/format'
import { cn } from '@/lib/utils'

const config: ChartConfig = {
  smooth: { label: 'Smoothed', color: 'var(--chart-1)' },
  value: { label: 'Raw', color: 'var(--chart-1)' },
}

const compact = (n: number) =>
  Math.abs(n) >= 1000 ? `${+(n / 1000).toFixed(1)}k` : Math.abs(n) < 0.01 && n !== 0 ? n.toExponential(0) : `${+n.toFixed(3)}`

/**
 * One metric over training steps. With smoothing, the raw series stays as a faint line
 * under the moving average (both computed by Postgres).
 */
export function MetricChart(props: {
  title: string
  points: { x: number; value: number; smooth?: number }[]
  xLabel?: (x: number) => string
  unit?: string
  smoothing?: boolean
  className?: string
  height?: string
}) {
  const last = props.points.at(-1)
  return (
    <Card className={cn('gap-2', props.className)}>
      <CardHeader className="flex flex-row items-baseline justify-between">
        <CardTitle className="font-mono text-sm font-normal text-muted-foreground">{props.title}</CardTitle>
        <span className="text-lg font-semibold tabular-nums">
          {last ? fmtNumber(props.smoothing ? (last.smooth ?? last.value) : last.value, 4) : '—'}
          {props.unit && <span className="ml-0.5 text-sm font-normal text-muted-foreground">{props.unit}</span>}
        </span>
      </CardHeader>
      <CardContent>
        {props.points.length === 0 ? (
          <div className={cn('flex items-center justify-center text-sm text-muted-foreground', props.height ?? 'h-44')}>
            Waiting for the first logged step…
          </div>
        ) : (
          <ChartContainer config={config} className={cn('aspect-auto w-full', props.height ?? 'h-44')}>
            <LineChart data={props.points} margin={{ left: 0, right: 8, top: 4 }}>
              <CartesianGrid vertical={false} strokeDasharray="3 3" />
              <XAxis
                dataKey="x"
                type="number"
                domain={['dataMin', 'dataMax']}
                tickLine={false}
                axisLine={false}
                tickFormatter={props.xLabel ?? compact}
                minTickGap={32}
              />
              <YAxis tickLine={false} axisLine={false} width={44} tickFormatter={compact} domain={['auto', 'auto']} />
              <ChartTooltip
                cursor={{ stroke: 'var(--muted-foreground)', strokeWidth: 1 }}
                content={
                  <ChartTooltipContent
                    labelFormatter={(_, p) => {
                      const x = Number(p?.[0]?.payload?.x)
                      return props.xLabel ? props.xLabel(x) : `step ${x.toLocaleString('en-US')}`
                    }}
                    valueFormatter={(v) => fmtNumber(v, 4)}
                  />
                }
              />
              {props.smoothing ? (
                <>
                  <Line
                    dataKey="value"
                    stroke="var(--color-value)"
                    strokeOpacity={0.25}
                    strokeWidth={1.5}
                    dot={false}
                    isAnimationActive={false}
                  />
                  <Line dataKey="smooth" stroke="var(--color-smooth)" strokeWidth={2} dot={false} isAnimationActive={false} />
                </>
              ) : (
                <Line dataKey="value" stroke="var(--color-value)" strokeWidth={2} dot={false} isAnimationActive={false} />
              )}
            </LineChart>
          </ChartContainer>
        )}
      </CardContent>
    </Card>
  )
}
