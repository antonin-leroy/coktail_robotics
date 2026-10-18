import { useMutation, useQuery } from '@tanstack/react-query'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { AlertCircle, AlertTriangle, Check, ChevronRight, Layers, Loader2, Rocket } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'

import { CameraFramesDialog } from '@/components/camera-frames-dialog'
import { PageBody, PageHeader } from '@/components/page'
import { KindBadge } from '@/components/status'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useDebounced } from '@/hooks/use-debounced'
import { api, type Camera, type Issue, type Policy, type TrainSpec } from '@/lib/api'
import { cameraLabel, fmtDuration, fmtInt, fmtUsd, shortRepo } from '@/lib/format'
import { cn } from '@/lib/utils'

export const Route = createFileRoute('/training/new')({
  validateSearch: (s: Record<string, unknown>): { dataset?: string; ego?: string } => ({
    dataset: typeof s.dataset === 'string' ? s.dataset : undefined,
    ego: typeof s.ego === 'string' ? s.ego : undefined,
  }),
  component: NewRun,
})

const NONE = '__none__'

function NewRun() {
  const search = Route.useSearch()
  const navigate = useNavigate()
  const datasets = useQuery({ queryKey: ['datasets'], queryFn: api.datasets })
  const policies = useQuery({ queryKey: ['policies'], queryFn: api.policies, staleTime: Infinity })
  const flavors = useQuery({ queryKey: ['flavors'], queryFn: api.flavors, staleTime: 3_600_000 })
  const me = useQuery({ queryKey: ['me'], queryFn: api.me, staleTime: Infinity })

  const [chosenDataset, setDatasetId] = useState<string | undefined>(search.dataset)
  const [egoId, setEgoId] = useState<string | null>(search.ego ?? null)
  const [egoMax, setEgoMax] = useState<number | null>(null)
  const [policyId, setPolicyId] = useState('pi05')
  const [cameras, setCameras] = useState<string[]>([])
  const [slotOverrides, setSlotOverrides] = useState<Record<string, string>>({})
  const [steps, setSteps] = useState(10_000)
  const [batch, setBatch] = useState(16)
  const [flavor, setFlavor] = useState('a100-large')
  const [name, setName] = useState('')
  const [nameTouched, setNameTouched] = useState(false)

  const teleopOptions = datasets.data?.filter((d) => d.kind !== 'egocentric') ?? []
  const datasetId = chosenDataset ?? teleopOptions[0]?.repo_id
  const egoOptions = datasets.data?.filter((d) => d.repo_id !== datasetId) ?? []
  const dataset = datasets.data?.find((d) => d.repo_id === datasetId)
  const ego = datasets.data?.find((d) => d.repo_id === egoId)
  const policy = policies.data?.find((p) => p.id === policyId)

  useEffect(() => {
    if (!policy) return
    setSteps(policy.default_steps)
    setBatch(policy.default_batch_size)
    setFlavor(policy.default_flavor)
    setSlotOverrides({})
  }, [policy])

  // Default cameras: RGB ones (shared with the ego dataset when co-training), up to the policy's limit.
  useEffect(() => {
    if (!dataset || !policy) return
    const usable = dataset.cameras.filter((c) => cameraUsable(c, policy, ego?.cameras).ok).map((c) => c.key)
    setCameras(policy.max_cameras ? usable.slice(0, policy.max_cameras) : usable)
  }, [dataset, policy, ego])

  useEffect(() => {
    if (!nameTouched && dataset && policy)
      setName(`${policy.name.replace('π', 'pi')} ${shortRepo(dataset.repo_id)}${ego ? ' + ego' : ''}`.slice(0, 80))
  }, [dataset, policy, ego, nameTouched])

  const cameraMap = policy?.camera_slots.length ? slotMap(policy, cameras, slotOverrides) : null

  const spec: TrainSpec | null =
    datasetId && name
      ? {
          name,
          policy: policyId,
          dataset_repo_id: datasetId,
          ego_repo_id: egoId,
          ego_max_episodes: egoId ? egoMax : null,
          cameras,
          camera_map: cameraMap,
          steps,
          batch_size: batch,
          flavor,
        }
      : null
  const debouncedSpec = useDebounced(spec, 250)
  const plan = useQuery({
    queryKey: ['plan', debouncedSpec],
    queryFn: () => api.plan(debouncedSpec!),
    enabled: !!debouncedSpec,
    placeholderData: (prev) => prev,
  })

  const launch = useMutation({
    mutationFn: () => api.createRun(spec!),
    onSuccess: ({ id }) => navigate({ to: '/training/$runId', params: { runId: id } }),
    onError: (e) => toast.error('Could not launch', { description: e.message }),
  })

  const selectedFlavor = flavors.data?.find((f) => f.name === flavor)
  const canLaunch =
    !!spec && plan.data?.ok && !plan.isFetching && !launch.isPending && (me.data?.token || me.data?.fake_jobs)
  const issues = plan.data?.issues.filter((i) => i.level !== 'info') ?? []

  if (datasets.data && datasets.data.length === 0) {
    return (
      <>
        <PageHeader title="New training run" />
        <PageBody>
          <Alert>
            <AlertTitle>Import a dataset first</AlertTitle>
          </Alert>
        </PageBody>
      </>
    )
  }

  return (
    <>
      <PageHeader title="New training run" />
      <PageBody>
        <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
          <div className="flex min-w-0 flex-col gap-6">
            <Card>
              <CardHeader>
                <CardTitle>Data</CardTitle>
              </CardHeader>
              <CardContent>
                <FieldGroup>
                  <Field>
                    <FieldLabel>Robot dataset</FieldLabel>
                    <Select value={datasetId} onValueChange={setDatasetId}>
                      <SelectTrigger className="w-full">
                        <SelectValue placeholder="Choose a dataset" />
                      </SelectTrigger>
                      <SelectContent position="popper" className="max-h-80">
                        {teleopOptions.map((d) => (
                          <SelectItem key={d.repo_id} value={d.repo_id}>
                            <span className="truncate">{d.repo_id}</span>
                            <span className="text-muted-foreground">
                              {d.total_episodes - d.excluded_episodes} ep
                            </span>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Field>
                  <div className="grid gap-4 sm:grid-cols-[1fr_10rem]">
                    <Field>
                      <FieldLabel>Egocentric dataset</FieldLabel>
                      <Select value={egoId ?? NONE} onValueChange={(v) => setEgoId(v === NONE ? null : v)}>
                        <SelectTrigger className="w-full">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent position="popper" className="max-h-80">
                          <SelectItem value={NONE}>None</SelectItem>
                          {egoOptions.map((d) => (
                            <SelectItem key={d.repo_id} value={d.repo_id}>
                              <span className="truncate">{d.repo_id}</span>
                              <KindBadge kind={d.kind} />
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </Field>
                    <Field>
                      <FieldLabel>Max ego episodes</FieldLabel>
                      <Input
                        type="number"
                        min={1}
                        disabled={!ego}
                        placeholder={ego ? `all (${ego.total_episodes - ego.excluded_episodes})` : '—'}
                        value={egoMax ?? ''}
                        onChange={(e) => setEgoMax(e.target.value ? Math.max(1, Number(e.target.value)) : null)}
                      />
                    </Field>
                  </div>
                  {plan.data && plan.data.frames.ego != null && <MixBar frames={plan.data.frames} />}
                </FieldGroup>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Policy</CardTitle>
              </CardHeader>
              <CardContent>
                <RadioGroup value={policyId} onValueChange={setPolicyId} className="grid gap-3 md:grid-cols-3">
                  {policies.data?.map((p) => (
                    <label
                      key={p.id}
                      className={cn(
                        'flex cursor-pointer flex-col gap-2 rounded-xl border p-4 transition-colors',
                        p.id === policyId ? 'border-chart-1 ring-1 ring-chart-1' : 'hover:bg-muted/50',
                      )}
                    >
                      <div className="flex items-center justify-between">
                        <span className="font-medium">{p.name}</span>
                        <RadioGroupItem value={p.id} />
                      </div>
                      <p className="text-sm text-muted-foreground">{p.summary}</p>
                      <div className="mt-auto flex flex-wrap gap-1 pt-1">
                        <Badge variant="outline">{p.max_cameras ? `≤ ${p.max_cameras} cameras` : 'Any # cameras'}</Badge>
                        <Badge variant="outline">~{p.min_vram_gb} GB</Badge>
                      </div>
                    </label>
                  ))}
                </RadioGroup>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center justify-between">
                  Cameras
                  {policy?.max_cameras && (
                    <span
                      className={cn(
                        'text-sm font-normal tabular-nums',
                        cameras.length > policy.max_cameras ? 'text-destructive' : 'text-muted-foreground',
                      )}
                    >
                      {cameras.length} / {policy.max_cameras}
                    </span>
                  )}
                </CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-2">
                {dataset?.cameras.map((c) => {
                  const usable = policy ? cameraUsable(c, policy, ego?.cameras) : { ok: true }
                  const checked = cameras.includes(c.key)
                  const row = (
                    <div
                      className={cn(
                        'flex items-center gap-3 rounded-lg border px-4 py-2.5',
                        !usable.ok && 'opacity-60',
                        checked && 'bg-muted/40',
                      )}
                    >
                      <Checkbox
                        id={`cam-${c.key}`}
                        checked={checked}
                        disabled={!usable.ok && !checked}
                        onCheckedChange={(on) =>
                          setCameras((cs) => (on ? [...cs, c.key] : cs.filter((k) => k !== c.key)))
                        }
                      />
                      <label htmlFor={`cam-${c.key}`} className="flex min-w-0 flex-1 items-center gap-2 font-medium">
                        {c.depth && <Layers className="size-4 text-chart-4" />}
                        {cameraLabel(c.key)}
                        <span className="text-sm font-normal text-muted-foreground tabular-nums">
                          {c.shape[1]}×{c.shape[0]}
                        </span>
                      </label>
                      {dataset && <CameraFramesDialog repo={dataset.repo_id} camera={c.key} />}
                      {checked && policy && cameraMap && (
                        <Select
                          value={cameraMap[c.key] ?? ''}
                          onValueChange={(slot) => setSlotOverrides((o) => ({ ...o, [c.key]: slot }))}
                        >
                          <SelectTrigger size="sm" className="w-52">
                            <SelectValue placeholder="Input" />
                          </SelectTrigger>
                          <SelectContent position="popper">
                            {policy.camera_slots.map((s) => (
                              <SelectItem key={s.key} value={s.key}>
                                {s.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      )}
                      {c.depth && (
                        <Badge variant="secondary" className="bg-chart-4/12 text-chart-4">
                          Depth
                        </Badge>
                      )}
                    </div>
                  )
                  return usable.ok ? (
                    <div key={c.key}>{row}</div>
                  ) : (
                    <Tooltip key={c.key}>
                      <TooltipTrigger asChild>
                        <div>{row}</div>
                      </TooltipTrigger>
                      <TooltipContent>{usable.reason}</TooltipContent>
                    </Tooltip>
                  )
                })}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Compute</CardTitle>
              </CardHeader>
              <CardContent>
                <FieldGroup>
                  <Field>
                    <FieldLabel>Run name</FieldLabel>
                    <Input
                      value={name}
                      maxLength={80}
                      onChange={(e) => {
                        setName(e.target.value)
                        setNameTouched(true)
                      }}
                    />
                  </Field>
                  <Field>
                    <FieldLabel>Hardware</FieldLabel>
                    <Select value={flavor} onValueChange={setFlavor}>
                      <SelectTrigger className="w-full">
                        <SelectValue placeholder={flavors.isLoading ? 'Loading…' : 'Choose a GPU'} />
                      </SelectTrigger>
                      <SelectContent position="popper" className="max-h-80">
                        {flavors.data
                          ?.filter((f) => !policy || f.vram_gb >= policy.min_vram_gb)
                          .map((f) => (
                            <SelectItem key={f.name} value={f.name}>
                              {f.gpu} {f.vram_gb} GB
                              <span className="text-muted-foreground">${f.cost_per_hour}/h</span>
                            </SelectItem>
                          ))}
                      </SelectContent>
                    </Select>
                  </Field>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field>
                      <FieldLabel>Steps</FieldLabel>
                      <Input
                        type="number"
                        min={100}
                        step={1000}
                        value={steps}
                        onChange={(e) => setSteps(Math.max(100, Number(e.target.value)))}
                      />
                    </Field>
                    <Field>
                      <FieldLabel>Batch size</FieldLabel>
                      <Input
                        type="number"
                        min={1}
                        value={batch}
                        onChange={(e) => setBatch(Math.max(1, Number(e.target.value)))}
                      />
                    </Field>
                  </div>
                </FieldGroup>
              </CardContent>
            </Card>
          </div>

          <div className="flex flex-col gap-4 lg:sticky lg:top-20 lg:self-start">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  Check
                  {plan.isFetching && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
                </CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-4">
                {plan.data && (
                  <>
                    <div className="grid grid-cols-2 gap-3 text-sm">
                      <Metric label="Frames" value={fmtInt(Object.values(plan.data.frames).reduce((a, b) => a + b, 0))} />
                      <Metric label="Epochs" value={plan.data.epochs.toFixed(1)} />
                      <Metric label="GPU" value={selectedFlavor?.gpu ?? flavor} />
                      <Metric label="Price" value={selectedFlavor ? `${fmtUsd(selectedFlavor.cost_per_hour)}/h` : '—'} />
                    </div>
                    {plan.data.estimate && (
                      <div className="rounded-lg border p-3 text-sm">
                        <div className="text-xs text-muted-foreground">Estimated time · cost</div>
                        <div className="font-medium tabular-nums">
                          {fmtDuration(plan.data.estimate.low_s)} – {fmtDuration(plan.data.estimate.high_s)}
                          {plan.data.estimate.high_usd != null && (
                            <span className="text-muted-foreground">
                              {' · '}
                              {fmtUsd(plan.data.estimate.low_usd)} – {fmtUsd(plan.data.estimate.high_usd)}
                            </span>
                          )}
                        </div>
                        <div className="mt-1 text-xs text-muted-foreground">
                          Order of magnitude from LeRobot's hardware guide, ±50%
                          {plan.data.estimate.extrapolated && ' (GPU extrapolated)'}. Includes ~5–10 min of job startup.
                        </div>
                      </div>
                    )}
                    <div className="flex flex-col gap-2">
                      {issues.length === 0 ? (
                        <IssueRow issue={{ level: 'info', message: 'Ready to launch.' }} />
                      ) : (
                        issues
                          .slice()
                          .sort((a, b) => (a.level === 'error' ? -1 : 0) - (b.level === 'error' ? -1 : 0))
                          .map((i) => <IssueRow key={i.message} issue={i} />)
                      )}
                    </div>
                  </>
                )}
                {me.data && !me.data.token && !me.data.fake_jobs && (
                  <Alert variant="destructive">
                    <AlertCircle />
                    <AlertDescription>Set HF_TOKEN in studio/.env to launch jobs.</AlertDescription>
                  </Alert>
                )}
                <Button size="lg" disabled={!canLaunch} onClick={() => launch.mutate()}>
                  {launch.isPending ? <Loader2 className="animate-spin" /> : <Rocket />}
                  Launch training
                </Button>
                {plan.data?.script && (
                  <details className="group text-sm">
                    <summary className="flex cursor-pointer list-none items-center gap-1 text-muted-foreground">
                      <ChevronRight className="size-4 transition-transform group-open:rotate-90" />
                      Job command
                    </summary>
                    <pre className="mt-2 max-h-80 overflow-auto rounded-lg bg-muted p-3 font-mono text-[11px] leading-relaxed">
                      {plan.data.script}
                    </pre>
                  </details>
                )}
              </CardContent>
            </Card>
          </div>
        </div>
      </PageBody>
    </>
  )
}

function IssueRow({ issue }: { issue: Issue }) {
  const Icon = issue.level === 'error' ? AlertCircle : issue.level === 'warning' ? AlertTriangle : Check
  return (
    <div
      className={cn(
        'flex gap-2 rounded-lg px-3 py-2 text-sm',
        issue.level === 'error' && 'bg-destructive/10 text-destructive',
        issue.level === 'warning' && 'bg-chart-3/12',
        issue.level === 'info' && 'bg-chart-2/10 text-chart-2',
      )}
    >
      <Icon className={cn('mt-0.5 size-4 shrink-0', issue.level === 'warning' && 'text-chart-3')} />
      <span className="min-w-0 break-words">{issue.message}</span>
    </div>
  )
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="truncate font-medium tabular-nums">{value}</div>
    </div>
  )
}

function MixBar({ frames }: { frames: Record<string, number> }) {
  const total = (frames.teleop ?? 0) + (frames.ego ?? 0) || 1
  const ego = (100 * (frames.ego ?? 0)) / total
  return (
    <div className="flex flex-col gap-2">
      <div className="flex h-2.5 overflow-hidden rounded-full bg-muted">
        <div className="bg-chart-1" style={{ width: `${100 - ego}%` }} />
        <div className="border-l-2 border-card bg-chart-4" style={{ width: `${ego}%` }} />
      </div>
      <div className="flex justify-between text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <span className="size-2 rounded-full bg-chart-1" /> Robot {(100 - ego).toFixed(0)}%
        </span>
        <span className="flex items-center gap-1.5">
          <span className="size-2 rounded-full bg-chart-4" /> Human {ego.toFixed(0)}%
        </span>
      </div>
    </div>
  )
}

function cameraUsable(c: Camera, policy: Policy, egoCameras?: Camera[]): { ok: boolean; reason?: string } {
  if (c.depth && !policy.supports_depth) return { ok: false, reason: `${policy.name} takes RGB images only.` }
  if (egoCameras && !egoCameras.some((e) => e.key === c.key))
    return { ok: false, reason: 'Not in the egocentric dataset.' }
  return { ok: true }
}

/** Camera -> policy input. Same guess as the backend (left/right wrist, else head), then user overrides. */
function slotMap(policy: Policy, cameras: string[], overrides: Record<string, string>): Record<string, string> {
  const slots = policy.camera_slots.map((s) => s.key)
  const out: Record<string, string> = {}
  for (const cam of cameras) if (overrides[cam] && slots.includes(overrides[cam])) out[cam] = overrides[cam]
  for (const cam of cameras) {
    if (out[cam]) continue
    const name = cam.split('.').pop() ?? cam
    const wanted =
      policy.id === 'pi05' ? (name.includes('left') ? slots[1] : name.includes('right') ? slots[2] : slots[0]) : slots[0]
    const free = [wanted, ...slots].find((s) => !Object.values(out).includes(s))
    if (free) out[cam] = free
  }
  return out
}
