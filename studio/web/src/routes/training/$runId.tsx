import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { Ban, ExternalLink, Loader2, RotateCcw, Sparkles, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'

import { POLICY_NAMES } from '@/components/charts'
import { MetricChart } from '@/components/metric-chart'
import { PageBody, PageHeader } from '@/components/page'
import { RunStatusBadge } from '@/components/status'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { Progress } from '@/components/ui/progress'
import { Skeleton } from '@/components/ui/skeleton'
import { Slider } from '@/components/ui/slider'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { api } from '@/lib/api'
import { cameraLabel, fmtDuration, fmtInt, fmtNumber, fmtUsd } from '@/lib/format'

export const Route = createFileRoute('/training/$runId')({ component: RunPage })

const ACTIVE = ['queued', 'submitting', 'running']

const CHARTS: { key: string; title: string; unit?: string; smooth?: boolean }[] = [
  { key: 'grad_norm', title: 'grad_norm', smooth: true },
  { key: 'lr', title: 'learning rate' },
  { key: 'samples_per_s', title: 'throughput', unit: 'samples/s', smooth: true },
  { key: 'update_s', title: 'update time', unit: 's', smooth: true },
  { key: 'dataloading_s', title: 'data loading time', unit: 's', smooth: true },
  { key: 'gpu_mem_gb', title: 'peak GPU memory (torch)', unit: 'GB' },
]

function RunPage() {
  const { runId } = Route.useParams()
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [smoothing, setSmoothing] = useState(10)

  const run = useQuery({ queryKey: ['run', runId], queryFn: () => api.run(runId) })
  const active = run.data ? ACTIVE.includes(run.data.status) : false
  // SSE invalidates ['run', id] on every new step; metrics follow it.
  const metrics = useQuery({
    queryKey: ['run', runId, 'metrics', smoothing],
    queryFn: () => api.runMetrics(runId, smoothing),
    placeholderData: (prev) => prev,
  })
  const logs = useQuery({
    queryKey: ['run', runId, 'logs'],
    queryFn: () => api.runLogs(runId),
    refetchInterval: active ? 3000 : false,
  })

  const cancel = useMutation({
    mutationFn: () => api.cancelRun(runId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['run', runId] }),
    onError: (e) => toast.error('Cancel failed', { description: e.message }),
  })
  const rerun = useMutation({
    mutationFn: () => api.rerun(runId),
    onSuccess: ({ id }) => {
      qc.invalidateQueries({ queryKey: ['runs'] })
      navigate({ to: '/training/$runId', params: { runId: id } })
    },
    onError: (e) => toast.error('Rerun refused', { description: e.message }),
  })
  const remove = useMutation({
    mutationFn: () => api.deleteRun(runId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['runs'] })
      navigate({ to: '/training' })
    },
    onError: (e) => toast.error('Delete failed', { description: e.message }),
  })

  const series = metrics.data?.series ?? {}
  const toPoints = (key: string) => (series[key] ?? []).map((p) => ({ x: p.step, value: p.value, smooth: p.smooth }))
  const system = metrics.data?.system ?? []
  const r = run.data

  return (
    <>
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            <Link to="/training" className="text-muted-foreground hover:text-foreground">
              Runs
            </Link>
            <span className="text-muted-foreground">/</span>
            <span className="truncate">{r?.name ?? '…'}</span>
            {r && <RunStatusBadge status={r.status} />}
          </span>
        }
      >
        {r?.skill_id && (
          <Button variant="outline" asChild>
            <Link to="/skills/$skillId" params={{ skillId: r.skill_id }}>
              <Sparkles /> Skill
            </Link>
          </Button>
        )}
        {r?.hf_job_url && (
          <Button variant="outline" asChild>
            <a href={r.hf_job_url} target="_blank" rel="noreferrer">
              <ExternalLink /> HF job
            </a>
          </Button>
        )}
        {r && active && (
          <Button variant="outline" onClick={() => cancel.mutate()} disabled={cancel.isPending}>
            <Ban /> Cancel
          </Button>
        )}
        {r && !active && (
          <Button variant={r.status === 'succeeded' ? 'outline' : 'default'} onClick={() => rerun.mutate()} disabled={rerun.isPending}>
            {rerun.isPending ? <Loader2 className="animate-spin" /> : <RotateCcw />} Rerun
          </Button>
        )}
        {r && !active && (
          <Button variant="ghost" size="icon" onClick={() => remove.mutate()} aria-label="Delete run">
            <Trash2 />
          </Button>
        )}
      </PageHeader>
      <PageBody>
        {!r ? (
          <Skeleton className="h-96" />
        ) : (
          <>
            {r.status === 'failed' && r.error && (
              <Alert variant="destructive">
                <AlertTitle>Run failed</AlertTitle>
                <AlertDescription className="font-mono text-xs whitespace-pre-wrap">{r.error}</AlertDescription>
              </Alert>
            )}
            {r.status === 'succeeded' && (
              <Alert>
                <Sparkles />
                <AlertTitle>Model pushed to the Hub and registered as a skill</AlertTitle>
                <AlertDescription>
                  <a className="font-mono underline" href={`https://huggingface.co/${r.model_repo_id}`} target="_blank" rel="noreferrer">
                    {r.model_repo_id}
                  </a>
                </AlertDescription>
              </Alert>
            )}

            <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
              <Card className="col-span-2 gap-2 px-5 py-4">
                <div className="flex items-baseline justify-between text-sm text-muted-foreground">
                  Step
                  <span className="tabular-nums">{((100 * r.last_step) / r.total_steps).toFixed(0)}%</span>
                </div>
                <div className="text-2xl font-semibold tabular-nums">
                  {fmtInt(r.last_step)}
                  <span className="text-base font-normal text-muted-foreground"> / {fmtInt(r.total_steps)}</span>
                </div>
                <Progress value={(100 * r.last_step) / r.total_steps} className="h-1.5" />
              </Card>
              <Stat label="Loss (best)" value={fmtNumber(r.min_loss)} />
              <Stat label="Duration" value={fmtDuration(r.duration_s)} />
              <Stat label="Cost" value={fmtUsd(r.cost_usd)} hint={r.flavor} />
            </div>

            <Tabs defaultValue="metrics">
              <div className="flex flex-wrap items-center justify-between gap-4">
                <TabsList>
                  <TabsTrigger value="metrics">Metrics</TabsTrigger>
                  <TabsTrigger value="system">System</TabsTrigger>
                  <TabsTrigger value="logs">Logs</TabsTrigger>
                  <TabsTrigger value="config">Config</TabsTrigger>
                </TabsList>
                <div className="flex w-64 items-center gap-3">
                  <Label className="shrink-0 text-sm text-muted-foreground">Smoothing</Label>
                  <Slider min={0} max={50} step={1} value={[smoothing]} onValueChange={([v]) => setSmoothing(v)} />
                  <span className="w-6 text-right text-sm tabular-nums">{smoothing}</span>
                </div>
              </div>

              <TabsContent value="metrics" className="mt-4 flex flex-col gap-4">
                <MetricChart title="loss" points={toPoints('loss')} smoothing={smoothing > 0} height="h-72" />
                <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                  {CHARTS.filter((c) => series[c.key]).map((c) => (
                    <MetricChart
                      key={c.key}
                      title={c.title}
                      unit={c.unit}
                      points={toPoints(c.key)}
                      smoothing={c.smooth && smoothing > 0}
                    />
                  ))}
                </div>
              </TabsContent>

              <TabsContent value="system" className="mt-4 grid gap-4 md:grid-cols-2">
                <MetricChart
                  title="GPU utilization"
                  unit="%"
                  points={system.filter((s) => s.gpu_util != null).map((s) => ({ x: s.t, value: s.gpu_util! }))}
                  xLabel={(x) => fmtDuration(x)}
                />
                <MetricChart
                  title="GPU memory"
                  unit="GB"
                  points={system.filter((s) => s.gpu_mem_gb != null).map((s) => ({ x: s.t, value: s.gpu_mem_gb! }))}
                  xLabel={(x) => fmtDuration(x)}
                />
                <MetricChart
                  title="CPU"
                  unit="%"
                  points={system.filter((s) => s.cpu_pct != null).map((s) => ({ x: s.t, value: s.cpu_pct! }))}
                  xLabel={(x) => fmtDuration(x)}
                />
                <MetricChart
                  title="RAM"
                  unit="GB"
                  points={system.filter((s) => s.ram_gb != null).map((s) => ({ x: s.t, value: s.ram_gb! }))}
                  xLabel={(x) => fmtDuration(x)}
                />
              </TabsContent>

              <TabsContent value="logs" className="mt-4">
                <LogView lines={logs.data?.map((l) => l.line) ?? []} follow={active} />
              </TabsContent>

              <TabsContent value="config" className="mt-4 grid gap-4 lg:grid-cols-2">
                <Card>
                  <CardHeader>
                    <CardTitle>Setup</CardTitle>
                  </CardHeader>
                  <CardContent className="grid grid-cols-[minmax(0,1fr)] gap-3 text-sm">
                    <Row label="Policy" value={POLICY_NAMES[r.policy] ?? r.policy} />
                    <Row label="Robot dataset" value={r.dataset_repo_id} mono />
                    {r.ego_repo_id && <Row label="Egocentric dataset" value={r.ego_repo_id} mono />}
                    <Row
                      label="Cameras"
                      value={
                        <div className="flex flex-wrap justify-end gap-1">
                          {r.cameras?.map((c) => (
                            <Badge key={c} variant="outline">
                              {cameraLabel(c)}
                            </Badge>
                          ))}
                        </div>
                      }
                    />
                    <Row label="Steps × batch" value={`${fmtInt(r.total_steps)} × ${r.spec?.batch_size}`} />
                    <Row label="Epochs (planned)" value={r.spec?.epochs?.toFixed(1) ?? '—'} />
                    <Row label="Hardware" value={r.flavor} mono />
                    <Row label="Model repo" value={r.model_repo_id} mono />
                    <Row label="HF job" value={r.hf_job_id ?? '—'} mono />
                  </CardContent>
                </Card>
                <Card>
                  <CardHeader>
                    <CardTitle>Job command</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <pre className="max-h-96 overflow-auto rounded-lg bg-muted p-3 font-mono text-[11px] leading-relaxed">
                      {r.spec?.script}
                    </pre>
                  </CardContent>
                </Card>
              </TabsContent>
            </Tabs>
          </>
        )}
      </PageBody>
    </>
  )
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Card className="gap-1 px-5 py-4">
      <div className="text-sm text-muted-foreground">{label}</div>
      <div className="text-2xl font-semibold tabular-nums">{value}</div>
      {hint && <div className="font-mono text-xs text-muted-foreground">{hint}</div>}
    </Card>
  )
}

function Row({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className={mono ? 'min-w-0 truncate text-right font-mono text-xs leading-5' : 'text-right'}>{value}</span>
    </div>
  )
}

function LogView({ lines, follow }: { lines: string[]; follow: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  const text = useMemo(() => lines.join('\n'), [lines])
  useEffect(() => {
    if (follow && ref.current) ref.current.scrollTop = ref.current.scrollHeight
  }, [text, follow])
  return (
    <Card className="py-0">
      <div ref={ref} className="h-[32rem] overflow-auto p-4">
        <pre className="font-mono text-xs leading-relaxed whitespace-pre-wrap">
          {text || 'No log lines yet. The job is starting (pulling the image and the dataset can take a few minutes).'}
        </pre>
      </div>
    </Card>
  )
}
