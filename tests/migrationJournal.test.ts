import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// Drizzle runs every journal entry whose `when` is greater than the newest
// created_at in the database ledger. Rewriting `when` of an applied migration,
// or listing entries out of order, makes it re-run and fail at boot (CHE-2734).
const journal = JSON.parse(
  readFileSync(new URL('../server/db/migrations/meta/_journal.json', import.meta.url), 'utf8'),
) as { entries: { idx: number; when: number; tag: string }[] }

// Applied on the C00 production ledger (max created_at 1793062237684). Never change.
const APPLIED_WHEN: Record<string, number> = {
  '0034_frame_approval': 1792719758584,
  '0035_approval_automations': 1792742861394,
  '0036_canvas_guides': 1792917173712,
  '0037_local_agent_effort': 1793060896296,
  '0038_reasoning_effort': 1793062237684,
}

describe('migration journal', () => {
  it('has strictly increasing `when` in idx order', () => {
    const whens = journal.entries.map((e) => e.when)
    whens.forEach((w, i) => {
      if (i > 0) expect(w, journal.entries[i].tag).toBeGreaterThan(whens[i - 1])
    })
  })

  it('keeps `when` of already-applied migrations unchanged', () => {
    for (const [tag, when] of Object.entries(APPLIED_WHEN)) {
      expect(journal.entries.find((e) => e.tag === tag)?.when, tag).toBe(when)
    }
  })
})
