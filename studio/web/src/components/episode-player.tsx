import { useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, Layers, Loader2, Pause, Play, RotateCcw, SkipBack, SkipForward } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Slider } from '@/components/ui/slider'
import { HandOverlay } from '@/components/hand-overlay'
import { api, type Keypoints, type Stream } from '@/lib/api'
import { cn } from '@/lib/utils'

/**
 * Plays every camera of one episode in lockstep. Each video maps the episode time onto its own
 * [from_ts, to_ts] span of a multi-episode mp4. The first video is the clock: while any video
 * is short of data, all of them wait (no forced seek, which would replay from a keyframe), and
 * small drifts are absorbed by nudging the followers' playback rate.
 */
export function EpisodePlayer(props: {
  streams: Stream[]
  duration: number
  fps: number
  t: number
  onTime: (t: number) => void
  hidden: Set<string>
  hands?: Extract<Keypoints, { available: true }> | null
}) {
  const { streams, duration, fps, t, onTime } = props
  const [playing, setPlaying] = useState(false)
  const [buffering, setBuffering] = useState(false)
  const [rate, setRate] = useState(1)
  const videos = useRef(new Map<string, HTMLVideoElement>())
  const clock = useRef(0) // seconds into the episode
  const stalled = useRef(new Set<HTMLVideoElement>()) // between the browser's 'waiting' and 'playing'
  const emitted = useRef<number | null>(null) // last time we reported ourselves
  const report = useCallback(
    (time: number) => {
      emitted.current = time
      onTime(time)
    },
    [onTime],
  )

  const mounted = useCallback(
    () =>
      streams
        .map((s) => ({ s, v: videos.current.get(s.key) }))
        .filter((x): x is { s: Stream; v: HTMLVideoElement } => !!x.v),
    [streams],
  )
  const targetOf = (s: Stream, time: number) => s.from_ts + Math.min(time, s.to_ts - s.from_ts - 1e-3)

  const seekAll = useCallback(
    (time: number) => {
      for (const { s, v } of mounted()) {
        if (v.readyState >= 1) v.currentTime = targetOf(s, time)
      }
    },
    [mounted],
  )

  // Outside seeks (slider, chart click, frame step, new episode). Values we reported ourselves
  // are ignored: they arrive after a render, already behind the videos.
  useEffect(() => {
    if (t === emitted.current) return
    clock.current = t
    seekAll(t)
  }, [t, seekAll])

  useEffect(() => {
    const all = mounted()
    if (!playing) {
      all.forEach(({ v }) => v.pause())
      seekAll(clock.current)
      return
    }
    let frame = 0
    let lastEmit = 0
    let last = performance.now()
    let wasBuffering = false
    const tick = (now: number) => {
      const list = mounted()
      const lead = list[0]
      const waiting = list.some(({ v }) => stalled.current.has(v))
      if (waiting !== wasBuffering) {
        wasBuffering = waiting
        setBuffering(waiting)
      }
      if (waiting) {
        // The starved video keeps playing (so it fetches and fires 'playing'); the others hold.
        list.forEach(({ v }) => !stalled.current.has(v) && v.pause())
      } else if (lead) {
        list.forEach(({ v }) => v.paused && v.play().catch(() => {}))
        clock.current = lead.v.currentTime - lead.s.from_ts
        lead.v.playbackRate = rate
        for (const { s, v } of list.slice(1)) {
          const drift = v.currentTime - targetOf(s, clock.current)
          if (Math.abs(drift) > 0.5) v.currentTime = targetOf(s, clock.current)
          else v.playbackRate = rate * (1 - Math.max(-0.1, Math.min(0.1, drift)))
        }
      } else {
        clock.current += ((now - last) / 1000) * rate // no video yet (previews building)
      }
      last = now
      if (clock.current >= duration - 0.5 / fps) {
        clock.current = duration
        setPlaying(false)
        report(duration)
        return
      }
      if (now - lastEmit > 50) {
        lastEmit = now
        report(clock.current)
      }
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [playing, rate, duration, fps, report, mounted, seekAll])

  const toggle = () => {
    if (!playing && clock.current >= duration - 1e-3) {
      clock.current = 0
      seekAll(0)
      onTime(0)
    }
    setPlaying((p) => !p)
  }
  const step = (frames: number) => {
    setPlaying(false)
    onTime(Math.min(duration, Math.max(0, clock.current + frames / fps)))
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('input, textarea, [role=slider], [role=combobox]')) return
      if (e.code === 'Space') {
        e.preventDefault()
        toggle()
      } else if (e.code === 'ArrowRight') step(e.shiftKey ? fps : 1)
      else if (e.code === 'ArrowLeft') step(e.shiftKey ? -fps : -1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const visible = streams.filter((s) => !props.hidden.has(s.key))
  return (
    <div className="flex flex-col gap-3">
      <div
        className={cn(
          'grid gap-2',
          visible.length <= 1
            ? 'grid-cols-1'
            : visible.length === 2 || visible.length === 4
              ? 'grid-cols-2'
              : 'grid-cols-2 md:grid-cols-3',
        )}
      >
        {visible.map((s) => (
          <CameraView
            key={s.key}
            stream={s}
            onVideo={(v) => (v ? videos.current.set(s.key, v) : videos.current.delete(s.key))}
            onReady={(v) => (v.currentTime = targetOf(s, clock.current))}
            onStall={(v, isStalled) => (isStalled ? stalled.current.add(v) : stalled.current.delete(v))}
            overlay={
              props.hands?.camera === s.key ? { keypoints: props.hands, frame: Math.round(t * fps) } : undefined
            }
          />
        ))}
      </div>

      <div className="flex items-center gap-3">
        <Button size="icon" variant="ghost" onClick={() => step(-1)} aria-label="Previous frame">
          <SkipBack />
        </Button>
        <Button size="icon" onClick={toggle} aria-label={playing ? 'Pause' : 'Play'}>
          {playing ? <Pause /> : <Play />}
        </Button>
        <Button size="icon" variant="ghost" onClick={() => step(1)} aria-label="Next frame">
          <SkipForward />
        </Button>
        <Slider
          className="flex-1"
          min={0}
          max={duration}
          step={1 / fps}
          value={[t]}
          onValueChange={([v]) => {
            setPlaying(false)
            onTime(v)
          }}
        />
        <div className="font-mono text-sm whitespace-nowrap tabular-nums">
          {playing && buffering && <Loader2 className="mr-2 inline size-3.5 animate-spin text-muted-foreground" />}
          {t.toFixed(2)} / {duration.toFixed(2)} s
          <span className="ml-4 text-muted-foreground">
            frame {Math.round(t * fps)} / {Math.round(duration * fps)}
          </span>
        </div>
        <Select value={String(rate)} onValueChange={(v) => setRate(Number(v))}>
          <SelectTrigger size="sm" className="w-20">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {[0.25, 0.5, 1, 2, 4].map((r) => (
              <SelectItem key={r} value={String(r)}>
                {r}×
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  )
}

function CameraView({
  stream,
  onVideo,
  onReady,
  onStall,
  overlay,
}: {
  stream: Stream
  onVideo: (v: HTMLVideoElement | null) => void
  onReady: (v: HTMLVideoElement) => void
  onStall: (v: HTMLVideoElement, stalled: boolean) => void
  overlay?: { keypoints: Extract<Keypoints, { available: true }>; frame: number }
}) {
  const [error, setError] = useState<string | null>(null)
  const qc = useQueryClient()
  const [h, w] = stream.shape
  return (
    <figure className="flex min-w-0 flex-col gap-1.5">
      <figcaption className="flex items-center gap-1.5 truncate font-mono text-sm text-muted-foreground">
        {stream.depth && <Layers className="size-3.5 shrink-0 text-chart-4" />}
        {stream.key}
      </figcaption>
      <div className="relative overflow-hidden rounded-lg border bg-black" style={{ aspectRatio: `${w} / ${h}` }}>
        {stream.status === 'ready' && stream.url ? (
          <video
            ref={onVideo}
            src={stream.url}
            muted
            playsInline
            preload="auto"
            className="size-full object-contain"
            onLoadedMetadata={(e) => onReady(e.currentTarget)}
          onWaiting={(e) => !e.currentTarget.paused && onStall(e.currentTarget, true)}
          onPlaying={(e) => onStall(e.currentTarget, false)}
          onPause={(e) => e.currentTarget.readyState >= 3 && onStall(e.currentTarget, false)}
            onError={() =>
              setError(
                stream.codec === 'av1'
                  ? 'This browser cannot decode AV1 video (use Chrome, Firefox or a recent Safari on Apple silicon M3+).'
                  : 'Video failed to load.',
              )
            }
          />
        ) : stream.status === 'failed' ? (
          <div className="flex size-full flex-col items-center justify-center gap-2 p-4 text-center text-xs text-white/80">
            <AlertTriangle className="size-5 text-chart-5" />
            <span className="line-clamp-3">{stream.error ?? 'Preview failed'}</span>
            <Button
              size="sm"
              variant="secondary"
              onClick={async () => {
                await api.retryPreview(stream.preview_id!)
                qc.invalidateQueries({ queryKey: ['streams'] })
              }}
            >
              <RotateCcw /> Retry
            </Button>
          </div>
        ) : (
          <div className="flex size-full flex-col items-center justify-center gap-2 text-xs text-white/70">
            <Loader2 className="size-5 animate-spin" />
            {stream.depth ? 'Colorizing depth' : 'Transcoding'} ({stream.status})…
          </div>
        )}
        {overlay && stream.status === 'ready' && (
          <HandOverlay keypoints={overlay.keypoints} frame={overlay.frame} width={w} height={h} />
        )}
        {error && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/80 p-4 text-center text-xs text-white/80">
            {error}
          </div>
        )}
      </div>
    </figure>
  )
}
