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

const readable = (json: string) => {
  try {
    return typeof JSON.parse(json) === 'object'
  } catch {
    return false
  }
}

/** G3 accepts the reviewer's result only when the digest they sent is the SHA256 of the JSON they sent (CHE-6854). Anything else is NOT-RUN. */
export function sloplintEntries(inputs: SloplintInput[]): SloplintEntry[] {
  return inputs.map((i) => {
    const updatedAt = typeof i.updated_at === 'number' ? i.updated_at : Date.parse(i.updated_at)
    if (!Number.isFinite(updatedAt)) throw new Error('updated_at must be an ISO timestamp or epoch milliseconds')
    const claimed = (i.sha256 ?? '').toLowerCase()
    const vouched =
      i.result_json !== undefined &&
      claimed === createHash('sha256').update(i.result_json).digest('hex') &&
      readable(i.result_json)
    return { frameId: i.frame_id, updatedAt, toolSha: i.tool_sha, sha256: claimed, status: vouched ? 'ok' : 'NOT-RUN' }
  })
}
