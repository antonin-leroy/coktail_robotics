import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { Download, Heart, Loader2, Lock, Search } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'

import { KIND_LABEL } from '@/components/status'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { useDebounced } from '@/hooks/use-debounced'
import { api, ApiError, type DatasetKind } from '@/lib/api'
import { fmtInt, fmtSince } from '@/lib/format'

export function ImportDatasetDialog({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [kind, setKind] = useState<DatasetKind>('teleop')
  // A repo holding several datasets (e.g. one per task): pick one of them.
  const [subsets, setSubsets] = useState<{ repo: string; items: string[] } | null>(null)
  const q = useDebounced(query.trim())
  const qc = useQueryClient()
  const navigate = useNavigate()

  const results = useQuery({
    queryKey: ['hub', q],
    queryFn: () => api.searchHub(q),
    enabled: open,
    staleTime: 60_000,
  })

  const importDataset = useMutation({
    mutationFn: (repo: string) => api.importDataset(repo, kind),
    onSuccess: (d) => {
      qc.invalidateQueries({ queryKey: ['datasets'] })
      toast.success(`Imported ${d.repo_id}`, { description: `${d.total_episodes} episodes` })
      setOpen(false)
      setSubsets(null)
      navigate({ to: '/datasets/$', params: { _splat: d.repo_id } })
    },
    onError: (e, repo) => {
      const detail = e instanceof ApiError ? (e.detail as { subsets?: string[] } | undefined) : undefined
      if (detail?.subsets?.length) {
        setSubsets({ repo, items: detail.subsets })
        setQuery('')
      } else toast.error('Import failed', { description: e.message })
    },
  })

  const looksLikeRepo = /^[\w.-]+(\/[\w.-]+)+$/.test(query.trim())
  const exact = !subsets && looksLikeRepo && !results.data?.some((r) => r.repo_id === query.trim())
  const shownSubsets = subsets?.items.filter((s) => s.toLowerCase().includes(query.trim().toLowerCase()))

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Import a dataset from the Hub</DialogTitle>
          <DialogDescription>LeRobotDataset v3. Videos stay on the Hub.</DialogDescription>
        </DialogHeader>

        <div className="grid gap-2">
          <Label>Kind</Label>
          <ToggleGroup
            type="single"
            variant="outline"
            value={kind}
            onValueChange={(v) => v && setKind(v as DatasetKind)}
            className="justify-start"
          >
            {(['teleop', 'egocentric', 'sim', 'other'] as const).map((k) => (
              <ToggleGroupItem key={k} value={k} className="px-3">
                {KIND_LABEL[k]}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </div>

        <div className="relative">
          <Search className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            autoFocus
            placeholder={subsets ? `Filter the ${subsets.items.length} datasets` : 'Search LeRobot datasets, or paste owner/name'}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="pl-9"
          />
        </div>

        <div className="h-80 min-w-0 overflow-y-auto rounded-lg border">
          <div className="divide-y">
            {subsets && (
              <div className="flex items-center gap-3 bg-muted/50 px-4 py-2 text-sm">
                <span className="min-w-0 flex-1 truncate">
                  <span className="font-medium">{subsets.repo}</span>
                  <span className="text-muted-foreground"> holds {subsets.items.length} datasets</span>
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setQuery(subsets.repo)
                    setSubsets(null)
                  }}
                >
                  Back
                </Button>
              </div>
            )}
            {shownSubsets?.map((sub) => (
              <Row
                key={sub}
                repo={sub.slice(subsets!.repo.length + 1)}
                meta={null}
                busy={importDataset.isPending && importDataset.variables === sub}
                disabled={importDataset.isPending}
                onImport={() => importDataset.mutate(sub)}
              />
            ))}
            {exact && (
              <Row
                repo={query.trim()}
                meta="Import by id"
                busy={importDataset.isPending && importDataset.variables === query.trim()}
                onImport={() => importDataset.mutate(query.trim())}
                disabled={importDataset.isPending}
              />
            )}
            {!subsets && results.isFetching && !results.data && (
              <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" /> Searching the Hub…
              </div>
            )}
            {!subsets && results.data?.map((r) => (
              <Row
                key={r.repo_id}
                repo={r.repo_id}
                meta={
                  <span className="flex items-center gap-3">
                    <span className="flex items-center gap-1">
                      <Download className="size-3" /> {fmtInt(r.downloads)}
                    </span>
                    <span className="flex items-center gap-1">
                      <Heart className="size-3" /> {fmtInt(r.likes)}
                    </span>
                    <span>{fmtSince(r.last_modified)}</span>
                    {r.private && <Lock className="size-3" />}
                  </span>
                }
                imported={r.imported}
                busy={importDataset.isPending && importDataset.variables === r.repo_id}
                disabled={importDataset.isPending}
                onImport={() => importDataset.mutate(r.repo_id)}
              />
            ))}
            {!subsets && results.data?.length === 0 && !exact && (
              <div className="p-4 text-sm text-muted-foreground">No LeRobot dataset matches “{q}”.</div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function Row(props: {
  repo: string
  meta: React.ReactNode
  imported?: boolean
  busy: boolean
  disabled: boolean
  onImport: () => void
}) {
  return (
    <div className="flex items-center gap-3 px-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium">{props.repo}</div>
        {props.meta && <div className="text-xs text-muted-foreground">{props.meta}</div>}
      </div>
      {props.imported && <Badge variant="secondary">Imported</Badge>}
      <Button size="sm" variant={props.imported ? 'ghost' : 'outline'} disabled={props.disabled} onClick={props.onImport}>
        {props.busy && <Loader2 className="animate-spin" />}
        {props.imported ? 'Re-sync' : 'Import'}
      </Button>
    </div>
  )
}
