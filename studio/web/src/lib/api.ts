// Typed client for the Skill Studio API (proxied to :8000 by Vite in dev).

export type DatasetKind = 'teleop' | 'egocentric' | 'sim' | 'other'
export type RunStatus = 'queued' | 'submitting' | 'running' | 'succeeded' | 'failed' | 'canceled'

export interface Camera {
  key: string
  dtype: string
  shape: number[]
  depth: boolean
  codec: string | null
  pix_fmt: string | null
}

export interface Dataset {
  repo_id: string
  kind: DatasetKind
  total_episodes: number
  total_frames: number
  fps: number
  robot_type: string | null
  codebase: string
  tasks: string[]
  private: boolean
  revision: string
  updated_at: string
  excluded_episodes: number
  cameras: Camera[]
  features?: { key: string; dtype: string; shape: number[]; names: string[] | null }[]
}

export interface HubDataset {
  repo_id: string
  downloads: number
  likes: number
  private: boolean
  last_modified: string | null
  imported: boolean
}

export interface Episode {
  episode_index: number
  length: number
  tasks: string[]
  excluded: boolean
  duration_s: number
}

export interface Stream {
  key: string
  label: string
  shape: number[]
  depth: boolean
  codec: string | null
  mode: 'direct' | 'preview'
  status: 'pending' | 'processing' | 'ready' | 'failed'
  error?: string | null
  preview_id?: number
  url: string | null
  from_ts: number
  to_ts: number
}

export interface Signals {
  timestamps: number[]
  series: Record<string, { kind: 'vector' | 'pose'; names: string[]; values: number[][] }>
}

/** Arm/hand joints projected into one camera, per frame, in [0, 1] image coordinates. */
export type Keypoints =
  | { available: false }
  | {
      available: true
      camera: string
      joints: string[]
      edges: [number, number, string][]
      frames: ([number, number] | null)[][]
    }

export interface Policy {
  id: string
  name: string
  summary: string
  max_cameras: number | null
  supports_depth: boolean
  uses_language: boolean
  min_vram_gb: number
  default_steps: number
  default_batch_size: number
  default_flavor: string
  camera_slots: { key: string; label: string }[]
}

export interface Flavor {
  name: string
  label: string
  gpu: string
  vram_gb: number
  cost_per_min: number
  cost_per_hour: number
}

export interface TrainSpec {
  name: string
  policy: string
  dataset_repo_id: string
  ego_repo_id: string | null
  ego_max_episodes: number | null
  cameras: string[]
  camera_map: Record<string, string> | null
  steps: number
  batch_size: number
  flavor: string
}

export interface Issue {
  level: 'error' | 'warning' | 'info'
  message: string
}

export interface Plan {
  ok: boolean
  issues: Issue[]
  script: string
  model_repo_id: string
  merged: boolean
  frames: Record<string, number>
  epochs: number
  camera_map: Record<string, string>
  estimate: {
    low_s: number
    high_s: number
    low_usd: number | null
    high_usd: number | null
    extrapolated: boolean
  } | null
  cost_per_min?: number
}

export interface Run {
  id: string
  name: string
  status: RunStatus
  policy: string
  dataset_repo_id: string
  ego_repo_id: string | null
  flavor: string
  total_steps: number
  last_step: number
  model_repo_id: string
  hf_job_id: string | null
  hf_job_url: string | null
  error: string | null
  created_at: string
  started_at: string | null
  finished_at: string | null
  duration_s: number | null
  cost_usd: number | null
  min_loss: number | null
  last_values: Record<string, number> | null
  skill_id: string | null
  cameras: string[] | null
  loss_spark: number[]
  spec?: TrainSpec & { script: string; task: string; frames: Record<string, number>; epochs: number }
}

export interface MetricPoint {
  step: number
  value: number
  smooth: number
}

export interface RunMetrics {
  series: Record<string, MetricPoint[]>
  system: { t: number; cpu_pct?: number; ram_gb?: number; gpu_util?: number; gpu_mem_gb?: number }[]
}

export interface Skill {
  id: string
  slug: string
  title: string
  description: string
  task_prompt: string
  policy: string
  model_repo_id: string
  cameras: string[]
  tags: string[]
  created_at: string
  updated_at: string
  run_id: string | null
  dataset_repo_id: string | null
  ego_repo_id: string | null
  total_steps: number | null
  min_loss: number | null
  duration_s: number | null
  cost_usd: number | null
  flavor: string | null
  camera_map: Record<string, string>
}

export interface Me {
  user: { name: string; fullname: string | null; avatar_url: string | null; orgs: string[] } | null
  token: boolean
  fake_jobs: boolean
  namespace: string | null
}

export class ApiError extends Error {
  status: number
  detail: unknown
  constructor(status: number, message: string, detail?: unknown) {
    super(message)
    this.status = status
    this.detail = detail
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: init?.body ? { 'content-type': 'application/json', ...init.headers } : init?.headers,
  })
  if (!res.ok) {
    let message = res.statusText
    let detail: unknown
    try {
      detail = (await res.json()).detail
      message = Array.isArray(detail)
        ? detail.map((d: unknown) => (typeof d === 'string' ? d : JSON.stringify(d))).join('\n')
        : typeof detail === 'object' && detail && 'message' in detail
          ? String(detail.message)
          : String(detail ?? message)
    } catch {
      /* not JSON */
    }
    throw new ApiError(res.status, message, detail)
  }
  return res.json()
}

const post = <T>(path: string, body?: unknown) =>
  request<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) })
const patch = <T>(path: string, body: unknown) =>
  request<T>(path, { method: 'PATCH', body: JSON.stringify(body) })
const del = <T>(path: string) => request<T>(path, { method: 'DELETE' })

export const api = {
  me: () => request<Me>('/me'),
  flavors: () => request<Flavor[]>('/flavors'),
  policies: () => request<Policy[]>('/policies'),

  searchHub: (q: string, author?: string) =>
    request<HubDataset[]>(`/hub/datasets?q=${encodeURIComponent(q)}${author ? `&author=${encodeURIComponent(author)}` : ''}`),
  datasets: () => request<Dataset[]>('/datasets'),
  dataset: (repo: string) => request<Dataset>(`/datasets/${repo}`),
  importDataset: (repo_id: string, kind: DatasetKind) => post<Dataset>('/datasets', { repo_id, kind }),
  syncDataset: (repo: string) => post<Dataset>(`/datasets/${repo}/sync`),
  setDatasetKind: (repo: string, kind: DatasetKind) => patch<Dataset>(`/datasets/${repo}`, { kind }),
  deleteDataset: (repo: string) => del<{ ok: boolean }>(`/datasets/${repo}`),
  episodes: (repo: string) => request<Episode[]>(`/datasets/${repo}/episodes`),
  setExcluded: (repo: string, index: number, excluded: boolean) =>
    patch<{ ok: boolean }>(`/datasets/${repo}/episodes/${index}`, { excluded }),
  signals: (repo: string, index: number) => request<Signals>(`/datasets/${repo}/episodes/${index}/signals`),
  streams: (repo: string, index: number) => request<Stream[]>(`/datasets/${repo}/episodes/${index}/streams`),
  keypoints: (repo: string, index: number) => request<Keypoints>(`/datasets/${repo}/episodes/${index}/keypoints`),
  retryPreview: (id: number) => post<{ ok: boolean }>(`/media/previews/${id}/retry`),

  plan: (spec: TrainSpec) => post<Plan>('/training/plan', spec),
  createRun: (spec: TrainSpec) => post<{ id: string }>('/training/runs', spec),
  runs: () => request<Run[]>('/training/runs'),
  run: (id: string) => request<Run>(`/training/runs/${id}`),
  runMetrics: (id: string, smoothing: number) =>
    request<RunMetrics>(`/training/runs/${id}/metrics?smoothing=${smoothing}`),
  runLogs: (id: string) => request<{ seq: number; line: string }[]>(`/training/runs/${id}/logs`),
  rerun: (id: string) => post<{ id: string }>(`/training/runs/${id}/rerun`),
  cancelRun: (id: string) => post<{ ok: boolean }>(`/training/runs/${id}/cancel`),
  deleteRun: (id: string) => del<{ ok: boolean }>(`/training/runs/${id}`),

  skills: (q: string) => request<Skill[]>(`/skills?q=${encodeURIComponent(q)}`),
  skill: (id: string) => request<Skill>(`/skills/${id}`),
  updateSkill: (id: string, body: Partial<Pick<Skill, 'title' | 'description' | 'task_prompt' | 'tags'>>) =>
    patch<Skill>(`/skills/${id}`, body),
  deleteSkill: (id: string) => del<{ ok: boolean }>(`/skills/${id}`),
}
