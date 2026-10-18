import { useQuery } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { Database, Layers, Plus } from 'lucide-react'

import { ImportDatasetDialog } from '@/components/import-dataset-dialog'
import { PageBody, PageHeader } from '@/components/page'
import { KindBadge } from '@/components/status'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { api } from '@/lib/api'
import { cameraLabel, fmtDuration, fmtInt, fmtSince } from '@/lib/format'

export const Route = createFileRoute('/datasets/')({ component: Datasets })

function Datasets() {
  const datasets = useQuery({ queryKey: ['datasets'], queryFn: api.datasets })

  return (
    <>
      <PageHeader title="Datasets">
        <ImportDatasetDialog>
          <Button>
            <Plus /> Import from Hub
          </Button>
        </ImportDatasetDialog>
      </PageHeader>
      <PageBody>
        {datasets.isLoading ? (
          <Skeleton className="h-64 w-full" />
        ) : datasets.data?.length === 0 ? (
          <Empty className="border">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Database />
              </EmptyMedia>
              <EmptyTitle>No datasets yet</EmptyTitle>
              <EmptyDescription>
                Import the teleop episodes you recorded with the OpenArm (and your egocentric human dataset) from the
                Hugging Face Hub.
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <ImportDatasetDialog>
                <Button>
                  <Plus /> Import from Hub
                </Button>
              </ImportDatasetDialog>
            </EmptyContent>
          </Empty>
        ) : (
          <Card className="py-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-6">Dataset</TableHead>
                  <TableHead>Kind</TableHead>
                  <TableHead className="text-right">Episodes</TableHead>
                  <TableHead className="text-right">Duration</TableHead>
                  <TableHead className="text-right">FPS</TableHead>
                  <TableHead>Cameras</TableHead>
                  <TableHead className="pr-6 text-right">Synced</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {datasets.data?.map((d) => {
                  return (
                    <TableRow key={d.repo_id}>
                      <TableCell className="max-w-80 pl-6">
                        <Link
                          to="/datasets/$"
                          params={{ _splat: d.repo_id }}
                          className="block truncate font-medium hover:underline"
                        >
                          {d.repo_id}
                        </Link>
                        <div className="text-xs text-muted-foreground">{d.robot_type ?? 'unknown robot'}</div>
                      </TableCell>
                      <TableCell>
                        <KindBadge kind={d.kind} />
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {fmtInt(d.total_episodes)}
                        {d.excluded_episodes > 0 && (
                          <div className="text-xs text-muted-foreground">{d.excluded_episodes} excluded</div>
                        )}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{fmtDuration(d.total_frames / d.fps)}</TableCell>
                      <TableCell className="text-right tabular-nums">{d.fps}</TableCell>
                      <TableCell>
                        <div className="flex flex-wrap gap-1">
                          {d.cameras.map((c) => (
                            <Badge key={c.key} variant="outline" className="gap-1 font-normal">
                              {c.depth && <Layers className="size-3 text-chart-4" />}
                              {cameraLabel(c.key)}
                            </Badge>
                          ))}
                        </div>
                      </TableCell>
                      <TableCell className="pr-6 text-right text-muted-foreground">{fmtSince(d.updated_at)}</TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </Card>
        )}
      </PageBody>
    </>
  )
}
