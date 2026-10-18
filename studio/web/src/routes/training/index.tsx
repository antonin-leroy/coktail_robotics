import { useQuery } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { FlaskConical, Plus } from 'lucide-react'
import { useState } from 'react'

import { POLICY_NAMES } from '@/components/charts'
import { PageBody, PageHeader } from '@/components/page'
import { RunStatusBadge, Sparkline } from '@/components/status'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { Progress } from '@/components/ui/progress'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { api, type Run } from '@/lib/api'
import { fmtDuration, fmtInt, fmtNumber, fmtSince, fmtUsd, shortRepo } from '@/lib/format'

export const Route = createFileRoute('/training/')({ component: Runs })

const FILTERS: Record<string, (r: Run) => boolean> = {
  all: () => true,
  active: (r) => ['queued', 'submitting', 'running'].includes(r.status),
  succeeded: (r) => r.status === 'succeeded',
  failed: (r) => r.status === 'failed' || r.status === 'canceled',
}

function Runs() {
  const runs = useQuery({ queryKey: ['runs'], queryFn: api.runs })
  const [filter, setFilter] = useState('all')
  const rows = runs.data?.filter(FILTERS[filter]) ?? []

  return (
    <>
      <PageHeader title="Training runs">
        <Button asChild>
          <Link to="/training/new">
            <Plus /> New run
          </Link>
        </Button>
      </PageHeader>
      <PageBody>
        {runs.data?.length === 0 ? (
          <Empty className="border">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <FlaskConical />
              </EmptyMedia>
              <EmptyTitle>No training runs yet</EmptyTitle>
              <EmptyDescription>Pick a dataset, a policy and the cameras to feed it, then launch on HF Jobs.</EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button asChild>
                <Link to="/training/new">
                  <Plus /> New run
                </Link>
              </Button>
            </EmptyContent>
          </Empty>
        ) : (
          <>
            <Tabs value={filter} onValueChange={setFilter}>
              <TabsList>
                <TabsTrigger value="all">All</TabsTrigger>
                <TabsTrigger value="active">Active</TabsTrigger>
                <TabsTrigger value="succeeded">Succeeded</TabsTrigger>
                <TabsTrigger value="failed">Failed / canceled</TabsTrigger>
              </TabsList>
            </Tabs>
            <Card className="py-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="pl-6">Run</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Progress</TableHead>
                    <TableHead className="text-right">Loss</TableHead>
                    <TableHead>Trend</TableHead>
                    <TableHead className="text-right">Duration</TableHead>
                    <TableHead className="text-right">Cost</TableHead>
                    <TableHead className="pr-6 text-right">Created</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell className="max-w-72 pl-6">
                        <Link
                          to="/training/$runId"
                          params={{ runId: r.id }}
                          className="block truncate font-medium hover:underline"
                        >
                          {r.name}
                        </Link>
                        <div className="truncate text-xs text-muted-foreground">
                          {POLICY_NAMES[r.policy] ?? r.policy} · {shortRepo(r.dataset_repo_id)}
                          {r.ego_repo_id && ` + ${shortRepo(r.ego_repo_id)}`} · {r.flavor}
                        </div>
                      </TableCell>
                      <TableCell>
                        <RunStatusBadge status={r.status} />
                      </TableCell>
                      <TableCell className="w-44">
                        <Progress value={(100 * r.last_step) / r.total_steps} className="h-1.5" />
                        <div className="mt-1 text-xs text-muted-foreground tabular-nums">
                          {fmtInt(r.last_step)} / {fmtInt(r.total_steps)}
                        </div>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{fmtNumber(r.last_values?.loss)}</TableCell>
                      <TableCell>
                        <Sparkline values={r.loss_spark} />
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{fmtDuration(r.duration_s)}</TableCell>
                      <TableCell className="text-right tabular-nums">{fmtUsd(r.cost_usd)}</TableCell>
                      <TableCell className="pr-6 text-right text-muted-foreground">{fmtSince(r.created_at)}</TableCell>
                    </TableRow>
                  ))}
                  {rows.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={8} className="py-10 text-center text-muted-foreground">
                        Nothing here.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </Card>
          </>
        )}
      </PageBody>
    </>
  )
}
