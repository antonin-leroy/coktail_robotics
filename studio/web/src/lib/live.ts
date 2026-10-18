// Postgres NOTIFY -> SSE (/api/events) -> TanStack Query invalidations.
import { useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'

type Event =
  | { type: 'run'; id: string; status: string; last_step: number }
  | { type: 'preview'; repo_id: string; episode_index: number; camera: string; status: string }

export function useLiveUpdates() {
  const qc = useQueryClient()
  useEffect(() => {
    const source = new EventSource('/api/events')
    // Metric events arrive every logged step; refetch at most once a second per run.
    const pending = new Map<string, number>()
    source.onmessage = (msg) => {
      const event = JSON.parse(msg.data) as Event
      if (event.type === 'run') {
        if (pending.has(event.id)) return
        pending.set(
          event.id,
          window.setTimeout(() => {
            pending.delete(event.id)
            qc.invalidateQueries({ queryKey: ['runs'] })
            qc.invalidateQueries({ queryKey: ['run', event.id] })
            if (event.status === 'succeeded') qc.invalidateQueries({ queryKey: ['skills'] })
          }, 1000),
        )
      } else if (event.type === 'preview') {
        qc.invalidateQueries({ queryKey: ['streams', event.repo_id, event.episode_index] })
      }
    }
    return () => {
      source.close()
      pending.forEach((t) => clearTimeout(t))
    }
  }, [qc])
}
