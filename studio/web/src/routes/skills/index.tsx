import { useQuery } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { Search, Sparkles } from 'lucide-react'
import { useState } from 'react'

import { POLICY_COLORS, POLICY_NAMES } from '@/components/charts'
import { PageBody, PageHeader } from '@/components/page'
import { StatusDot } from '@/components/status'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { Input } from '@/components/ui/input'
import { useDebounced } from '@/hooks/use-debounced'
import { api } from '@/lib/api'
import { cameraLabel, fmtNumber, fmtSince } from '@/lib/format'

export const Route = createFileRoute('/skills/')({ component: Skills })

function Skills() {
  const [query, setQuery] = useState('')
  const q = useDebounced(query, 250)
  const skills = useQuery({ queryKey: ['skills', q], queryFn: () => api.skills(q), placeholderData: (p) => p })

  return (
    <>
      <PageHeader title="Skills">
        <div className="relative w-72">
          <Search className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input placeholder="Search skills" value={query} onChange={(e) => setQuery(e.target.value)} className="pl-9" />
        </div>
      </PageHeader>
      <PageBody>
        {skills.data?.length === 0 ? (
          <Empty className="border">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Sparkles />
              </EmptyMedia>
              <EmptyTitle>{q ? `No skill matches “${q}”` : 'No skills yet'}</EmptyTitle>
              <EmptyDescription>
                Every training run that succeeds becomes a skill: a model on the Hub with a title, a description and the
                prompt it answers to.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {skills.data?.map((s) => (
              <Link key={s.id} to="/skills/$skillId" params={{ skillId: s.id }} className="group">
                <Card className="h-full transition-colors group-hover:border-foreground/20">
                  <CardHeader>
                    <CardTitle className="text-lg">{s.title}</CardTitle>
                    <CardDescription className="flex items-center gap-2">
                      <StatusDot style={{ background: POLICY_COLORS[s.policy] }} />
                      {POLICY_NAMES[s.policy] ?? s.policy} · {fmtSince(s.created_at)}
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="flex flex-1 flex-col gap-3">
                    <p className="line-clamp-3 text-sm text-muted-foreground">
                      {s.description || 'No description yet.'}
                    </p>
                    {s.task_prompt && (
                      <div className="line-clamp-2 rounded-md bg-muted/60 px-3 py-2 text-sm">“{s.task_prompt}”</div>
                    )}
                  </CardContent>
                  <CardFooter className="flex flex-wrap gap-1">
                    {s.cameras.map((c) => (
                      <Badge key={c} variant="outline">
                        {cameraLabel(c)}
                      </Badge>
                    ))}
                    {s.tags
                      .filter((t) => t !== s.policy)
                      .map((t) => (
                        <Badge key={t} variant="secondary">
                          {t}
                        </Badge>
                      ))}
                    <span className="ml-auto text-xs text-muted-foreground tabular-nums">
                      loss {fmtNumber(s.min_loss)}
                    </span>
                  </CardFooter>
                </Card>
              </Link>
            ))}
          </div>
        )}
      </PageBody>
    </>
  )
}
