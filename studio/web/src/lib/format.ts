export const fmtInt = (n: number | null | undefined) => (n == null ? '—' : Math.round(n).toLocaleString('en-US'))

export const fmtUsd = (n: number | null | undefined) =>
  n == null ? '—' : `$${n < 10 ? n.toFixed(2) : Math.round(n).toLocaleString('en-US')}`

export function fmtDuration(seconds: number | null | undefined) {
  if (seconds == null) return '—'
  const s = Math.max(0, Math.round(seconds))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

export function fmtSince(iso: string | null | undefined) {
  if (!iso) return '—'
  const s = (Date.now() - new Date(iso).getTime()) / 1000
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

export const fmtNumber = (n: number | null | undefined, digits = 3) =>
  n == null ? '—' : Math.abs(n) < 1e-3 && n !== 0 ? n.toExponential(1) : n.toFixed(digits)

export const shortRepo = (repo: string) => repo.split('/').pop() ?? repo

export const cameraLabel = (key: string) => key.replace(/^observation\.images\./, '')
