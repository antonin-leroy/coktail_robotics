import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { Check, Copy, ExternalLink, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'

import { POLICY_NAMES } from '@/components/charts'
import { PageBody, PageHeader } from '@/components/page'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import { api, type Skill } from '@/lib/api'
import { cameraLabel, fmtDuration, fmtInt, fmtNumber, fmtUsd } from '@/lib/format'

export const Route = createFileRoute('/skills/$skillId')({ component: SkillPage })

function SkillPage() {
  const { skillId } = Route.useParams()
  const qc = useQueryClient()
  const navigate = useNavigate()
  const skill = useQuery({ queryKey: ['skills', 'one', skillId], queryFn: () => api.skill(skillId) })
  const [draft, setDraft] = useState({ title: '', description: '', task_prompt: '', tags: '' })

  useEffect(() => {
    if (skill.data)
      setDraft({
        title: skill.data.title,
        description: skill.data.description,
        task_prompt: skill.data.task_prompt,
        tags: skill.data.tags.join(', '),
      })
  }, [skill.data])

  const save = useMutation({
    mutationFn: () =>
      api.updateSkill(skillId, {
        title: draft.title,
        description: draft.description,
        task_prompt: draft.task_prompt,
        tags: draft.tags
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['skills'] })
      toast.success('Skill saved')
    },
  })
  const remove = useMutation({
    mutationFn: () => api.deleteSkill(skillId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['skills'] })
      navigate({ to: '/skills' })
    },
  })

  const s = skill.data
  const dirty =
    s &&
    (draft.title !== s.title ||
      draft.description !== s.description ||
      draft.task_prompt !== s.task_prompt ||
      draft.tags !== s.tags.join(', '))

  return (
    <>
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            <Link to="/skills" className="text-muted-foreground hover:text-foreground">
              Skills
            </Link>
            <span className="text-muted-foreground">/</span>
            <span className="truncate">{s?.title ?? '…'}</span>
          </span>
        }
      >
        {s && (
          <Button variant="outline" asChild>
            <a href={`https://huggingface.co/${s.model_repo_id}`} target="_blank" rel="noreferrer">
              <ExternalLink /> Model on the Hub
            </a>
          </Button>
        )}
        <Button variant="ghost" size="icon" onClick={() => remove.mutate()} aria-label="Delete skill">
          <Trash2 />
        </Button>
      </PageHeader>
      <PageBody>
        {!s ? (
          <Skeleton className="h-96" />
        ) : (
          <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
            <div className="flex min-w-0 flex-col gap-6">
              <Card>
                <CardHeader>
                  <CardTitle>About this skill</CardTitle>
                  <CardDescription>Searchable from the Skills page (Postgres full-text search).</CardDescription>
                </CardHeader>
                <CardContent>
                  <FieldGroup>
                    <Field>
                      <FieldLabel>Title</FieldLabel>
                      <Input value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
                    </Field>
                    <Field>
                      <FieldLabel>Description</FieldLabel>
                      <Textarea
                        rows={4}
                        placeholder="What it does, the setup it expects (objects, poses), known failure cases…"
                        value={draft.description}
                        onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                      />
                    </Field>
                    <Field>
                      <FieldLabel>Task prompt</FieldLabel>
                      <Input
                        value={draft.task_prompt}
                        onChange={(e) => setDraft({ ...draft, task_prompt: e.target.value })}
                      />
                      <FieldDescription>
                        {s.policy === 'act'
                          ? 'ACT ignores language; kept for documentation.'
                          : 'The instruction the VLA was trained on; pass it as --task at inference.'}
                      </FieldDescription>
                    </Field>
                    <Field>
                      <FieldLabel>Tags</FieldLabel>
                      <Input
                        placeholder="grasp, bottle, handoff"
                        value={draft.tags}
                        onChange={(e) => setDraft({ ...draft, tags: e.target.value })}
                      />
                    </Field>
                    <div>
                      <Button disabled={!dirty || save.isPending} onClick={() => save.mutate()}>
                        Save
                      </Button>
                    </div>
                  </FieldGroup>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>Run it on the OpenArm</CardTitle>
                  <CardDescription>
                    From the Ubuntu VM with both CAN interfaces up. Same cameras, same names as in training. Follow the
                    team's safety rules: a person at the e-stop, torque only on an explicit go.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <CodeBlock code={rolloutCommand(s)} />
                </CardContent>
              </Card>
            </div>

            <div className="flex flex-col gap-4">
              <Card>
                <CardHeader>
                  <CardTitle>Model</CardTitle>
                </CardHeader>
                <CardContent className="grid grid-cols-[minmax(0,1fr)] gap-3 text-sm">
                  <Row label="Policy" value={POLICY_NAMES[s.policy] ?? s.policy} />
                  <Row label="Repo" value={<span className="font-mono text-xs">{s.model_repo_id}</span>} />
                  <Row
                    label="Cameras"
                    value={
                      <span className="flex flex-wrap justify-end gap-1">
                        {s.cameras.map((c) => (
                          <Badge key={c} variant="outline">
                            {cameraLabel(c)}
                          </Badge>
                        ))}
                      </span>
                    }
                  />
                </CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <CardTitle>Training</CardTitle>
                </CardHeader>
                <CardContent className="grid grid-cols-[minmax(0,1fr)] gap-3 text-sm">
                  <Row label="Robot data" value={<span className="font-mono text-xs">{s.dataset_repo_id ?? '—'}</span>} />
                  {s.ego_repo_id && <Row label="Human data" value={<span className="font-mono text-xs">{s.ego_repo_id}</span>} />}
                  <Row label="Steps" value={fmtInt(s.total_steps)} />
                  <Row label="Best loss" value={fmtNumber(s.min_loss)} />
                  <Row label="Duration" value={fmtDuration(s.duration_s)} />
                  <Row label="Cost" value={`${fmtUsd(s.cost_usd)} · ${s.flavor ?? ''}`} />
                  {s.run_id && (
                    <Button variant="outline" size="sm" asChild className="mt-2">
                      <Link to="/training/$runId" params={{ runId: s.run_id }}>
                        Open training run
                      </Link>
                    </Button>
                  )}
                </CardContent>
              </Card>
            </div>
          </div>
        )}
      </PageBody>
    </>
  )
}

function rolloutCommand(s: Skill) {
  const vla = s.policy !== 'act'
  const cams = s.cameras.map(cameraLabel)
  const lines = [
    'lerobot-rollout',
    '--strategy.type=base',
    `--policy.path=${s.model_repo_id}`,
    ...(vla ? ['--inference.type=rtc'] : []),
    '--robot.type=bi_openarm_follower',
    '--robot.left_arm_config.port=can0',
    '--robot.left_arm_config.side=left',
    '--robot.right_arm_config.port=can1',
    '--robot.right_arm_config.side=right',
    `--robot.cameras="{ ${cams.map((c) => `${c}: {...}`).join(', ')} }"`,
    // Same camera -> policy input mapping as in training (π0.5 and SmolVLA have fixed inputs).
    ...(Object.keys(s.camera_map).length ? [`--rename_map='${JSON.stringify(s.camera_map)}'`] : []),
    `--task="${s.task_prompt.replace(/"/g, '\\"')}"`,
    '--duration=60',
  ]
  return lines.join(' \\\n  ')
}

function CodeBlock({ code }: { code: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="relative">
      <pre className="overflow-auto rounded-lg bg-muted p-4 font-mono text-xs leading-relaxed">{code}</pre>
      <Button
        size="icon"
        variant="ghost"
        className="absolute top-2 right-2"
        aria-label="Copy"
        onClick={() => {
          navigator.clipboard.writeText(code)
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        }}
      >
        {copied ? <Check /> : <Copy />}
      </Button>
    </div>
  )
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 truncate text-right">{value}</span>
    </div>
  )
}
