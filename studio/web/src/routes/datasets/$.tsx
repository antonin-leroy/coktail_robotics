import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { ExternalLink, FlaskConical, Layers, MoreHorizontal, RefreshCw, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'

import { EpisodePlayer } from '@/components/episode-player'
import { PageBody, PageHeader } from '@/components/page'
import { SignalRows } from '@/components/signal-rows'
import { KIND_LABEL, KindBadge } from '@/components/status'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { api, type DatasetKind } from '@/lib/api'
import { fmtDuration, fmtInt } from '@/lib/format'
import { cn } from '@/lib/utils'

// Splat route: dataset ids can be owner/repo/sub/folder.
export const Route = createFileRoute('/datasets/$')({
  validateSearch: (search: Record<string, unknown>): { ep?: number } => ({ ep: Number(search.ep) || undefined }),
  component: DatasetPage,
})

function DatasetPage() {
  const repo = Route.useParams()._splat ?? ''
  const ep = Route.useSearch().ep ?? 0
  const navigate = useNavigate({ from: Route.fullPath })
  const qc = useQueryClient()

  const dataset = useQuery({ queryKey: ['dataset', repo], queryFn: () => api.dataset(repo) })
  const episodes = useQuery({ queryKey: ['episodes', repo], queryFn: () => api.episodes(repo) })
  const streams = useQuery({
    queryKey: ['streams', repo, ep],
    queryFn: () => api.streams(repo, ep),
    // Previews are built by the worker; SSE invalidates on completion, polling is the fallback.
    refetchInterval: (q) => (q.state.data?.some((s) => s.status === 'pending' || s.status === 'processing') ? 5000 : false),
  })
  const signals = useQuery({ queryKey: ['signals', repo, ep], queryFn: () => api.signals(repo, ep) })
  const keypoints = useQuery({ queryKey: ['keypoints', repo, ep], queryFn: () => api.keypoints(repo, ep) })
  const [showHands, setShowHands] = useState(true)
  const hands = keypoints.data?.available && showHands ? keypoints.data : null

  const [t, setT] = useState(0)
  const [hidden, setHidden] = useState<Set<string>>(new Set())
  useEffect(() => setT(0), [ep])
  const onTime = useCallback((v: number) => setT(v), [])

  const setKind = useMutation({
    mutationFn: (kind: DatasetKind) => api.setDatasetKind(repo, kind),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['dataset', repo] })
      qc.invalidateQueries({ queryKey: ['datasets'] })
    },
  })
  const sync = useMutation({
    mutationFn: () => api.syncDataset(repo),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['dataset', repo] })
      qc.invalidateQueries({ queryKey: ['episodes', repo] })
      toast.success('Synced with the Hub')
    },
    onError: (e) => toast.error('Sync failed', { description: e.message }),
  })
  const remove = useMutation({
    mutationFn: () => api.deleteDataset(repo),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['datasets'] })
      navigate({ to: '/datasets' })
    },
    onError: (e) => toast.error('Cannot remove', { description: e.message }),
  })
  const exclude = useMutation({
    mutationFn: ({ index, excluded }: { index: number; excluded: boolean }) => api.setExcluded(repo, index, excluded),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['episodes', repo] })
      qc.invalidateQueries({ queryKey: ['dataset', repo] })
    },
  })

  const d = dataset.data
  const episode = episodes.data?.find((e) => e.episode_index === ep)
  const duration = episode && d ? episode.length / d.fps : 0
  const task = episode?.tasks[0]
  const included = useMemo(() => episodes.data?.filter((e) => !e.excluded).length ?? 0, [episodes.data])

  return (
    <>
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            <Link to="/datasets" className="text-muted-foreground hover:text-foreground">
              Datasets
            </Link>
            <span className="text-muted-foreground">/</span>
            <span className="truncate">{repo}</span>
          </span>
        }
      >
        {d && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" className="gap-2">
                <KindBadge kind={d.kind} />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel>Dataset kind</DropdownMenuLabel>
              <DropdownMenuRadioGroup value={d.kind} onValueChange={(v) => setKind.mutate(v as DatasetKind)}>
                {(['teleop', 'egocentric', 'sim', 'other'] as const).map((k) => (
                  <DropdownMenuRadioItem key={k} value={k}>
                    {KIND_LABEL[k]}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        <Button asChild>
          <Link to="/training/new" search={d?.kind === 'egocentric' ? { ego: repo } : { dataset: repo }}>
            <FlaskConical /> Train
          </Link>
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="icon" aria-label="More">
              <MoreHorizontal />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem asChild>
              <a href={`https://huggingface.co/datasets/${repo}`} target="_blank" rel="noreferrer">
                <ExternalLink /> Open on the Hub
              </a>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => sync.mutate()}>
              <RefreshCw /> Re-sync metadata
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={() => remove.mutate()}>
              <Trash2 /> Remove from studio
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </PageHeader>

      <PageBody>
        {!d ? (
          <Skeleton className="h-96" />
        ) : (
          <>
            <Card className="gap-0 overflow-hidden py-0">
              <div className="flex flex-wrap items-center gap-x-6 gap-y-1 border-b px-5 py-3 text-sm">
                <span className="min-w-0 truncate">
                  <span className="text-muted-foreground">Task: </span>
                  {task ?? '—'}
                </span>
                <span className="ml-auto font-mono text-xs text-muted-foreground tabular-nums">
                  {[
                    `${fmtInt(d.total_episodes)} episodes`,
                    fmtDuration(d.total_frames / d.fps),
                    `${d.fps} fps`,
                    `${d.cameras.length} cameras`,
                    d.robot_type,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              </div>

              <div className="grid lg:grid-cols-[15rem_1fr]">
                <div className="border-b lg:border-r lg:border-b-0">
                  <div className="border-b px-4 py-2 text-xs text-muted-foreground">
                    {included} of {d.total_episodes} used for training
                  </div>
                  <div className="max-h-72 overflow-y-auto lg:sticky lg:top-16 lg:max-h-[calc(100vh-8rem)]">
                    {episodes.data?.map((e) => (
                      <div
                        key={e.episode_index}
                        className={cn(
                          'flex items-center gap-3 border-b px-4 py-2.5',
                          e.episode_index === ep ? 'bg-accent' : 'hover:bg-muted/60',
                        )}
                      >
                        <Checkbox
                          checked={!e.excluded}
                          aria-label={`Use episode ${e.episode_index} for training`}
                          onCheckedChange={(c) => exclude.mutate({ index: e.episode_index, excluded: !c })}
                        />
                        <button
                          className="min-w-0 flex-1 text-left"
                          onClick={() => navigate({ search: { ep: e.episode_index } })}
                        >
                          <div className={cn('text-sm font-medium', e.excluded && 'text-muted-foreground line-through')}>
                            Episode {e.episode_index}
                          </div>
                          <div className="text-xs text-muted-foreground tabular-nums">
                            {e.duration_s}s · {fmtInt(e.length)} frames
                          </div>
                        </button>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="min-w-0">
                  <div className="flex flex-col gap-3 p-5">
                    {keypoints.data?.available && (
                      <label className="flex items-center gap-2 self-end text-sm">
                        <Switch size="sm" checked={showHands} onCheckedChange={setShowHands} />
                        Hand tracking
                      </label>
                    )}
                    {streams.data && streams.data.length > 3 && (
                      <div className="flex flex-wrap gap-x-5 gap-y-2">
                        {streams.data.map((s) => (
                          <label key={s.key} className="flex items-center gap-2 font-mono text-xs">
                            <Switch
                              size="sm"
                              checked={!hidden.has(s.key)}
                              onCheckedChange={(on) =>
                                setHidden((h) => {
                                  const next = new Set(h)
                                  if (on) next.delete(s.key)
                                  else next.add(s.key)
                                  return next
                                })
                              }
                            />
                            {s.label}
                          </label>
                        ))}
                      </div>
                    )}
                    {streams.data && episode ? (
                      <EpisodePlayer
                        key={`${repo}-${ep}`}
                        streams={streams.data}
                        duration={duration}
                        fps={d.fps}
                        t={t}
                        onTime={onTime}
                        hidden={hidden}
                        hands={hands}
                      />
                    ) : (
                      <Skeleton className="aspect-video" />
                    )}
                  </div>
                  <div className="border-t">
                    {signals.data ? (
                      <SignalRows signals={signals.data} t={t} onSeek={onTime} />
                    ) : (
                      <Skeleton className="m-5 h-64" />
                    )}
                  </div>
                </div>
              </div>
            </Card>

            <div className="grid gap-6 lg:grid-cols-2">
              <Card>
                <CardHeader>
                  <CardTitle>Cameras</CardTitle>
                </CardHeader>
                <CardContent>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Key</TableHead>
                        <TableHead>Type</TableHead>
                        <TableHead>Resolution</TableHead>
                        <TableHead>Encoding</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {d.cameras.map((c) => (
                        <TableRow key={c.key}>
                          <TableCell className="font-mono text-xs">{c.key}</TableCell>
                          <TableCell>
                            {c.depth ? (
                              <Badge variant="secondary" className="bg-chart-4/12 text-chart-4">
                                <Layers /> Depth
                              </Badge>
                            ) : (
                              <Badge variant="secondary">RGB</Badge>
                            )}
                          </TableCell>
                          <TableCell className="tabular-nums">
                            {c.shape[1]}×{c.shape[0]}
                          </TableCell>
                          <TableCell className="font-mono text-xs text-muted-foreground">
                            {c.dtype === 'video' ? `${c.codec ?? '?'} · ${c.pix_fmt ?? '?'}` : `${c.dtype} frames`}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>Features</CardTitle>
                  <CardDescription>
                    {d.tasks.length} task{d.tasks.length === 1 ? '' : 's'} · codebase {d.codebase}
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Key</TableHead>
                        <TableHead>Shape</TableHead>
                        <TableHead>Names</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {d.features
                        ?.filter((f) => !['timestamp', 'frame_index', 'episode_index', 'index', 'task_index'].includes(f.key))
                        .map((f) => (
                          <TableRow key={f.key}>
                            <TableCell className="font-mono text-xs">{f.key}</TableCell>
                            <TableCell className="font-mono text-xs">[{f.shape.join(', ')}]</TableCell>
                            <TableCell className="max-w-72 truncate text-xs text-muted-foreground" title={f.names?.join(', ')}>
                              {f.names?.join(', ') ?? '—'}
                            </TableCell>
                          </TableRow>
                        ))}
                    </TableBody>
                  </Table>
                  <div className="mt-4 flex flex-col gap-1">
                    {d.tasks.slice(0, 5).map((task) => (
                      <div key={task} className="rounded-md bg-muted/60 px-3 py-2 text-sm">
                        {task}
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            </div>
          </>
        )}
      </PageBody>
    </>
  )
}
