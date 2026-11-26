/* Child process for tests/framePurgePg.test.ts (CHE-9643 P1). It uses the production pool from server/db/index.ts with
 * no test-only listener. The parent kills this process's purge backend before COMMIT; the child must survive,
 * answer `unknown`, and let the probe settle the outcome. */
import { initDb } from '../../server/db/index.ts'
import { purgeTrashedFrame, resolvePurgeOutcome } from '../../server/db/purge.ts'

const [frameId = '', canvasId = '', deletedAt = ''] = process.argv.slice(2)
await initDb()
console.log('READY')
const result = await purgeTrashedFrame({
  frameId,
  canvasId,
  deletedAt: Number(deletedAt),
  stillMayPurge: () => true,
  onCommitRequested: () => {},
})
const probe = await resolvePurgeOutcome(frameId, { lockTimeoutMs: 1000, delaysMs: [20], repeatMs: 20 })
// stay up long enough for a late 'error' event on the dead connection to surface
await new Promise((r) => setTimeout(r, 500))
console.log('RESULT ' + JSON.stringify({ outcome: result.outcome, probe }))
process.exit(0)
