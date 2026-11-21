import { createHash } from 'node:crypto'
import type { SloplintEntry } from '../shared/designCompleteness.ts'

/** What a caller sends for one frame: the reviewer's `sloplint --json` output and the SHA256 they computed for it. */
export interface SloplintInput {
  frame_id: string
  updated_at: string | number
  tool_sha: string
  result_json?: string | undefined
  sha256?: string | undefined
}

/**
 * A usable result is a JSON object with a `findings` array and no NOT-RUN marker. `null`, arrays, scalars and
 * `{"status":"NOT-RUN"}` parse as JSON but are not a run of the tool (CHE-6854 review).
 */
const usable = (json: string) => {
  try {
    const v: unknown = JSON.parse(json)
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return false
    const o = v as Record<string, unknown>
    if (typeof o.status === 'string' && o.status.trim().toUpperCase().replace(/_/g, '-') === 'NOT-RUN') return false
    return Array.isArray(o.findings)
  } catch {
    return false
  }
}

/** G3 accepts the reviewer's result only when the digest they sent is the SHA256 of the JSON they sent (CHE-6854). Anything else is NOT-RUN. */
export function sloplintEntries(inputs: SloplintInput[]): SloplintEntry[] {
  return inputs.map((i): SloplintEntry => {
    const updatedAt = typeof i.updated_at === 'number' ? i.updated_at : Date.parse(i.updated_at)
    if (!Number.isFinite(updatedAt)) throw new Error('updated_at must be an ISO timestamp or epoch milliseconds')
    const claimed = (i.sha256 ?? '').toLowerCase()
    const vouched =
      i.result_json !== undefined &&
      claimed === createHash('sha256').update(i.result_json).digest('hex') &&
      usable(i.result_json)
    const base = { frameId: i.frame_id, updatedAt, toolSha: i.tool_sha, sha256: claimed }
    return vouched ? { ...base, status: 'ok', resultJson: i.result_json } : { ...base, status: 'NOT-RUN' }
  })
}
