import { useQueries, useQuery } from '@tanstack/react-query'
import { Eye, Loader2, Shuffle } from 'lucide-react'
import { useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { api } from '@/lib/api'
import { cameraLabel } from '@/lib/format'

const SAMPLES = 4

/** Frames of one camera at random moments of random episodes, to check which view it is. */
export function CameraFramesDialog({ repo, camera }: { repo: string; camera: string }) {
  const [open, setOpen] = useState(false)
  const [seed, setSeed] = useState(0)
  const episodes = useQuery({ queryKey: ['episodes', repo], queryFn: () => api.episodes(repo), enabled: open })

  // One random moment (fraction of the episode) per sampled episode; redrawn on shuffle.
  const [picks, setPicks] = useState<{ ep: number; at: number }[]>([])
  const draw = () => {
    const eps = episodes.data ?? []
    const chosen = [...eps].sort(() => Math.random() - 0.5).slice(0, SAMPLES)
    setPicks(chosen.map((e) => ({ ep: e.episode_index, at: 0.1 + Math.random() * 0.8 })))
    setSeed((s) => s + 1)
  }
  useEffect(() => {
    if (open && episodes.data?.length && picks.length === 0) draw()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, episodes.data])

  const streams = useQueries({
    queries: picks.map((p) => ({
      queryKey: ['streams', repo, p.ep],
      queryFn: () => api.streams(repo, p.ep),
    })),
  })

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={`View ${cameraLabel(camera)}`}>
          <Eye />
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-4xl">
        <DialogHeader className="flex-row items-center justify-between pr-8">
          <DialogTitle>{cameraLabel(camera)}</DialogTitle>
          <Button variant="outline" size="sm" onClick={draw} disabled={!episodes.data}>
            <Shuffle /> Shuffle
          </Button>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-3">
          {picks.map((p, i) => {
            const stream = streams[i]?.data?.find((s) => s.key === camera)
            const at = stream ? stream.from_ts + p.at * (stream.to_ts - stream.from_ts) : 0
            return (
              <figure key={`${seed}-${i}`} className="flex flex-col gap-1.5">
                <div className="relative aspect-[4/3] overflow-hidden rounded-lg border bg-black">
                  {stream?.url ? (
                    <video
                      src={stream.url}
                      muted
                      playsInline
                      preload="metadata"
                      className="size-full object-contain"
                      onLoadedMetadata={(e) => (e.currentTarget.currentTime = at)}
                    />
                  ) : (
                    <div className="flex size-full items-center justify-center text-xs text-white/70">
                      <Loader2 className="mr-2 size-4 animate-spin" />
                      {stream ? `Preview ${stream.status}` : 'Loading'}
                    </div>
                  )}
                </div>
                <figcaption className="text-xs text-muted-foreground tabular-nums">
                  Episode {p.ep}
                  {stream && ` · ${(at - stream.from_ts).toFixed(1)} s`}
                </figcaption>
              </figure>
            )
          })}
        </div>
      </DialogContent>
    </Dialog>
  )
}
